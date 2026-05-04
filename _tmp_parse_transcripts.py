import json
import re
from collections import Counter

files = [
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\c2725758-edd5-4d2b-838a-c0223586f624.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\e88cfaef-9e3e-4508-b949-a028cf13d278.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\7fe3d4e7-a3fe-437f-a0a5-c88d5366ae66.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\62040024-f274-4b0a-9775-e6eddb03024d.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\9cafce88-498d-4ab5-8a61-3b73ffc5f32b.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\f822c14e-479d-4968-809d-d1315d8d594c.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\8203fb61-eee3-4295-ac71-c1d133ee612d.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\bad0f14f-2e78-4f18-9607-7e81dc067a2f.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\d06be991-c953-4034-81d1-ec3d53f28ea3.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\a5416ab3-a72c-4844-9d9c-e5bdb0dc1671.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\22b51f1a-c5dc-46c7-ad47-c8896cb371e8.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\3f5a400f-8f79-4496-9cdd-94a403de40ee.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\1ce70790-f040-41eb-bd2e-03e461c01c56.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\f3edfa20-b9c8-44a8-9717-c18a25272135.jsonl',
    r'C:\Users\akhil\.claude\projects\c--akhil-git-apra-fleet\046f4975-a1dd-48f2-99ce-cb269f6fa38a.jsonl',
]

def get_prefix(cmd):
    cmd = cmd.strip()
    # strip leading env var assignments like VAR=value cmd ...
    # strip sudo
    tokens = cmd.split()
    if not tokens:
        return cmd
    # skip env var assignments at start
    i = 0
    while i < len(tokens) and '=' in tokens[i] and not tokens[i].startswith('-'):
        i += 1
    if i >= len(tokens):
        return cmd
    tokens = tokens[i:]
    t0 = tokens[0]
    # handle chained commands: pick first meaningful one
    # strip path prefixes for executables
    # Normalize common patterns
    if t0 == 'npm' and len(tokens) >= 2:
        if tokens[1] == 'run' and len(tokens) >= 3:
            return f'npm run {tokens[2]}'
        return f'npm {tokens[1]}'
    if t0 == 'node' and len(tokens) >= 2:
        arg = tokens[1]
        # normalize node dist/index.js, node ~/.apra-fleet/..., etc.
        return f'node {arg}'
    if t0 == 'git' and len(tokens) >= 2:
        sub = tokens[1]
        return f'git {sub}'
    if t0 == 'gh' and len(tokens) >= 2:
        if len(tokens) >= 3:
            return f'gh {tokens[1]} {tokens[2]}'
        return f'gh {tokens[1]}'
    if t0 == 'docker' and len(tokens) >= 2:
        return f'docker {tokens[1]}'
    if t0 == 'vitest':
        return 'vitest'
    if t0 == 'npx':
        if len(tokens) >= 2:
            return f'npx {tokens[1]}'
        return 'npx'
    # paths
    if t0.startswith('~') or t0.startswith('./') or t0.startswith('/'):
        return t0
    # handle compound commands - just return the first token/program
    return t0

bash_counter = Counter()
ps_counter = Counter()
tool_counter = Counter()
bash_raw = []  # for debugging

for fpath in files:
    try:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except Exception as e:
        print(f'ERROR reading {fpath}: {e}')
        continue

    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except:
            continue

        msg = obj.get('message', {})
        if not isinstance(msg, dict):
            continue
        mc = msg.get('content', [])
        if not isinstance(mc, list):
            continue

        for item in mc:
            if not isinstance(item, dict):
                continue
            if item.get('type') != 'tool_use':
                continue
            name = item.get('name', '')
            tool_counter[name] += 1
            inp = item.get('input', {})
            if not isinstance(inp, dict):
                continue
            cmd = inp.get('command', '')
            if not cmd:
                continue
            prefix = get_prefix(cmd)
            if name == 'Bash':
                bash_counter[prefix] += 1
                bash_raw.append(cmd[:120])
            elif name == 'PowerShell':
                ps_counter[prefix] += 1

print('=== ALL TOOL NAMES ===')
for name, count in sorted(tool_counter.items(), key=lambda x: -x[1]):
    print(f'{name}: {count}')

print()
print('=== BASH COMMAND PREFIXES (sorted by count) ===')
for cmd, count in sorted(bash_counter.items(), key=lambda x: -x[1]):
    print(f'{cmd}: {count}')

print()
print('=== POWERSHELL COMMAND PREFIXES ===')
for cmd, count in sorted(ps_counter.items(), key=lambda x: -x[1]):
    print(f'{cmd}: {count}')

print()
print(f'Total Bash calls: {sum(bash_counter.values())}')
print(f'Total PowerShell calls: {sum(ps_counter.values())}')
