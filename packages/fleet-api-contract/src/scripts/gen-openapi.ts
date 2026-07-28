import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '../openapi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, '..', '..', 'openapi.json');

const doc = buildOpenApiDocument();
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
// eslint-disable-next-line no-console
console.log(`Wrote ${outPath}`);
