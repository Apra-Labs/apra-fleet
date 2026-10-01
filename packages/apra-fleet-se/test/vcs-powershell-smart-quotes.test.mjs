import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { shQuote } from '../fleet-sprint/vcs-providers/shell-helpers.mjs';

// PowerShell ends a single-quoted string on ASCII ' AND on U+2018..U+201B,
// which LLM-written PR titles/bodies routinely contain. The PowerShell-dialect
// shQuote must double each of them (as itself) so the value cannot break out.
// Built with fromCharCode so this source file stays ASCII.
const SMART_QUOTES = [0x2018, 0x2019, 0x201a, 0x201b].map((c) => String.fromCharCode(c));
const RSQ = String.fromCharCode(0x2019);

test('shQuote (powershell) doubles every PowerShell single-quote character as itself', () => {
    for (const q of SMART_QUOTES) {
        assert.equal(shQuote(`a${q}b`, 'windows', 'powershell'), `'a${q}${q}b'`);
    }
    assert.equal(shQuote("it's", 'windows', 'powershell'), "'it''s'");
    assert.equal(shQuote('plain text', 'windows', 'powershell'), "'plain text'");
});

test('shQuote (posix) is unaffected by smart quotes', () => {
    assert.equal(shQuote(`a${RSQ}b`, 'linux'), `'a${RSQ}b'`);
});

test('shQuote (powershell) output round-trips literally through real powershell', { skip: process.platform !== 'win32' ? 'requires Windows PowerShell' : false }, () => {
    const value = `doer${RSQ}s step; Write-Output pwned; ${SMART_QUOTES.join('')}'x`;
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write(${shQuote(value, 'windows', 'powershell')})`;
    const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.equal(out, value);
});
