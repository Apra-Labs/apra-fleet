import type { LlmProvider } from '../types.js';
import type { ProviderAdapter } from './provider.js';
import { ClaudeProvider } from './claude.js';
import { GeminiProvider } from './gemini.js';
import { CodexProvider } from './codex.js';
import { CopilotProvider } from './copilot.js';
import { AgyProvider } from './agy.js';
import { OpenCodeProvider } from './opencode.js';
import { NoneProvider } from './none.js';

const providers: Record<LlmProvider, ProviderAdapter> = {
  claude: new ClaudeProvider(),
  gemini: new GeminiProvider(),
  codex: new CodexProvider(),
  copilot: new CopilotProvider(),
  agy: new AgyProvider(),
  opencode: new OpenCodeProvider(),
  none: new NoneProvider(),
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
export { AgyProvider } from './agy.js';
export { OpenCodeProvider } from './opencode.js';
export { NoneProvider } from './none.js';
