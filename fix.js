const fs = require('fs');

const reviewContent = 
# Compression Risk Review

- file: \skills/fleet/SKILL.md\
  - original: \Always use bash syntax — Git Bash is universally available on developer machines. Never use PowerShell or cmd.exe syntax, even on Windows members.\
  - compressed: \- Use bash. Background agent: name tool.\
  - risk: \high\
  - resolution: \ephrase\ (added "NEVER use PowerShell/cmd.exe.")

- file: \skills/pm/cleanup.md\
  - original: \Do not merge — merge is the user's decision.\
  - compressed: \Raise PR (gh pr create), check CI (gh pr checks).\
  - risk: \high\
  - resolution: \ephrase\ (added "Do not merge.")

- file: \skills/pm/doer-reviewer.md\
  - original: \PM never self-reviews.\
  - compressed: \Reviewer reads deliverables + diff.\
  - risk: \high\
  - resolution: \ephrase\ (added "PM never self-reviews.")

- file: \skills/pm/plan-prompt.md\
  - original: \Commit the plan files to the feature branch — NEVER commit to the base branch\
  - compressed: \Commit plan to branch.\
  - risk: \high\
  - resolution: \ephrase\ (added "NEVER commit to base branch.")

- file: \skills/pm/single-pair-sprint.md\
  - original: \Never bypass by running the denied command yourself via execute_command.\
  - compressed: \Denial? compose_permissions with grant.\
  - risk: \high\
  - resolution: \ephrase\ (added "Never bypass by running denied command.")

- file: \skills/fleet/SKILL.md\
  - original: \
ever one file per call\
  - compressed: \Batch ops.\
  - risk: \med\
  - resolution: \keep\

- file: \skills/fleet/onboarding.md\
  - original: \Do not attempt any prompt dispatch until the CLI is confirmed.\
  - compressed: \Fail? update_llm_cli.\
  - risk: \med\
  - resolution: \keep\

- file: \skills/fleet/troubleshooting.md\
  - original: \Never guess by listing the directory.\
  - compressed: \logs/ + jq\
  - risk: \med\
  - resolution: \keep\

- file: \skills/pm/SKILL.md\
  - original: \NEVER read code, diagnose bugs, or suggest fixes\
  - compressed: \1. **No code.** Assign members.\
  - risk: \med\
  - resolution: \keep\

- file: \skills/pm/SKILL.md\
  - original: \
ever delegate to fleet members\ (for gh CLI)
  - compressed: \PM runs directly via Bash.\
  - risk: \med\
  - resolution: \keep\

- file: \skills/pm/single-pair-sprint.md\
  - original: \
ever modify it\ (for planned.json)
  - compressed: \Approved? Save planned.json.\
  - risk: \med\
  - resolution: \keep\
;

fs.writeFileSync('skills/COMPRESSION_REVIEW.md', reviewContent.trim());

function replaceInFile(file, search, replacement) {
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(search, replacement);
    fs.writeFileSync(file, content);
}

replaceInFile('skills/fleet/SKILL.md', '- Use bash. Background agent: name tool.', '- Use bash. NEVER use PowerShell/cmd.exe. Background agent: name tool.');
replaceInFile('skills/pm/cleanup.md', 'Raise PR (gh pr create), check CI (gh pr checks).', 'Raise PR (gh pr create), check CI (gh pr checks). Do not merge.');
replaceInFile('skills/pm/doer-reviewer.md', '3. **PM dispatches Reviewer** at VERIFY. Fresh session (esume=false).', '3. **PM dispatches Reviewer** at VERIFY. Fresh session (esume=false). PM never self-reviews.');
replaceInFile('skills/pm/plan-prompt.md', '3. Commit plan to branch.', '3. Commit plan to branch. NEVER commit to base branch.');
replaceInFile('skills/pm/single-pair-sprint.md', 'Recompose on role switch. Denial? compose_permissions with grant.', 'Recompose on role switch. Denial? compose_permissions with grant. Never bypass by running denied command.');

console.log("Review file created and high risks mitigated.");
