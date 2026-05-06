import { readFileSync } from 'fs';

const BASE = 'C:\\Users\\akhil\\.claude\\projects\\c--akhil-git-apra-fleet\\';
const FILES = [
  'c2725758-edd5-4d2b-838a-c0223586f624',
  'e88cfaef-9e3e-4508-b949-a028cf13d278',
  '7fe3d4e7-a3fe-437f-a0a5-c88d5366ae66',
  '62040024-f274-4b0a-9775-e6eddb03024d',
  '9cafce88-498d-4ab5-8a61-3b73ffc5f32b',
  'f822c14e-479d-4968-809d-d1315d8d594c',
  '8203fb61-eee3-4295-ac71-c1d133ee612d',
  'bad0f14f-2e78-4f18-9607-7e81dc067a2f',
  'd06be991-c953-4034-81d1-ec3d53f28ea3',
  'a5416ab3-a72c-4844-9d9c-e5bdb0dc1671',
  '22b51f1a-c5dc-46c7-ad47-c8896cb371e8',
  '3f5a400f-8f79-4496-9cdd-94a403de40ee',
  '1ce70790-f040-41eb-bd2e-03e461c01c56',
  'f3edfa20-b9c8-44a8-9717-c18a25272135',
  '046f4975-a1dd-48f2-99ce-cb269f6fa38a',
];

function getPrefix(cmd) {
  cmd = cmd.trim();
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (!tokens.length) return cmd;
  const t0 = tokens[0];
  if (t0 === 'npm' && tokens.length >= 2) {
    if (tokens[1] === 'run' && tokens.length >= 3) return `npm run ${tokens[2]}`;
    return `npm ${tokens[1]}`;
  }
  if (t0 === 'node' && tokens.length >= 2) return `node ${tokens[1]}`;
  if (t0 === 'git' && tokens.length >= 2) return `git ${tokens[1]}`;
  if (t0 === 'gh' && tokens.length >= 3) return `gh ${tokens[1]} ${tokens[2]}`;
  if (t0 === 'gh' && tokens.length >= 2) return `gh ${tokens[1]}`;
  if (t0 === 'docker' && tokens.length >= 2) return `docker ${tokens[1]}`;
  if (t0 === 'vitest') return 'vitest';
  if (t0 === 'npx' && tokens.length >= 2) return `npx ${tokens[1]}`;
  return t0;
}

const bashCounts = new Map();
const psCounts = new Map();
const toolCounts = new Map();

for (const fid of FILES) {
  const fp = BASE + fid + '.jsonl';
  let content;
  try {
    content = readFileSync(fp, 'utf-8');
  } catch (e) {
    console.error(`MISSING: ${fp}`);
    continue;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const msg = obj?.message;
    if (!msg) continue;
    const mc = msg.content;
    if (!Array.isArray(mc)) continue;
    for (const item of mc) {
      if (!item || item.type !== 'tool_use') continue;
      const name = item.name || '';
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      const cmd = item?.input?.command;
      if (!cmd) continue;
      const prefix = getPrefix(cmd);
      if (name === 'Bash') {
        bashCounts.set(prefix, (bashCounts.get(prefix) || 0) + 1);
      } else if (name === 'PowerShell') {
        psCounts.set(prefix, (psCounts.get(prefix) || 0) + 1);
      }
    }
  }
}

console.log('=== ALL TOOL NAMES ===');
for (const [k, v] of [...toolCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${k}: ${v}`);
}

console.log('\n=== BASH COMMAND PREFIXES ===');
for (const [k, v] of [...bashCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${k}: ${v}`);
}

console.log('\n=== POWERSHELL COMMAND PREFIXES ===');
for (const [k, v] of [...psCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${k}: ${v}`);
}

const bashTotal = [...bashCounts.values()].reduce((a, b) => a + b, 0);
const psTotal = [...psCounts.values()].reduce((a, b) => a + b, 0);
console.log(`\nTotal Bash calls: ${bashTotal}`);
console.log(`Total PowerShell calls: ${psTotal}`);
