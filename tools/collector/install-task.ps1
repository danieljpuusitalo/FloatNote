# Registers the FloatNote collector (task FloatNoteCollector): weekdays at 07:15,
# before the morning pick. Read the trigger back afterwards, never trust this
# script's success message.
#
# Windowless via ~/.claude/ops/bin/hidden.exe, which also passes the exit code
# through (conhost --headless records every exit as 0). StartWhenAvailable runs a
# slot missed while the laptop slept as soon as it wakes.
param([string] $At = '07:15', [switch] $Remove)

if ($Remove) {
  Unregister-ScheduledTask -TaskName 'FloatNoteCollector' -Confirm:$false
  return
}

$run = Join-Path $PSScriptRoot 'run.ps1'
$bin = Join-Path $env:USERPROFILE '.claude\ops\bin'
$hidden = Join-Path $bin 'hidden.exe'
if (-not (Test-Path $hidden)) { & (Join-Path $bin 'build-hidden.ps1') | Out-Null }
if (-not (Test-Path $hidden)) { throw "hidden.exe missing and could not be built: $hidden" }

$action = New-ScheduledTaskAction -Execute $hidden `
  -Argument "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$run`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'FloatNoteCollector' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Get-ScheduledTask -TaskName 'FloatNoteCollector' | Select-Object TaskName, State,
  @{n='Exe';e={$_.Actions[0].Execute}}, @{n='Args';e={$_.Actions[0].Arguments}},
  @{n='At';e={$_.Triggers[0].StartBoundary}}, @{n='Days';e={$_.Triggers[0].DaysOfWeek}}
