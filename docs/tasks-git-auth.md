# Tasks: Git Authentication Tools

## Tool 1: `setup_git_app`

One-time setup tool. User provides GitHub App credentials (app ID, private key path, installation ID). Tool stores them in the fleet config directory and verifies connectivity to GitHub.

### Pre-implementation

- [ ] Add `@octokit/app` dependency (`npm install @octokit/app`)
- [ ] Define `GitHubAppConfig` type in `src/types.ts`:
  ```
  { appId: string; privateKeyPath: string; installationId: number; createdAt: string }
  ```
- [ ] Define `FleetGitConfig` type in `src/types.ts`:
  ```
  { version: string; github?: GitHubAppConfig }
  ```
  (Extensible for future Azure/Bitbucket/GitLab backends)

### Config storage layer (`src/services/git-config.ts`)

- [ ] Create `src/services/git-config.ts` — disk-backed config at `~/.apra-fleet/data/git-config.json`
- [ ] `loadGitConfig(): FleetGitConfig` — reads file, returns empty config if missing
- [ ] `saveGitConfig(config: FleetGitConfig): void` — writes with mode `0o600` + `enforceOwnerOnly`
- [ ] `getGitHubApp(): GitHubAppConfig | undefined` — convenience getter
- [ ] `setGitHubApp(config: GitHubAppConfig): void` — convenience setter

### GitHub App service (`src/services/github-app.ts`)

- [ ] Create `src/services/github-app.ts`
- [ ] `loadPrivateKey(keyPath: string): string` — reads .pem file, validates it starts with `-----BEGIN`
- [ ] `verifyAppConnectivity(appId: string, privateKey: string, installationId: number): Promise<{ ok: boolean; error?: string; appName?: string; orgName?: string }>` — uses `@octokit/app` to authenticate as the app, then calls `GET /app` and `GET /app/installations/{id}` to verify the installation exists and the key works. Returns app name and org name on success for display.

### Tool implementation (`src/tools/setup-git-app.ts`)

- [ ] Create `src/tools/setup-git-app.ts`
- [ ] Zod schema: `{ app_id: z.string(), private_key_path: z.string(), installation_id: z.number() }`
- [ ] Handler steps:
  1. Validate `private_key_path` exists and is readable (fs.accessSync)
  2. Read the .pem file contents, validate format
  3. Copy the .pem file to `~/.apra-fleet/data/github-app.pem`, set mode `0o600`
  4. Call `verifyAppConnectivity()` — fail early if credentials are bad
  5. Store config via `setGitHubApp()` (store the copied pem path, not the original)
  6. Return success message with app name, org, installation ID

### Registration in `src/index.ts`

- [ ] Import schema and handler from `src/tools/setup-git-app.ts`
- [ ] Register tool under `--- Authentication & SSH ---` section, after `setup_ssh_key`
- [ ] Tool name: `setup_git_app`, description: "One-time setup: register a GitHub App for git token minting. Requires a GitHub App ID, private key (.pem) file path, and installation ID. The app must already be created at github.com/organizations/{org}/settings/apps."

### Tests (`tests/setup-git-app.test.ts`)

- [ ] Test: rejects missing .pem file path (file not found)
- [ ] Test: rejects invalid .pem content (not a valid private key)
- [ ] Test: stores config to `git-config.json` with correct fields on success
- [ ] Test: copies .pem to `~/.apra-fleet/data/github-app.pem` with `0o600` permissions
- [ ] Test: returns error message when GitHub API verification fails (mock `@octokit/app`)
- [ ] Test: returns success with app name and org on successful verification
- [ ] Test: overwrites previous config on re-run (idempotent)

### Tests (`tests/git-config.test.ts`)

- [ ] Test: `loadGitConfig` returns empty config when file doesn't exist
- [ ] Test: `saveGitConfig` creates file with `0o600` permissions
- [ ] Test: `setGitHubApp` + `getGitHubApp` round-trip

---

## Tool 2: `provision_git_auth`

Mints a scoped, short-lived GitHub token for a specific agent and deploys the credential. Requires `setup_git_app` to have been run first. Follows the same structure as `provision_auth` (connection check, strategy/os dispatch, credential deployment).

### Agent config extensions

- [ ] Add optional fields to `Agent` type in `src/types.ts`:
  ```
  gitAccess?: 'read' | 'push' | 'admin' | 'issues' | 'full';
  gitRepos?: string[];   // e.g. ["Apra-Labs/ApraPipes"]
  ```
- [ ] Add `git_access` and `git_repos` as optional params to `register_agent` and `update_agent` schemas
- [ ] Store these fields in the registry when provided

### Access level mapping (`src/services/github-app.ts`)

- [ ] `mapAccessLevel(level: string): Record<string, string>` — maps `read|push|admin|issues|full` to GitHub permission objects per the design doc
- [ ] `mintGitToken(installationId: number, privateKey: string, appId: string, repos: string[], permissions: Record<string, string>): Promise<{ token: string; expiresAt: string }>` — uses `@octokit/app` to create an installation access token scoped to specific repos and permissions

### Credential deployment commands (`src/os/os-commands.ts`)

- [ ] Add to `OsCommands` interface:
  - `gitCredentialHelperWrite(host: string, username: string, token: string): string` — writes a credential helper script and configures git to use it
  - `gitCredentialHelperRemove(): string` — removes the helper script and unsets git config
- [ ] Implement in `LinuxCommands` — write `~/.fleet-git-credential` script, `chmod +x`, `git config --global credential.helper`
- [ ] Implement in `MacOSCommands` — inherit from Linux (same commands)
- [ ] Implement in `WindowsCommands` — PowerShell equivalent: write script to `$HOME\.fleet-git-credential.ps1`, set `git config --global credential.helper`

### Tool implementation (`src/tools/provision-git-auth.ts`)

- [ ] Create `src/tools/provision-git-auth.ts`
- [ ] Zod schema:
  ```
  {
    agent_id: z.string(),
    git_access?: z.enum(['read', 'push', 'admin', 'issues', 'full']),
    repos?: z.array(z.string())
  }
  ```
  `git_access` and `repos` override the agent's stored config if provided.
- [ ] Handler steps:
  1. `getAgentOrFail(input.agent_id)` — standard agent lookup
  2. Load GitHub App config via `getGitHubApp()` — fail if not configured (tell user to run `setup_git_app`)
  3. Resolve access level: `input.git_access ?? agent.gitAccess` — fail if neither set
  4. Resolve repos: `input.repos ?? agent.gitRepos` — fail if neither set
  5. `getStrategy(agent)` + `testConnection()` — fail if offline
  6. `mintGitToken()` with resolved scope
  7. Deploy credential via `strategy.execCommand(cmds.gitCredentialHelperWrite(...))`
  8. Verify with `git ls-remote` on one of the target repos
  9. `touchAgent(agent.id)`
  10. Return success message with: agent name, access level, repos, token expiry, masked token prefix

### Registration in `src/index.ts`

- [ ] Import schema and handler from `src/tools/provision-git-auth.ts`
- [ ] Register under `--- Authentication & SSH ---` section, after `setup_git_app`
- [ ] Tool name: `provision_git_auth`, description: "Mint a scoped, short-lived git token for an agent and deploy credentials. Requires setup_git_app to be configured first. Access level and repos can be set per-agent or overridden per call."

### Tests (`tests/provision-git-auth.test.ts`)

- [ ] Test: fails with clear message when GitHub App not configured
- [ ] Test: fails when agent has no `gitAccess` and none provided in input
- [ ] Test: fails when agent has no `gitRepos` and none provided in input
- [ ] Test: input overrides take precedence over agent stored config
- [ ] Test: `mapAccessLevel` returns correct permissions for each level (read, push, admin, issues, full)
- [ ] Test: deploys credential helper to agent via strategy (mock execCommand)
- [ ] Test: returns masked token prefix in output (no full token exposure)
- [ ] Test: skips local agents with informative message (like `provision_auth`)
- [ ] Test: returns error when agent is offline

### Tests for OsCommands (`tests/os-commands.test.ts` — extend existing)

- [ ] Test: `gitCredentialHelperWrite` output for Linux — correct script content and git config command
- [ ] Test: `gitCredentialHelperWrite` output for macOS — same as Linux
- [ ] Test: `gitCredentialHelperWrite` output for Windows — PowerShell script and git config
- [ ] Test: `gitCredentialHelperRemove` for each platform
