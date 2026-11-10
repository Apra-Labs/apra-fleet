// `apra-fleet kb embedding [none | <built-in model name>]`
//
// Shows or sets the embedding model KB semantic search uses (embedding.model
// in the KB config). "none" turns semantic search off; keyword and anchor
// search keep serving. This verb exists because the developer KB tool profile
// hides kb_setup, whose embedding_model input does the same (and also takes a
// custom-model object). A running fleet server notices the changed config on
// its next KB search and switches models without a restart (getEmbedder in
// src/services/knowledge/embedding/embedder.ts).

import {
  readKbConfigForMerge,
  KB_CONFIG_PATH,
  KB_CONFIG_HAND_FIX,
  KbConfigUnreadableError,
} from '../services/knowledge/kb-config.js';
import { BUILTIN_EMBEDDING_PROFILES, DEFAULT_EMBEDDING_PROFILE } from '../services/knowledge/embedding/profiles.js';
import { checkEmbeddingModel, writeKbEmbeddingModel } from '../tools/kb-setup.js';

const NAMES = ['none', ...Object.keys(BUILTIN_EMBEDDING_PROFILES)];

export const KB_EMBEDDING_USAGE =
  `Usage: apra-fleet kb embedding [${NAMES.join(' | ')}]`;

interface Io {
  log: (msg: string) => void;
  error: (msg: string) => void;
}

const defaultIo: Io = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/** The configured embedding.model, described for a person. Throws KbConfigUnreadableError. */
export function describeConfiguredEmbeddingModel(): string {
  const config = readKbConfigForMerge();
  const embedding = config.embedding;
  const raw = embedding !== null && typeof embedding === 'object' && !Array.isArray(embedding)
    ? (embedding as { model?: unknown }).model
    : undefined;
  if (raw === undefined) return `${DEFAULT_EMBEDDING_PROFILE} (default, not set in the KB config)`;
  let shown: string;
  if (raw === 'none') shown = 'none (semantic search off; keyword and anchor search serve)';
  else if (typeof raw === 'string') shown = raw;
  else shown = `custom model ${JSON.stringify(raw)}`;
  try {
    checkEmbeddingModel(raw);
  } catch (err) {
    return `${shown} -- ${(err as Error).message}; the server uses the default ${DEFAULT_EMBEDDING_PROFILE}`;
  }
  return shown;
}

/** Run the verb; resolves to the process exit code. */
export async function runKbEmbedding(args: string[], io: Io = defaultIo): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    io.log(KB_EMBEDDING_USAGE);
    return 0;
  }
  if (args.length > 1) {
    io.error(`Error: expected at most one model name, got ${args.length} arguments`);
    io.error(KB_EMBEDDING_USAGE);
    return 1;
  }

  let before: string;
  try {
    before = describeConfiguredEmbeddingModel();
  } catch (err) {
    if (!(err instanceof KbConfigUnreadableError)) throw err;
    io.error(`Error: ${err.message}${args.length > 0 ? '; nothing was written.' : ''}`);
    io.error(KB_CONFIG_HAND_FIX);
    return 1;
  }

  if (args.length === 0) {
    io.log(`KB embedding model: ${before}`);
    return 0;
  }

  const name = args[0];
  if (!NAMES.includes(name)) {
    io.error(`Error: unknown embedding model "${name}"; nothing was written. Valid: ${NAMES.join(', ')}`);
    io.error('A custom model (a Hugging Face id pinned to a commit, or a local folder) is set with kb_setup embedding_model.');
    return 1;
  }

  let steps: string[];
  try {
    ({ steps } = await writeKbEmbeddingModel(name));
  } catch (err) {
    if (err instanceof KbConfigUnreadableError) {
      io.error(`Error: ${err.message}; nothing was written.`);
      io.error(KB_CONFIG_HAND_FIX);
      return 1;
    }
    io.error(`Error: ${(err as Error).message}; nothing was written.`);
    return 1;
  }
  io.log(`KB embedding model: ${before} -> ${describeConfiguredEmbeddingModel()}`);
  for (const s of steps) io.log(s);
  io.log(`Config: ${KB_CONFIG_PATH}. A running fleet server switches on its next KB search; no restart needed.`);
  return 0;
}
