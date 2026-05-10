#!/usr/bin/env python3
"""
Extract the test results JSON from a Claude Code stream-json output file.

Usage: extract-results.py <raw-output.txt>
Writes the results JSON object to stdout.
"""
import sys, json, re


def extract_json_with_overall(text):
    """Return the last JSON object containing an 'overall' key, or None."""
    # Prefer fenced ```json blocks (most reliable)
    for b in reversed(re.findall(r'```json\s*([\s\S]*?)```', text)):
        try:
            obj = json.loads(b.strip())
            if 'overall' in obj:
                return obj
        except Exception:
            pass
    # Fallback: depth-tracking scan for any {...} containing 'overall'
    depth = 0; start = -1; best = None
    for i, c in enumerate(text):
        if c == '{':
            if depth == 0:
                start = i
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    obj = json.loads(text[start:i + 1])
                    if 'overall' in obj:
                        best = obj
                except Exception:
                    pass
                start = -1
    return best


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'raw-output.txt'
    try:
        content = open(path, encoding='utf-8', errors='replace').read()
    except OSError:
        print('{"overall":"FAIL","error":"raw-output.txt not found"}')
        sys.exit(1)

    result_text = ''
    all_texts = []
    for line in content.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get('type') == 'result' and obj.get('result'):
            result_text = obj['result']
            all_texts.append(result_text)
        elif obj.get('type') == 'assistant':
            for block in obj.get('message', {}).get('content', []):
                if block.get('type') == 'text' and block.get('text'):
                    all_texts.append(block['text'])

    # Try the final result text first, then all accumulated assistant text
    for text in ([result_text] if result_text else []) + ['\n'.join(all_texts)]:
        found = extract_json_with_overall(text)
        if found:
            print(json.dumps(found))
            return

    # Last resort: reconstruct from the most recent CHECKPOINT line
    combined = '\n'.join(all_texts)
    checkpoints = []
    for line in combined.splitlines():
        if line.startswith('CHECKPOINT: '):
            try:
                cp = json.loads(line[len('CHECKPOINT: '):])
                checkpoints.append(cp)
            except Exception:
                pass
    if checkpoints:
        last = checkpoints[-1]
        overall = 'FAIL' if any(t.get('status') == 'FAIL' for t in last) else 'PASS'
        print(json.dumps({'results': last, 'overall': overall,
                          'note': 'reconstructed from checkpoints'}))
        return

    print('{"overall":"FAIL","error":"no results JSON found in output"}')


if __name__ == '__main__':
    main()
