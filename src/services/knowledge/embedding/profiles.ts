/**
 * Embedding model profiles and the embedding.model KB config key.
 *
 * A profile says everything the runtime needs to turn text into a vector with
 * one model: where its files come from (a pinned Hugging Face revision, or a
 * local folder for air-gapped installs), how to pool and normalize the token
 * outputs, which prefixes to put on queries and documents, and the vector size
 * and token limit (the latter drives chunk sizing).
 *
 * Pinned built-in profiles (taken from the model repositories on 2026-11-05,
 * via https://huggingface.co/api/models/<repo> for the revision and
 * https://huggingface.co/api/models/<repo>/tree/<revision>/onnx for the LFS
 * sha256 of the ONNX file; the small JSON files were downloaded at that
 * revision and hashed with sha256):
 *
 *   Xenova/bge-small-en-v1.5           @ ea104dacec62c0de699686887e3f920caeb4f3e3
 *   Snowflake/snowflake-arctic-embed-s  @ e596f507467533e48a2e17c007f0e1dacc837b33
 *   Snowflake/snowflake-arctic-embed-xs @ d8c86521100d3556476a063fc2342036d45c106f
 *
 * The ONNX file is onnx/model_quantized.onnx in every case: the int8
 * (dynamic, per-channel) quantization transformers.js loads for dtype 'q8',
 * which is the dtype its WASM backend runs by default.
 *
 * bge-small-en-v1.5 gets no query prefix: v1.5 was trained so retrieval works
 * without the instruction (the model card calls it optional). The arctic
 * models' card asks for "Represent this sentence for searching relevant
 * passages: " on queries only, with CLS pooling (1_Pooling/config.json:
 * pooling_mode_cls_token true).
 */

/** How token embeddings are reduced to one vector. */
export type EmbeddingPooling = 'cls' | 'mean';

/** transformers.js dtype; selects the ONNX file under onnx/. */
export type EmbeddingDtype = 'q8' | 'int8' | 'uint8' | 'fp16' | 'fp32';

/** ONNX file (relative to the model folder) for each dtype, as transformers.js names it. */
export const ONNX_FILE_FOR_DTYPE: Readonly<Record<EmbeddingDtype, string>> = {
  q8: 'onnx/model_quantized.onnx',
  int8: 'onnx/model_int8.onnx',
  uint8: 'onnx/model_uint8.onnx',
  fp16: 'onnx/model_fp16.onnx',
  fp32: 'onnx/model.onnx',
};

/** One file a profile downloads; sha256 is set (and enforced) for built-in profiles only. */
export interface EmbeddingModelFile {
  path: string;
  sha256?: string;
}

/** Where the model files come from. */
export type EmbeddingModelSource =
  | { kind: 'hub'; repo: string; revision: string; files: EmbeddingModelFile[] }
  | { kind: 'local'; path: string };

export interface EmbeddingProfile {
  /** Profile name for a built-in, else the custom model id or folder path. */
  name: string;
  /** True for a built-in profile: every downloaded file is sha256-verified. */
  builtin: boolean;
  /** Model id as shown in fleet_status (repo id, or the folder path). */
  modelId: string;
  /** Revision as shown in fleet_status ('local' for a folder). */
  revision: string;
  source: EmbeddingModelSource;
  dtype: EmbeddingDtype;
  pooling: EmbeddingPooling;
  normalize: boolean;
  queryPrefix: string;
  docPrefix: string;
  /** Vector size; undefined for a custom model until the runtime has loaded it. */
  dims?: number;
  /** Maximum tokens per input (inputs are truncated to it; chunking sizes against it). */
  tokenLimit: number;
}

export const DEFAULT_EMBEDDING_PROFILE = 'bge-small-en-v1.5';
export const DEFAULT_TOKEN_LIMIT = 512;

const ARCTIC_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

function hubProfile(
  name: string,
  repo: string,
  revision: string,
  hashes: Record<string, string>,
  rest: Pick<EmbeddingProfile, 'pooling' | 'normalize' | 'queryPrefix' | 'docPrefix' | 'dims' | 'tokenLimit'>,
): EmbeddingProfile {
  return {
    name,
    builtin: true,
    modelId: repo,
    revision,
    source: {
      kind: 'hub',
      repo,
      revision,
      files: Object.entries(hashes).map(([p, sha256]) => ({ path: p, sha256 })),
    },
    dtype: 'q8',
    ...rest,
  };
}

/** Shared tokenizer files of both arctic models (identical bytes at their pinned revisions). */
const ARCTIC_TOKENIZER = {
  'tokenizer.json': '91f1def9b9391fdabe028cd3f3fcc4efd34e5d1f08c3bf2de513ebb5911a1854',
  'tokenizer_config.json': '9ca59277519f6e3692c8685e26b94d4afca2d5438deff66483db495e48735810',
  'special_tokens_map.json': '5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a',
};

export const BUILTIN_EMBEDDING_PROFILES: Readonly<Record<string, EmbeddingProfile>> = Object.freeze({
  'bge-small-en-v1.5': hubProfile(
    'bge-small-en-v1.5',
    'Xenova/bge-small-en-v1.5',
    'ea104dacec62c0de699686887e3f920caeb4f3e3',
    {
      'config.json': 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
      'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
      'onnx/model_quantized.onnx': '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
    },
    { pooling: 'cls', normalize: true, queryPrefix: '', docPrefix: '', dims: 384, tokenLimit: 512 },
  ),
  'snowflake-arctic-embed-s': hubProfile(
    'snowflake-arctic-embed-s',
    'Snowflake/snowflake-arctic-embed-s',
    'e596f507467533e48a2e17c007f0e1dacc837b33',
    {
      'config.json': '4e519aa92ec40943356032afe458c8829d70c5766b109e4a57490b82f72dcfb7',
      ...ARCTIC_TOKENIZER,
      'onnx/model_quantized.onnx': 'f93ff225320628d2e88baf2a395cae791b0e3b27edf5c70bf7b312a4d3260c14',
    },
    { pooling: 'cls', normalize: true, queryPrefix: ARCTIC_QUERY_PREFIX, docPrefix: '', dims: 384, tokenLimit: 512 },
  ),
  'snowflake-arctic-embed-xs': hubProfile(
    'snowflake-arctic-embed-xs',
    'Snowflake/snowflake-arctic-embed-xs',
    'd8c86521100d3556476a063fc2342036d45c106f',
    {
      'config.json': 'd7d071046ab952af96b7abad788db7ab3fc997b465e1b9914ff39707092254ec',
      ...ARCTIC_TOKENIZER,
      'onnx/model_quantized.onnx': 'e6aa5e656466a73d7c3111e9a3378bd13e5b93af30eaac2b3f13fd56692589a1',
    },
    { pooling: 'cls', normalize: true, queryPrefix: ARCTIC_QUERY_PREFIX, docPrefix: '', dims: 384, tokenLimit: 512 },
  ),
});

/** Files a custom hub model needs besides its ONNX file (transformers.js feature-extraction). */
const CUSTOM_HUB_BASE_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];

/** Resolved value of embedding.model. */
export type EmbeddingModelChoice =
  | { kind: 'disabled' }
  | { kind: 'enabled'; profile: EmbeddingProfile };

export type EmbeddingWarn = (message: string) => void;

function defaultChoice(): EmbeddingModelChoice {
  return { kind: 'enabled', profile: BUILTIN_EMBEDDING_PROFILES[DEFAULT_EMBEDDING_PROFILE] };
}

/** A Hugging Face repo id: owner/name, no path traversal. */
function isHubId(v: string): boolean {
  return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(v) && !v.includes('..');
}

/** A git revision or branch/tag name usable in a URL and a folder name. */
function isRevision(v: string): boolean {
  return /^[A-Za-z0-9][\w.-]*$/.test(v) && !v.includes('..');
}

function isAbsolutePath(v: string): boolean {
  // POSIX absolute, or a Windows drive / UNC path -- the KB config is per
  // host, so either form can appear regardless of the OS reading it.
  return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\');
}

/**
 * Parse a custom-model object. Returns the profile, or a string naming what
 * is wrong (the caller logs it and falls back to the default).
 */
function parseCustom(obj: Record<string, unknown>): EmbeddingProfile | string {
  const id = obj.id;
  const folder = obj.path;
  if ((id === undefined) === (folder === undefined)) {
    return 'a custom embedding.model object needs exactly one of "id" (Hugging Face repo id) or "path" (local folder)';
  }
  const pooling = obj.pooling ?? 'mean';
  if (pooling !== 'cls' && pooling !== 'mean') return `"pooling" must be "cls" or "mean", got ${JSON.stringify(pooling)}`;
  const normalize = obj.normalize ?? true;
  if (typeof normalize !== 'boolean') return `"normalize" must be a boolean, got ${JSON.stringify(normalize)}`;
  const queryPrefix = obj.query_prefix ?? '';
  if (typeof queryPrefix !== 'string') return '"query_prefix" must be a string';
  const docPrefix = obj.doc_prefix ?? '';
  if (typeof docPrefix !== 'string') return '"doc_prefix" must be a string';
  const dtype = obj.dtype ?? 'q8';
  if (typeof dtype !== 'string' || !(dtype in ONNX_FILE_FOR_DTYPE)) {
    return `"dtype" must be one of ${Object.keys(ONNX_FILE_FOR_DTYPE).join(', ')}, got ${JSON.stringify(dtype)}`;
  }
  const dims = obj.dims;
  if (dims !== undefined && !(Number.isInteger(dims) && (dims as number) > 0)) return '"dims" must be a positive integer';
  const tokenLimit = obj.token_limit ?? DEFAULT_TOKEN_LIMIT;
  if (!(Number.isInteger(tokenLimit) && (tokenLimit as number) > 0)) return '"token_limit" must be a positive integer';

  const common = {
    builtin: false,
    dtype: dtype as EmbeddingDtype,
    pooling: pooling as EmbeddingPooling,
    normalize,
    queryPrefix,
    docPrefix,
    dims: dims as number | undefined,
    tokenLimit: tokenLimit as number,
  };

  if (folder !== undefined) {
    if (typeof folder !== 'string' || !isAbsolutePath(folder)) return '"path" must be an absolute folder path';
    return { ...common, name: folder, modelId: folder, revision: 'local', source: { kind: 'local', path: folder } };
  }
  if (typeof id !== 'string' || !isHubId(id)) return `"id" must be a Hugging Face repo id like owner/name, got ${JSON.stringify(id)}`;
  const revision = obj.revision ?? 'main';
  if (typeof revision !== 'string' || !isRevision(revision)) return `"revision" must be a commit sha, branch or tag, got ${JSON.stringify(revision)}`;
  const files = [...CUSTOM_HUB_BASE_FILES, ONNX_FILE_FOR_DTYPE[dtype as EmbeddingDtype]].map((p) => ({ path: p }));
  return { ...common, name: id, modelId: id, revision, source: { kind: 'hub', repo: id, revision, files } };
}

/**
 * Resolve the raw embedding.model value from the KB config. Never throws:
 * - undefined -> the default profile (bge-small-en-v1.5)
 * - 'none' -> disabled (semantic search off; keyword and anchor search remain)
 * - a built-in profile name -> that profile
 * - an object {id | path, pooling, normalize, query_prefix, doc_prefix, ...} -> a custom profile
 * - anything else -> warn() with the reason, then the default profile
 */
export function resolveEmbeddingModel(raw: unknown, warn: EmbeddingWarn): EmbeddingModelChoice {
  if (raw === undefined) return defaultChoice();
  if (raw === 'none') return { kind: 'disabled' };
  if (typeof raw === 'string') {
    const profile = BUILTIN_EMBEDDING_PROFILES[raw];
    if (profile && Object.prototype.hasOwnProperty.call(BUILTIN_EMBEDDING_PROFILES, raw)) return { kind: 'enabled', profile };
    warn(
      `embedding.model ${JSON.stringify(raw)} is not a built-in profile (${Object.keys(BUILTIN_EMBEDDING_PROFILES).join(', ')}) ` +
      `or "none"; using the default ${DEFAULT_EMBEDDING_PROFILE}`,
    );
    return defaultChoice();
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const parsed = parseCustom(raw as Record<string, unknown>);
    if (typeof parsed !== 'string') return { kind: 'enabled', profile: parsed };
    warn(`embedding.model is malformed: ${parsed}; using the default ${DEFAULT_EMBEDDING_PROFILE}`);
    return defaultChoice();
  }
  warn(`embedding.model has an unsupported value ${JSON.stringify(raw)}; using the default ${DEFAULT_EMBEDDING_PROFILE}`);
  return defaultChoice();
}
