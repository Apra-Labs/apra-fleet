/**
 * Writes a tiny, real transformers.js-layout feature-extraction model into a
 * folder: a WordLevel tokenizer.json plus onnx/model_quantized.onnx whose
 * graph is one Gather (an embedding table lookup) from input_ids to
 * last_hidden_state [1, seq, DIMS]. Generated at test time (a hand-encoded
 * ONNX protobuf, no python/onnx tooling) so no binary fixture is committed,
 * and small enough that onnxruntime-web loads it in milliseconds.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TINY_DIMS = 4;
export const TINY_VOCAB = ['[UNK]', 'hello', 'world', 'kb', 'search', 'query:', 'probe'];

// ---- minimal protobuf encoder -------------------------------------------
function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return out;
}
const key = (field: number, wire: number) => varint((field << 3) | wire);
const vint = (field: number, n: number) => [...key(field, 0), ...varint(n)];
function bytes(field: number, data: number[] | Uint8Array): number[] {
  return [...key(field, 2), ...varint(data.length), ...data];
}
const str = (field: number, s: string) => bytes(field, [...Buffer.from(s, 'utf-8')]);

function tensorType(elemType: number, dims: (number | string)[]): number[] {
  const shape = dims.flatMap((d) => bytes(1, typeof d === 'number' ? vint(1, d) : str(2, d)));
  return bytes(1, [...vint(1, elemType), ...bytes(2, shape)]); // TypeProto.tensor_type
}
const valueInfo = (name: string, elemType: number, dims: (number | string)[]) =>
  [...str(1, name), ...bytes(2, tensorType(elemType, dims))];

const FLOAT = 1;
const INT64 = 7;

/** Embedding-table entry for token id r, dim d (rows point in different directions). */
export function tinyTableValue(r: number, d: number): number {
  return Math.fround(Math.sin(r * 7 + d * 3 + 1));
}

/** The ONNX model bytes: last_hidden_state = Gather(E, input_ids). */
export function tinyOnnxModel(): Uint8Array {
  const rows = TINY_VOCAB.length;
  const table = new Float32Array(rows * TINY_DIMS);
  for (let r = 0; r < rows; r++) for (let d = 0; d < TINY_DIMS; d++) table[r * TINY_DIMS + d] = tinyTableValue(r, d);
  const initializer = [
    ...vint(1, rows), ...vint(1, TINY_DIMS), // dims
    ...vint(2, FLOAT),
    ...str(8, 'E'),
    ...bytes(9, new Uint8Array(table.buffer)),
  ];
  const node = [...str(1, 'E'), ...str(1, 'input_ids'), ...str(2, 'last_hidden_state'), ...str(3, 'gather'), ...str(4, 'Gather')];
  const graph = [
    ...bytes(1, node),
    ...str(2, 'tiny'),
    ...bytes(5, initializer),
    ...bytes(11, valueInfo('input_ids', INT64, [1, 'seq'])),
    ...bytes(12, valueInfo('last_hidden_state', FLOAT, [1, 'seq', TINY_DIMS])),
  ];
  const model = [
    ...vint(1, 8), // ir_version
    ...bytes(7, graph),
    ...bytes(8, [...str(1, ''), ...vint(2, 13)]), // opset_import
  ];
  return Uint8Array.from(model);
}

export function tinyTokenizerJson(): Record<string, unknown> {
  return {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [],
    normalizer: { type: 'Lowercase' },
    pre_tokenizer: { type: 'WhitespaceSplit' },
    post_processor: null,
    decoder: null,
    model: { type: 'WordLevel', vocab: Object.fromEntries(TINY_VOCAB.map((t, i) => [t, i])), unk_token: '[UNK]' },
  };
}

/** Write the model's files (relative path -> bytes). */
export function tinyModelFiles(): Record<string, Uint8Array> {
  return {
    'config.json': Buffer.from(JSON.stringify({ model_type: 'bert', hidden_size: TINY_DIMS })),
    'tokenizer.json': Buffer.from(JSON.stringify(tinyTokenizerJson())),
    'tokenizer_config.json': Buffer.from(JSON.stringify({ model_max_length: 512 })),
    'onnx/model_quantized.onnx': tinyOnnxModel(),
  };
}

export function writeTinyModel(dir: string): string {
  for (const [rel, data] of Object.entries(tinyModelFiles())) {
    const file = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  }
  return dir;
}
