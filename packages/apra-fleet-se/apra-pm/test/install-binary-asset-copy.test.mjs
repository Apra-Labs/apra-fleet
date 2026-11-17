// apra-fleet-oomh.13: regression guard for the copyDirResolved() text-file
// allowlist (apra-fleet-oomh.12).
//
// copyDirResolved() used to read EVERY file it copied with
// readFileSync(s, 'utf-8') and write the decoded string back out. That
// round-trip is lossless only for valid UTF-8: any byte sequence that is not
// valid UTF-8 (the 0xFF 0xFE pair in a PNG-style fixture below) decodes to
// U+FFFD REPLACEMENT CHARACTER and is written back as EF BF BD, silently
// corrupting the asset with no error pointing at the cause. No binary asset
// lives under agents/schemas or agents/_shared today, so the defect was
// latent -- this test keeps it that way.
//
// The .md assertions in the same run prove the allowlist NARROWED the rewrite
// rather than disabling it: markers must still resolve per provider.
//
// Uses an invented tool name ("Telepathy") so no case can pass by
// special-casing a real tool -- mirrors the convention in
// install-shared-schema-markers.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { copyDirResolved } from '../install.mjs';

// PNG magic (89 50 4E 47 0D 0A 1A 0A), then FF FE -- which is not a valid
// UTF-8 sequence -- then a NUL byte. Decoding this as utf-8 and re-encoding
// it does not round-trip.
const BINARY_FIXTURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0xff, 0xfe, 0x00,
]);

const MARKER_DOC =
  '<!-- if-tool: Telepathy -->keep-if<!-- else-tool: Telepathy -->keep-else<!-- end-tool: Telepathy -->';

// claude declares every tool available; agy and opencode both lack an
// invented tool, so they take the else-branch.
const EXPECTED_DOC = {
  claude: 'keep-if',
  agy: 'keep-else',
  opencode: 'keep-else',
};

const PROVIDERS = ['claude', 'agy', 'opencode'];

test('copyDirResolved: a non-UTF-8 binary asset copies byte-for-byte, for every provider', () => {
  for (const llm of PROVIDERS) {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-binary-copy-src-'));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-binary-copy-dest-'));
    try {
      fs.writeFileSync(path.join(srcDir, 'logo.png'), BINARY_FIXTURE);
      fs.writeFileSync(path.join(srcDir, 'GRAPH-SEMANTICS.md'), MARKER_DOC);
      // Nested, to prove the gate applies on the recursive path too.
      fs.mkdirSync(path.join(srcDir, 'nested'));
      fs.writeFileSync(path.join(srcDir, 'nested', 'fixture.tar'), BINARY_FIXTURE);

      copyDirResolved(srcDir, destDir, llm);

      const copied = fs.readFileSync(path.join(destDir, 'logo.png'));
      assert.ok(
        copied.equals(BINARY_FIXTURE),
        `${llm}: binary asset must copy byte-for-byte, got ${copied.toString('hex')} ` +
          `want ${BINARY_FIXTURE.toString('hex')}`
      );

      const nested = fs.readFileSync(path.join(destDir, 'nested', 'fixture.tar'));
      assert.ok(
        nested.equals(BINARY_FIXTURE),
        `${llm}: nested binary asset must copy byte-for-byte, got ${nested.toString('hex')}`
      );

      // Same run: the allowlist narrowed the rewrite, it did not disable it.
      const doc = fs.readFileSync(path.join(destDir, 'GRAPH-SEMANTICS.md'), 'utf-8');
      assert.equal(
        doc,
        EXPECTED_DOC[llm],
        `${llm}: .md markers must still resolve per provider after the allowlist gate`
      );
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  }
});

test('copyDirResolved: byte length of a binary asset is preserved (utf-8 round-trip would grow it)', () => {
  // Explicit size check: the old readFileSync(utf-8) path turned each of the
  // two invalid bytes into a 3-byte U+FFFD, so the corrupted copy was LONGER
  // than the source. Length alone is a sharp, independent signal.
  for (const llm of PROVIDERS) {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-binary-size-src-'));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-binary-size-dest-'));
    try {
      fs.writeFileSync(path.join(srcDir, 'asset.bin'), BINARY_FIXTURE);
      copyDirResolved(srcDir, destDir, llm);
      assert.equal(
        fs.statSync(path.join(destDir, 'asset.bin')).size,
        BINARY_FIXTURE.length,
        `${llm}: copied byte length must equal the source length`
      );
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  }
});

test('copyDirResolved: every allowlisted text extension still gets marker resolution', () => {
  // .md is covered above; .json and .txt are the other two allowlist entries.
  // A marker left verbatim in any of them is the split-brain bug the
  // resolution pass exists to prevent.
  for (const name of ['schema.json', 'notes.txt', 'doc.md']) {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-text-ext-src-'));
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-text-ext-dest-'));
    try {
      fs.writeFileSync(path.join(srcDir, name), MARKER_DOC);
      copyDirResolved(srcDir, destDir, 'agy');
      assert.equal(
        fs.readFileSync(path.join(destDir, name), 'utf-8'),
        EXPECTED_DOC.agy,
        `${name}: an allowlisted text extension must still be resolved`
      );
    } finally {
      fs.rmSync(srcDir, { recursive: true, force: true });
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  }
});
