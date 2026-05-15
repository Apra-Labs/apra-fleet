const fs = require('fs');
const p = 'src/cli/install.ts';
let c = fs.readFileSync(p, 'utf8');

const startMarker = 'const requiredPerms = [';
const endMarker = '];';

const startIdx = c.indexOf(startMarker);
const endIdx = c.indexOf(endMarker, startIdx);

const newArr = `const requiredPerms = [\r\n    'mcp__apra-fleet__*',\r\n    'activate_skill(*)',\r\n    'tracker_*',\r\n    'Agent(*)',\r\n    `Read(${paths.skillsDir.replace(/\\\\\/g, '/')}/**)`,\r\n    `Read(${paths.fleetSkillsDir.replace(/\\\\\/g, '/')}/**)`,\r\n    `Read(${path.join(paths.configDir, 'skills').replace(/\\\\\/g, '/')}/**)`,\r\n  ];`;

if (startIdx !== -1 && endIdx !== -1) {
    c = c.substring(0, startIdx) + newArr + c.substring(endIdx + 2);
    fs.writeFileSync(p, c);
    console.log('Fixed and updated install.ts');
} else {
    console.log('Markers not found', startIdx, endIdx);
}
