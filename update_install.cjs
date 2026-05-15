const fs = require('fs');
const p = 'src/cli/install.ts';
let c = fs.readFileSync(p, 'utf8');

const oldText = "'mpc__apra-fleet__*',\r\n    'Agent(*)',";
const ordOldText = "'mpc__apra-fleet__*',\n    'Agent(*)',";

const newText = "'mcp__apra-fleet__*',\n    'activate_skill(*)',\n    'tracker_*',\n    'Agent(*)',";

if (c.includes(oldText)) {
    c = c.replace(oldText, newText);
    fs.writeFileSync(p, c);
    console.log('Updated install.ts (CRLF)');
} else if (c.includes(ordOldText)) {
    c = c.replace(ordOldText, newText);
    fs.writeFileSync(p, c);
    console.log('Updated install.ts (LF)');
} else {
    console.log('Match failed');
}
