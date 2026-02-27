export type PromptErrorCategory = 'auth' | 'server' | 'overloaded' | 'unknown';

const patterns: Array<{ category: PromptErrorCategory; re: RegExp }> = [
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
  return `Authentication failed on "${agentName}". Run /login to refresh your credentials, then run provision_auth to deploy them to this agent.`;
}
