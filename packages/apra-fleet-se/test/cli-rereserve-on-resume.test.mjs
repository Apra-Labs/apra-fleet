import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reReserveOnResume } from '../bin/cli.mjs';
import { MemberReservationResumeError } from '../fleet-sprint/errors.mjs';

// apra-fleet-p2to.4.2 -- the cli-level owner-checked re-reserve wrapper run on
// the workflow's 'resumed' event. This bead was reopened because the 'resumed'
// handler used to wrap reReserveForResume() in `.catch(console.error)`, which
// SWALLOWED the MemberReservationResumeError: the sprint then resumed anyway
// while holding ZERO reservations, and the designed clean-failure path (name
// the unavailable members, fail the resume) never fired.
//
// reReserveOnResume() is the fix and is exported so this exact behavior is unit
// -testable without a live engine. These tests pin the two branches so a future
// refactor cannot silently re-introduce the swallow with zero test failures:
//   (1) failure  -> re-park the run (requestPause with the naming message) AND
//                   RETHROW the MemberReservationResumeError (not swallowed).
//   (2) happy    -> return { reacquired } from reReserveForResume and do NOT
//                   call requestPause.
describe('apra-fleet-p2to.4.2: reReserveOnResume() (cli-level re-reserve on resume)', () => {
    test('failure path: re-parks the run with the naming message AND rethrows the resume error (does not swallow)', async () => {
        const pauseReasons = [];
        const logs = [];
        const resumeError = new MemberReservationResumeError(['bob', 'carol']);
        const sprintReservation = {
            reReserveForResume: async () => { throw resumeError; },
        };

        // The ORIGINAL error object must be surfaced unchanged, so callers still
        // read err.members to see which members block the resume.
        let caught;
        try {
            await reReserveOnResume({
                sprintReservation,
                resyncMember: async () => {},
                requestPause: (reason) => pauseReasons.push(reason),
                log: (msg) => logs.push(msg),
            });
        } catch (err) {
            caught = err;
        }
        assert.ok(caught instanceof MemberReservationResumeError, 'must rethrow, not swallow, the resume failure');
        assert.equal(caught, resumeError, 'must rethrow the SAME error instance, not wrap it');
        assert.deepEqual(caught.members, ['bob', 'carol'], 'the rethrown error still names the unavailable members');

        // The run was re-parked (requestPause), and the pause reason carries the
        // naming message so an operator sees which members block the resume.
        assert.equal(pauseReasons.length, 1);
        assert.match(pauseReasons[0], /resume blocked/);
        assert.match(pauseReasons[0], /bob, carol/);
        // The failure is also logged (not silent).
        assert.ok(logs.some((m) => /resume failed/.test(m) && /bob, carol/.test(m)));
    });

    test('failure path: still rethrows even when no requestPause is provided (never swallows)', async () => {
        const resumeError = new MemberReservationResumeError(['dave']);
        const sprintReservation = {
            reReserveForResume: async () => { throw resumeError; },
        };
        let caught;
        try {
            await reReserveOnResume({ sprintReservation, resyncMember: async () => {} });
        } catch (err) {
            caught = err;
        }
        assert.equal(caught, resumeError, 'a missing requestPause must not turn the failure into a silent swallow');
    });

    test('happy path: returns reReserveForResume result and does NOT re-park the run', async () => {
        const pauseReasons = [];
        const seenResync = {};
        const resyncMember = async () => {};
        const sprintReservation = {
            reReserveForResume: async ({ resyncMember: rs }) => {
                seenResync.fn = rs;
                return { reacquired: ['alice', 'bob'] };
            },
        };

        const result = await reReserveOnResume({
            sprintReservation,
            resyncMember,
            requestPause: (reason) => pauseReasons.push(reason),
            log: () => {},
        });

        assert.deepEqual(result, { reacquired: ['alice', 'bob'] }, 'happy path returns the re-acquire result to the caller');
        assert.equal(seenResync.fn, resyncMember, 'the injected resyncMember is threaded through to reReserveForResume');
        assert.equal(pauseReasons.length, 0, 'a successful resume must NOT re-pause the run');
    });
});
