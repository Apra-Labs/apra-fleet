/**
 * apra-fleet kb embed-check [--model-dir <folder>] [--text <text>]
 *
 * Diagnostic: load the KB embedding model in its worker thread and embed one
 * text, printing one JSON line ({ ok, origin, model_id, revision, dims, ms }
 * or { ok: false, reason }). Answers "does semantic search work on this
 * host/binary?" -- including in the SEA binary, where the worker script and
 * the onnxruntime-web WASM come from embedded assets (origin 'sea-asset').
 *
 * Without --model-dir it uses the configured model (embedding.model in the KB
 * config), which downloads on first use like the server does. --model-dir
 * points at a local model folder (tokenizer.json + onnx/model_quantized.onnx)
 * and never touches the network.
 */
import { Embedder } from '../services/knowledge/embedding/embedder.js';
import { resolveEmbeddingModel } from '../services/knowledge/embedding/profiles.js';
import { resolveEmbedWorkerScript } from '../services/knowledge/embedding/worker-runtime.js';
import { readEmbeddingModelSetting } from '../services/knowledge/kb-config.js';

function parseArgs(argv: string[]): { modelDir?: string; text: string } | string {
  let modelDir: string | undefined;
  let text = 'apra-fleet embedding check';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model-dir' && argv[i + 1]) modelDir = argv[++i];
    else if (a === '--text' && argv[i + 1]) text = argv[++i];
    else return `unknown or incomplete argument '${a}'`;
  }
  return { modelDir, text };
}

export async function runKbEmbedCheck(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(`Error: ${args}\nUsage: apra-fleet kb embed-check [--model-dir <folder>] [--text <text>]`);
    return 1;
  }
  const notices: string[] = [];
  const choice = resolveEmbeddingModel(
    args.modelDir ? { path: args.modelDir } : readEmbeddingModelSetting(),
    (m) => notices.push(m),
  );
  if (choice.kind === 'disabled') {
    console.log(JSON.stringify({ ok: false, reason: 'embedding is disabled (embedding.model none)' }));
    return 1;
  }
  const embedder = new Embedder({ choice, log: (m) => notices.push(m) });
  const started = Date.now();
  try {
    const origin = (await resolveEmbedWorkerScript()).origin;
    const vec = await embedder.embedQuery(args.text);
    const state = embedder.state;
    if (!vec) {
      const reason = state.state === 'failed' ? state.reason : `embedder ${state.state}`;
      console.log(JSON.stringify({ ok: false, origin, reason, notices }));
      return 1;
    }
    console.log(JSON.stringify({
      ok: true,
      origin,
      model_id: embedder.modelId,
      revision: embedder.revision,
      dims: vec.length,
      ms: Date.now() - started,
    }));
    return 0;
  } catch (err) {
    console.log(JSON.stringify({ ok: false, reason: err instanceof Error ? err.message : String(err), notices }));
    return 1;
  } finally {
    await embedder.close();
  }
}
