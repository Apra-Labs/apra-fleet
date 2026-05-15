const fs = require('fs');
const p = 'src/cli/install.ts';
let c = fs.readFileSync(p, 'utf8');
const start = c.indexOf('const requiredPerms = [');
const end = c.indexOf('];', start);
const dol = '$';
const b = '`';
const q = "'";
const lines = [
    "const requiredPerms = [",
    "    ' + q + "mcp__apra-fleet__*" + q + ",",
    "    ' + q + "activate_skill(*)" + q + ",",
    "    ' + q + "tracker_*" + q + ",",
    "    ' + q + "Agent(*)" + q + ",",
    "    ' + b + "Read(" + dol + "{paths.skillsDir.replace(/\\\\/g, " + q + "/" + q + )}/**)" + b + ",",
    "    ' + b + "Read(" + dol + "{paths.fleetSkillsDir.replace(/\\\\/g, " + q + "/" + q + ")}/**)" + b + ",",
    "    ' + b + "Read(" + dol + "{path.join(paths.configDir, " + q + "skills" + q + ").replace(/\\\\\/g, " + q + "/" + q + ")}/**)" + b + ",",
    "  ];"
];
const newContent = lines.join(c.includes('\r\n') ? '\r\n' : '\n');
if (start !== -1 && end !== -1) {
    fs.writeFileSync(p, c.substring(0, start) + newContent + c.substring(end + 2));
    console.log('Fixed');
} else {
    console.log('Failed');
}