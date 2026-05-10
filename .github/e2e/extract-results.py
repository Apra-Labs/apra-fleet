#!/usr/bin/env python3
"""
Build results.json from a Claude Code stream-json output file.

The PM emits a CHECKPOINT line after each test. This script reads those
checkpoints and assembles the final results JSON. The PM no longer needs
to produce a JSON blob — the workflow owns report assembly.

Usage: extract-results.py <raw-output.txt> [suite] [pm_os] [pm_provider]
Writes the results JSON object to stdout.
"""
import sys, json, re, datetime


def collect_texts(content):
    """Extract all text from stream-json assistant and result events."""
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
    return result_text, all_texts


def extract_checkpoints(texts):
    """Return the last CHECKPOINT array found across all text blocks."""
    checkpoints = []
    for line in '\n'.join(texts).splitlines():
        if line.startswith('CHECKPOINT: '):
            try:
                cp = json.loads(line[len('CHECKPOINT: '):])
                checkpoints.append(cp)
            except Exception:
                pass
    return checkpoints[-1] if checkpoints else None


def main():
    path        = sys.argv[1] if len(sys.argv) > 1 else 'raw-output.txt'
    suite       = sys.argv[2] if len(sys.argv) > 2 else ''
    pm_os       = sys.argv[3] if len(sys.argv) > 3 else ''
    pm_provider = sys.argv[4] if len(sys.argv) > 4 else ''

    try:
        content = open(path, encoding='utf-8', errors='replace').read()
    except OSError:
        print('{"overall":"FAIL","error":"raw-output.txt not found"}')
        sys.exit(1)

    _, all_texts = collect_texts(content)
    results = extract_checkpoints(all_texts)

    if results:
        overall = 'FAIL' if any(t.get('status') == 'FAIL' for t in results) else 'PASS'
    else:
        results = []
        overall = 'FAIL'

    report = {
        'run': {
            'suite':       suite,
            'pm_os':       pm_os,
            'pm_provider': pm_provider,
            'timestamp':   datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
        },
        'results': results,
        'overall': overall,
    }
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
