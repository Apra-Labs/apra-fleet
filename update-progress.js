const fs = require('fs');
const data = JSON.parse(fs.readFileSync('C:/akhil/git/apra-fleet-2/progress.json', 'utf8'));
const t = data.tasks.find(x => x.id === 'V3');
t.status = 'completed';
t.notes = 'Verified all 10 high-risk findings are resolved. npm build and test passed.';
fs.writeFileSync('C:/akhil/git/apra-fleet-2/progress.json', JSON.stringify(data, null, 4));
