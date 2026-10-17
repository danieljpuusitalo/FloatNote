# Scheduled entrypoint for the FloatNote collector (task FloatNoteCollector, see
# install-task.ps1). Runs the floatnote skill's collect mode headless, then
# reports the run to the app through the drop folder, so a failed or silent run
# shows on the morning pick instead of looking like "nothing new".
#
# Read-only Gmail is enforced by the permission layer, not by the skill's prose:
# --permission-mode dontAsk refuses every tool not in --allowedTools, and the
# only Gmail tools listed are the three reads. Writes are limited to the inbox
# folder by an Edit() rule. No Bash at all, so the skill writes its file as
# .json.tmp and this script renames it. Never --dangerously-skip-permissions.
#
# settings.json disables the plugins for this run: the Telegram plugin polls the
# bot as soon as it starts, and a second poller fights the running bot session.
#
# Absolute paths only: Task Scheduler does not get the interactive PATH.
param([string] $Model = '', [double] $Budget = 2)

$repo = Split-Path (Split-Path $PSScriptRoot)
$data = if ($env:FLOATNOTE_DATA_DIR) { $env:FLOATNOTE_DATA_DIR } else { Join-Path $env:APPDATA 'FloatNote' }
$inbox = Join-Path $data 'inbox'
$logs = Join-Path $data 'collector-logs'
New-Item -ItemType Directory -Force $inbox, $logs | Out-Null

$start = Get-Date
$stamp = $start.ToString('yyyyMMdd-HHmmss')
$id = "sched-$stamp"
$out = Join-Path $logs "collect-$stamp.json"
$err = Join-Path $logs "collect-$stamp.log"
$utf8 = New-Object System.Text.UTF8Encoding $false
function Note($line) { [IO.File]::AppendAllText($err, ("{0:HH:mm:ss} {1}`r`n" -f (Get-Date), $line), $utf8) }

$claude = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
$errors = @()
$cost = $null
$code = 0

if (-not (Test-Path $claude)) {
  $errors += "claude.exe not found at $claude"
  $code = 9009
} else {
  # Permission rules take //c/... paths, forward slashes, the long path name.
  $full = (Resolve-Path $inbox).ProviderPath
  $rule = '//' + $full.Substring(0, 1).ToLower() + ($full.Substring(2) -replace '\\', '/') + '/**'
  # The data dir goes in the prompt: with no shell, the skill cannot read env vars.
  $argv = @('-p', "/floatnote collect scheduled run=$id data=$((Resolve-Path $data).ProviderPath)",
    '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json',
    '--max-budget-usd', "$Budget", '--settings', (Join-Path $PSScriptRoot 'settings.json'),
    '--allowedTools', 'Read', 'Glob', 'Grep', "Edit($rule)",
    'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Gmail__get_message')
  if ($Model) { $argv += @('--model', $Model) }
  Note "run $id, data dir $data"

  Push-Location $data
  # 2> in PowerShell 5.1 writes UTF-16; split the merged stream here instead.
  $all = $null | & $claude @argv 2>&1   # closed stdin: no 3 s wait for piped input
  $code = $LASTEXITCODE
  $stdout = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] })
  $all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { Note "stderr: $_" }
  Pop-Location
  [IO.File]::WriteAllText($out, ($stdout -join "`n"), $utf8)
  Note "claude exited $code"

  $res = $null
  try { $res = ($stdout -join "`n") | ConvertFrom-Json } catch { }
  if ($res) {
    $cost = $res.total_cost_usd
    if ($res.is_error) {
      $why = if ($res.result) { "$($res.result)" } else { "$($res.subtype)" }
      $errors += 'run failed: ' + ($why -replace '\s+', ' ').Trim()
    }
  } elseif ($code -ne 0) {
    $errors += "claude exited $code with no result"
  }

  # Hand the skill's findings to the app: .tmp to .json, the app's own signal.
  $found = @(Get-ChildItem $inbox -Filter "$id-*.json.tmp" -ErrorAction SilentlyContinue)
  foreach ($f in $found) { Move-Item $f.FullName ($f.FullName -replace '\.tmp$', '') -Force }
  Note ("findings files: {0}" -f $found.Count)
  if (-not $found.Count -and -not $errors.Count) {
    $why = if ($res -and $res.result) { ($res.result -replace '\s+', ' ').Trim() } else { 'no result' }
    $errors += "wrote no findings: $why"
  }
}

# The scheduler's half of the run report. Same id as the skill's, so the app
# merges the two: cost and errors from here, findings from the skill.
$run = [ordered]@{ id = $id; at = [long]($start.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds; scheduled = $true }
if ($cost -ne $null) { $run.costUsd = [double]$cost }
if ($errors.Count) { $run.errors = @($errors | ForEach-Object { if ($_.Length -gt 200) { $_.Substring(0, 200) } else { $_ } }) }
$json = ConvertTo-Json @{ run = $run } -Depth 4 -Compress
$tmp = Join-Path $inbox "$id-zz-sched.json.tmp"
[IO.File]::WriteAllText($tmp, $json, $utf8)
Move-Item $tmp ($tmp -replace '\.tmp$', '') -Force
Note "reported: $json"

# Keep 30 days of logs.
Get-ChildItem $logs -Filter 'collect-*' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Force
exit $code
