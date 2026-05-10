#!/usr/bin/env python3
"""
Extract the fleet log file path from fleet_status tool results in raw-output.txt.

The fleet daemon reports its log file in every fleet_status response:
  JSON format: {"logFile": "C:\\...\\fleet-41192.log", ...}
  Text format: "... | log=C:\\...\\fleet-41192.log | ..."

Usage: extract-fleet-log-path.py <raw-output.txt>
Prints the log path to stdout, or nothing if not found.
"""
import sys, json, re


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'raw-output.txt'
    try:
        content = open(path, encoding='utf-8', errors='replace').read()
    except OSError:
        return

    best = None
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get('type') != 'user':
            continue
        for block in obj.get('message', {}).get('content', []):
            if not isinstance(block, dict) or block.get('type') != 'tool_result':
                continue
            for c in block.get('content', []):
                if not isinstance(c, dict) or c.get('type') != 'text':
                    continue
                text = c['text']
                # Try structured JSON (fleet_status returns full JSON object)
                try:
                    d = json.loads(text)
                    if d.get('logFile'):
                        best = d['logFile']
                        continue
                except Exception:
                    pass
                # Try text format: log=<path>
                m = re.search(r'\blog=([^\s|]+\.log)', text)
                if m:
                    best = m.group(1)

    if best:
        print(best)


if __name__ == '__main__':
    main()
