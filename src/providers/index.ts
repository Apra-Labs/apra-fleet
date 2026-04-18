import type { LlmProvider } from '../types.js';
import type { ProviderAdapter } from './provider.js';
import { ClaudeProvider } from './claude.js';
import { GeminiProvider } from './gemini.js';
import { CodexProvider } from './codex.js';
import { CopilotProvider } from './copilot.js';

const providers: Record<LlmProvider, ProviderAdapter> = {
  claude: new ClaudeProvider(),
  gemini: new GeminiProvider(),
  codex: new CodexProvider(),
  copilot: new CopilotProvider(),
};

export function getProvider(llmProvider?: LlmProvider | null): ProviderAdapter {
  if (!llmProvider) return providers['claude'];
  const adapter = providers[llmProvider];
  if (!adapter) {
    throw new TypeError(
      `Unknown LLM provider "${llmProvider}". Supported: ${Object.keys(providers).join(', ')}`
    );
  }
  return adapter;
}

export type { ProviderAdapter, PromptOptions, ParsedResponse } from './provider.js';
export { ClaudeProvider } from './claude.js';
export { GeminiProvider } from './gemini.js';
export { CodexProvider } from './codex.js';
export { CopilotProvider } from './copilot.js';
