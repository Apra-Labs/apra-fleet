const fs = require('fs');
const p = 'src/cli/install.ts';
let c = fs.readFileSync(p, 'utf8');
const startIdx = c.indexOf('const requiredPerms = [');
const endIdx = c.indexOf('];', startIdx);
const q = String.fromCharCode(39);
const b = String.fromCharCode(96);
const dol = String.fromCharCode(36);
const lines = [
    'const requiredPerms = [',
    '    ' + q + 'mcp__apra-fleet__*' + q + ',',
    '    ' + q + 'activate_skill(*)' + q + ',',
    '    ' + q + 'tracker_*' + q + ',',
    '    ' + q + 'Agent(*)' + q + ',',
    '    ' + b + 'Read(' + dol + '{paths.skillsDir.replace(/\\\\/g, ' + q + '/' + q + )}/**)' + b + ',',
    '    ' + b + 'Read(' + dol + '{paths.fleetSkillsDir.replace(/\\\\/g, ' + q + '/' + q + )}/**)' + b + ',',
    '    ' + b + 'Read(' + dol + '{path.join(paths.configDir, ' + q + 'skills' + q + ').replace(/\\\\/g, ' + q + '/' + q + )}/**)' + b + ',',
    '  ];'
];
if (startIdx !== -1 && endIdx !== -1) {
    c = c.substring(0, startIdx) + lines.join('\r\n') + c.substring(endIdx + 2);
    fs.writeFileSync(p, c);��ۜ��K���	њ^Y	�NH[�H�ۜ��K���	јZ[Y	�NB