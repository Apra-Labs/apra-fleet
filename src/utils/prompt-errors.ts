export type PromptErrorCategory = 'auth' | 'server' | 'overloaded' | 'max_turns' | 'workspace_not_trusted' | 'unknown';

const patterns: Array<{ category: PromptErrorCategory; re: RegExp }> = [
  // apra-fleet-eft.40.3: Claude drops project-scoped permissions.allow entries when the
  // work folder's workspace has never been trusted (projects[].hasTrustDialogAccepted
  // unset in the member-side ~/.claude.json) -- the CLI's own stderr names this exact
  // phrase. Must be checked before the generic categories below so this specific,
  // actionable signature is not swallowed by a broader pattern. Remediation: seed trust
  // via ensureWorkspaceTrusted(workFolder) (apra-fleet-eft.40.1/40.2).
  { category: 'workspace_not_trusted', re: /this workspace has not been trusted/i },
  { category: 'auth', re: /not logged in|unauthorized|\b401\b|authentication_error|expired.*token|permission_error/i },
  { category: 'server', re: /\b500\b|\b502\b|\b503\b|internal server error|api_error/i },
  { category: 'overloaded', re: /\b429\b|\b529\b|overloaded|rate limit/i },
];

export function classifyPromptError(output: string): PromptErrorCategory {
  return patterns.find(p => p.re.test(output))?.category ?? 'unknown';
}

export function isRetryable(category: PromptErrorCategory): boolean {
  return category === 'server' || category === 'overloaded';
}

export function authErrorAdvice(agentName: string): string {
  return `Authentication failed on "${agentName}". Run /login to refresh your credentials, then run provision_llm_auth to deploy them to this agent.`;
}

export function workspaceNotTrustedAdvice(agentName: string): string {
  return `Workspace not trusted on "${agentName}": Claude ignored the composed permissions.allow entries because this work folder has never been trusted (projects[].hasTrustDialogAccepted is unset in the member-side ~/.claude.json). Remediation: seed trust via ensureWorkspaceTrusted(workFolder) -- re-run compose_permissions once apra-fleet-eft.40.2 wires it in, or set projects['<work_folder>'].hasTrustDialogAccepted=true in the member's ~/.claude.json directly.`;
}
