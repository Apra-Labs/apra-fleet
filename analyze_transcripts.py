import json
import os
import sys
import re
from collections import Counter

files = [
    r"C:\Users\akhil\.claude\projects\c--Users-akhil--claude-skills-lvsm-log-analyzer-skill\1486e922-70f5-452e-85bc-2fb0a1607972\subagents\agent-a11c539.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\927a8e46-0068-45d7-b5f1-b8d4bed4c4f2\subagents\agent-a701157.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\abd1652f-5eaf-45ee-9719-5409e6faad69\subagents\agent-a1df58c.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\abd1652f-5eaf-45ee-9719-5409e6faad69\subagents\agent-a3e0f0a.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\58372aff-e1ba-4c19-b5be-94f0f62b23f9\subagents\agent-af647fb.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-apranvr-NvrApiClient\a56d9a5b-abb5-4948-b4c5-84acada607c0\subagents\agent-ab592c9.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-avms\f3e1d036-109c-4624-9452-42ee93221f2e\subagents\agent-a908ba5.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\dd31951a-459e-4cae-a792-12cf9603bfd4\subagents\agent-a6dd350.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\dd31951a-459e-4cae-a792-12cf9603bfd4\subagents\agent-a1a988b.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\dd31951a-459e-4cae-a792-12cf9603bfd4\subagents\agent-a4bd861.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-avms\1252f455-ee77-4f32-8b19-b6488318b405\subagents\agent-a59232b.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\c161a14f-1a9b-462c-b141-83af1a47d458\subagents\agent-acompact-46e022.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\c161a14f-1a9b-462c-b141-83af1a47d458\subagents\agent-af61e68.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\c161a14f-1a9b-462c-b141-83af1a47d458\subagents\agent-acompact-e34df9.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-win\dfae4124-3e4f-4c99-9230-8a0f52a103ef\subagents\agent-a2c3035.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-acompact-415a67.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-acompact-9dd1c2.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-acompact-279eeb.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-accae22.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-acompact-613c56.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-acompact-4db867.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-aada47b.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-ae9bb73.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-a7e2583.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-a371977.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-a64804b.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-acompact-af18b1.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-ae03f08.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\41173766-24ab-4230-9e32-d69436bd79c9\subagents\agent-a69cad7.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\536a5396-afcc-4a54-b6fc-c29d9e2e3b15\subagents\agent-a8a7a67.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\536a5396-afcc-4a54-b6fc-c29d9e2e3b15\subagents\agent-ab0ee8d.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\536a5396-afcc-4a54-b6fc-c29d9e2e3b15\subagents\agent-ade702e.jsonl",
    r"C:\Users\akhil\.claude\projects\C--akhil-git-browser-snapshot-agent\90e8f030-d4c4-4e83-b79e-33905bedaad4\subagents\agent-ab33228.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\536a5396-afcc-4a54-b6fc-c29d9e2e3b15\subagents\agent-acompact-797207.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\536a5396-afcc-4a54-b6fc-c29d9e2e3b15\subagents\agent-ac51785.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\536a5396-afcc-4a54-b6fc-c29d9e2e3b15\subagents\agent-a860cde.jsonl",
    r"C:\Users\akhil\.claude\projects\C--akhil-agentic-ai-workshop-v1--claude-worktrees-clever-antonelli-demo\a60a0b30-8809-4a02-83fb-12a4db2bc163\subagents\agent-ae8da9a.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-avms\08c82185-1461-4544-b8cf-148fa934a818\subagents\agent-acompact-333463.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-git-streamsurv-avms\08c82185-1461-4544-b8cf-148fa934a818\subagents\agent-acompact-7cd162.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-a4a78ec.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-acompact-e8066a.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-a8db659.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-ad395a4.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-ab2ecc6.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-a588d8e.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-acompact-2b0ba5.jsonl",
    r"C:\Users\akhil\.claude\projects\c--akhil-agentic-ai-workshop-v1\e92de589-25b6-414d-bd8d-ab3f06a38c40\subagents\agent-afd7e7d.jsonl",
    r"C:\Users\akhil\.claude\projects\C--Users-akhil-temp-agentic-workshop-demo\202c6e77-b8fc-45a5-aa48-369e84da9545\subagents\agent-aa293f5.jsonl",
    r"C:\Users\akhil\.claude\projects\C--Users-akhil-temp-agentic-workshop-demo\202c6e77-b8fc-45a5-aa48-369e84da9545\subagents\agent-ac0b1d5.jsonl",
    r"C:\Users\akhil\.claude\projects\C--Users-akhil-temp-agentic-workshop-demo\202c6e77-b8fc-45a5-aa48-369e84da9545\subagents\agent-a263ee5.jsonl",
]

bash_counter = Counter()
mcp_counter = Counter()
files_read = 0
parse_errors = 0

for fpath in files:
    try:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    parse_errors += 1
                    continue

                role = obj.get('type') or obj.get('role')
                msg = obj.get('message', obj)

                if role == 'assistant' or obj.get('role') == 'assistant':
                    content = msg.get('content', [])
                    if not isinstance(content, list):
                        continue
                    for item in content:
                        if not isinstance(item, dict):
                            continue
                        if item.get('type') != 'tool_use':
                            continue
                        tool_name = item.get('name', '')
                        inp = item.get('input', {})

                        if tool_name == 'Bash':
                            cmd = inp.get('command', '')
                            bash_counter[cmd] += 1
                        elif tool_name.startswith('mcp__'):
                            mcp_counter[tool_name] += 1
        files_read += 1
    except Exception as e:
        parse_errors += 1

print("FILES_READ:" + str(files_read))
print("PARSE_ERRORS:" + str(parse_errors))
print("TOTAL_BASH:" + str(sum(bash_counter.values())))
print("UNIQUE_BASH:" + str(len(bash_counter)))
print("TOTAL_MCP:" + str(sum(mcp_counter.values())))
print("---BASH_TOP40---")
for cmd, count in bash_counter.most_common(40):
    print(str(count) + "|||" + repr(cmd[:200]))
print("---MCP_TOP20---")
for name, count in mcp_counter.most_common(20):
    print(str(count) + "|||" + name)
