// Creates a desktop shortcut using Windows Script Host
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const desktop = path.join(os.homedir(), 'Desktop');
const target = path.join(__dirname, 'launch.vbs');
const shortcutPath = path.join(desktop, 'FloatNote.lnk');
const workingDir = __dirname;

const vbsScript = `
Set ws = CreateObject("WScript.Shell")
Set shortcut = ws.CreateShortcut("${shortcutPath.replace(/\\/g, '\\\\')}")
shortcut.TargetPath = "wscript.exe"
shortcut.Arguments = """${target.replace(/\\/g, '\\\\')}"""
shortcut.WorkingDirectory = "${workingDir.replace(/\\/g, '\\\\')}"
shortcut.WindowStyle = 1
shortcut.Description = "FloatNote - Floating Notepad"
shortcut.Save
`;

const vbsPath = path.join(os.tmpdir(), 'create_shortcut.vbs');
require('fs').writeFileSync(vbsPath, vbsScript);
execSync(`cscript //nologo "${vbsPath}"`);
require('fs').unlinkSync(vbsPath);
console.log('Desktop shortcut created: ' + shortcutPath);
