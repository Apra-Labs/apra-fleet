import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// apra-fleet-3swo.4.4: kb.mjs owns the KB work concern (URL-based scope
// selector, kb_query injection, kb_capture/kb_promote vetting+forwarding,
// kb_export), extracted move-only out of runner.js. Imported directly from
// kb.mjs (not the runner.js facade) so this suite proves the new module --
// not just runner.js's re-export -- actually holds the implementation.
// test/runner-kb-priming.test.mjs already covers the full non-fatal-failure
// and scopeOf/repo_path behavioural contract (throwing/rejecting callTool for
// both kb_query and kb_capture, recorded call payloads); this file only adds
// the facade-identity proof that was not there before the move.
import { vetKbWork, createKbWorkClient, kbScope, KB_PROMOTER_ROLES } from '../fleet-sprint/kb.mjs';
import * as runner from '../fleet-sprint/runner.js';

describe('kb.mjs is the single source of truth runner.js re-exports (apra-fleet-3swo.4.4)', () => {
    test('runner.js re-exports the identical function/value objects, not copies', () => {
        assert.equal(runner.vetKbWork, vetKbWork);
        assert.equal(runner.createKbWorkClient, createKbWorkClient);
        assert.equal(runner.KB_PROMOTER_ROLES, KB_PROMOTER_ROLES);
    });

    test('kbScope produces the URL-based scope object kb.mjs internal callers expect', () => {
        assert.deepEqual(kbScope('https://github.com/acme/repo.git'), { repo_remote_url: 'https://github.com/acme/repo.git' });
        assert.deepEqual(kbScope(undefined), {});
        assert.deepEqual(kbScope(''), {});
    });
});
