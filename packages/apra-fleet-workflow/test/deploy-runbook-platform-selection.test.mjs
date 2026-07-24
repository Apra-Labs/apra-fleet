import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';

// Regression coverage for apra-fleet-eft.15 (Deploy phase cannot run on
// darwin-x64 members: no matching installer artifact) and its fix in
// apra-fleet-eft.15.1 (architecture-aware build-from-source fallback in
// deploy.md's ## Deploy section). deploy.md is a runbook, not source code, so
// its true end-to-end behavior can only be verified on a real Darwin x86_64
// host. Instead, this suite extracts the Deploy section's bash block from
// the repo-root deploy.md and executes it (with `uname` PATH-shadowed via a
// shell function, and other externally-effectful commands stubbed) so the
// OS+arch selection / fallback LOGIC is exercised for real on any CI
// platform. This must fail if the darwin-x64 source-build fallback branch
// is ever removed from deploy.md, or if a command in that branch loses its
// Permissions-section coverage.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const deployMdPath = path.join(repoRoot, 'deploy.md');
const deployMdText = fs.readFileSync(deployMdPath, 'utf8');

// Extract the Permissions section's `Bash(...)` prefixes.
function extractPermissionPrefixes(text) {
    const section = text.split('## Prerequisites')[0];
    const prefixes = [];
    const re = /`Bash\(([^)]*)\)`/g;
    let m;
    while ((m = re.exec(section)) !== null) {
        prefixes.push(m[1]);
    }
    return prefixes;
}

// Extract the first ```bash ... ``` fenced block that appears under the
// "## Deploy" heading (before the next "## " heading), i.e. the automated
// deploy script deploy.md documents.
function extractDeployBlock(text) {
    const deployIdx = text.indexOf('## Deploy');
    assert.ok(deployIdx !== -1, 'deploy.md must contain a "## Deploy" section');
    const nextHeadingIdx = text.indexOf('\n## ', deployIdx + '## Deploy'.length);
    const section = nextHeadingIdx === -1 ? text.slice(deployIdx) : text.slice(deployIdx, nextHeadingIdx);
    const fenceMatch = section.match(/```bash\n([\s\S]*?)\n```/);
    assert.ok(fenceMatch, 'the "## Deploy" section must contain a ```bash fenced block');
    return fenceMatch[1];
}

const permissionPrefixes = extractPermissionPrefixes(deployMdText);
const deployBlock = extractDeployBlock(deployMdText);

// Only the OS+arch selection logic (the case statements that set ARTIFACT /
// FALLBACK_BUILD), truncated before the if/else block that actually invokes
// npm/gh/the installer. This lets cases 1-3 observe pure selection behavior
// without needing to stub every side-effecting command.
function extractSelectionOnly(block) {
    const ifIdx = block.indexOf('if [ "$FALLBACK_BUILD"');
    assert.ok(ifIdx !== -1, 'deploy block must contain the FALLBACK_BUILD if-statement');
    return block.slice(0, ifIdx);
}

const selectionBlock = extractSelectionOnly(deployBlock);

// Runs `script` under bash with `uname -s`/`uname -m` PATH-shadowed by a
// function returning the given stub values, so the case-statement selection
// logic executes for real against a simulated platform.
function runSelectionFor(unameS, unameM) {
    const script = `
set -u
uname() {
  case "$1" in
    -s) echo "${unameS}" ;;
    -m) echo "${unameM}" ;;
  esac
}
${selectionBlock}
echo "RESULT_ARTIFACT=${'${ARTIFACT:-}'}"
echo "RESULT_FALLBACK=${'${FALLBACK_BUILD:-}'}"
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `selection script exited nonzero: ${result.stderr}`);
    const artifactMatch = result.stdout.match(/RESULT_ARTIFACT=(.*)/);
    const fallbackMatch = result.stdout.match(/RESULT_FALLBACK=(.*)/);
    return {
        artifact: artifactMatch ? artifactMatch[1].trim() : '',
        fallback: fallbackMatch ? fallbackMatch[1].trim() : ''
    };
}

describe('deploy.md Deploy-section platform+arch selection (apra-fleet-eft.15.2)', () => {
    test('Darwin + arm64 resolves to the prebuilt darwin-arm64 artifact', () => {
        const { artifact, fallback } = runSelectionFor('Darwin', 'arm64');
        assert.strictEqual(artifact, 'apra-fleet-installer-darwin-arm64');
        assert.strictEqual(fallback, 'false');
    });

    test('Linux + x86_64 resolves to the prebuilt linux-x64 artifact', () => {
        const { artifact, fallback } = runSelectionFor('Linux', 'x86_64');
        assert.strictEqual(artifact, 'apra-fleet-installer-linux-x64');
        assert.strictEqual(fallback, 'false');
    });

    test('Windows (any non-Darwin/Linux uname -s) resolves to the win-x64 artifact', () => {
        const { artifact, fallback } = runSelectionFor('MINGW64_NT-10.0', 'x86_64');
        assert.strictEqual(artifact, 'apra-fleet-installer-win-x64.exe');
        assert.strictEqual(fallback, 'false');
    });

    test('Darwin + x86_64 does NOT select a darwin-x64 download artifact and takes the source-build fallback', () => {
        const { artifact, fallback } = runSelectionFor('Darwin', 'x86_64');
        // No prebuilt darwin-x64 artifact exists; ARTIFACT must stay unset
        // (never e.g. "apra-fleet-installer-darwin-x64") and FALLBACK_BUILD
        // must flip to true.
        assert.strictEqual(artifact, '');
        assert.strictEqual(fallback, 'true');
    });

    test('the darwin-x64 fallback branch actually builds from source and never invokes gh download', () => {
        // Execute the FULL deploy block (selection + if/else action), with
        // uname stubbed to Darwin/x86_64 and every externally-effectful
        // command (npm, gh, chmod, mkdir, rm) shadowed by a logging shell
        // function, so we can observe which branch really ran without doing
        // a real build/download/install.
        const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-md-fallback-'));
        const logPath = path.join(workDir, 'calls.log');
        const script = `
set -u
uname() {
  case "$1" in
    -s) echo "Darwin" ;;
    -m) echo "x86_64" ;;
  esac
}
npm() { echo "npm $*" >> "${logPath}"; }
gh() { echo "gh $*" >> "${logPath}"; }
chmod() { echo "chmod $*" >> "${logPath}"; }
mkdir() { echo "mkdir $*" >> "${logPath}"; }
rm() { echo "rm $*" >> "${logPath}"; }
${deployBlock}
`;
        const result = spawnSync('bash', ['-c', script], { cwd: workDir, encoding: 'utf8' });
        const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
        fs.rmSync(workDir, { recursive: true, force: true });

        // Fallback branch ran: npm ci / build / build:binary were invoked.
        assert.match(log, /npm ci/, 'fallback branch must run npm ci');
        assert.match(log, /npm run build\b/, 'fallback branch must run npm run build');
        assert.match(log, /npm run build:binary/, 'fallback branch must run npm run build:binary');

        // No attempt was made to download a (nonexistent) darwin-x64
        // artifact from CI.
        assert.doesNotMatch(log, /gh /, 'fallback branch must never call gh (no darwin-x64 CI artifact exists)');

        // The final invocation targets the built installer path, not a
        // downloaded /tmp/fleet-deploy artifact. bash reports this as
        // "command not found" (exit 127) in this sandbox since no real
        // binary was built, which itself confirms the correct path was
        // attempted and nothing upstream (npm/gh) aborted the script first.
        assert.match(
            result.stderr || '',
            /dist\/apra-fleet-installer-darwin-x64/,
            'fallback branch must attempt to run dist/apra-fleet-installer-darwin-x64'
        );
    });

    test('every command invoked by the darwin-x64 fallback branch has a matching Permissions prefix', () => {
        const ifIdx = deployBlock.indexOf('if [ "$FALLBACK_BUILD"');
        const elseIdx = deployBlock.indexOf('\nelse\n', ifIdx);
        const fallbackBranch = deployBlock.slice(ifIdx, elseIdx === -1 ? undefined : elseIdx);

        const requiredCommandsToPrefixes = [
            { command: 'npm ci', prefix: 'npm ci' },
            { command: 'npm run build', prefix: 'npm run build' },
            { command: 'npm run build:binary', prefix: 'npm run build:binary' },
            { command: '"$BUILT_INSTALLER" install --force', prefix: 'dist/apra-fleet-installer-* install *' }
        ];

        for (const { command, prefix } of requiredCommandsToPrefixes) {
            assert.ok(
                fallbackBranch.includes(command),
                `expected fallback branch to still contain "${command}" (deploy.md may have changed)`
            );
            assert.ok(
                permissionPrefixes.includes(prefix),
                `Permissions section must list a "Bash(${prefix})" prefix covering "${command}"`
            );
        }

        // NOTE deliberately NOT cross-checked: .claude/settings.json's
        // permissions.allow. That file is gitignored and machine-local (it
        // gates execution on the machine the runbook actually runs on), so
        // asserting its contents from a repo test made the suite pass or
        // fail depending on which checkout ran it -- green on the deploy
        // member and on bare CI runners (file absent), red on any other dev
        // clone. The repo-portable contract is deploy.md's own Permissions
        // section, asserted above; provisioning the member's settings to
        // match it is an operational step, not a repo invariant.
    });
});
