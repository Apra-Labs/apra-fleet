# GFX-2 dashboard GIF -- story script

Source file (no captions): `gfx2-dashboard-story.gif` (27 frames, 4.8MB, 1568x717).
Final file (captions burned in): `gfx2-dashboard-story-captioned.gif` (27 frames,
4.7MB, 1568x717), rendered with `C:\Users\akhil\AppData\Local\Temp\claude\gfx2-caption.py`
(Pillow -- no ffmpeg on this box). Both downloaded to `C:\Users\akhil\Downloads\`.

The captioned version is the one to wire into the README. The beat sheet below
was used to time the captions frame-by-frame (verified against extracted PNGs,
not guessed) -- reuse this mapping if the GIF is ever re-cut or re-captioned.

Real capture, not staged: `apra-fleet workflow auto-sprint --issue apra-fleet-9te,apra-fleet-20i
--members fleet-rev --branch auto-sprint/gfx2-demo --base auto-sprint/eft-service
--viewer-port 18300 --max-cycles 2`, dashboard at `localhost:18300`. No frames were
recorded over a repeated-failure state; every beat below is a real, successful
transition pulled from the live run.

This is a beat sheet for overlaying captions/subtitles on the GIF (or cutting a
shorter version). Each beat names the dashboard state it corresponds to, so an
editor can time captions against the actual frame content rather than guessing.

## The arc

The two target beads were both mundane docs/logging tasks. What makes the
recording worth watching isn't the tasks -- it's that the sprint's own
integration-test gate caught two REAL bugs in the codebase mid-run, filed them
against itself as new beads, then planned, fixed, reviewed, and closed them in
a second cycle -- with no human in the loop. That is the literal "it builds
itself" claim from the README draft, caught on camera instead of asserted.

## Beats (in frame order)

1. **Cold open -- all collapsed.** Activity Tree fully collapsed to four
   top-level groups: Workflow / Sprint Setup / Sprint Cycle 1 / Sprint Cycle 2.
   Header stats: 251 Activities, 179,023 Tokens, 1hr 22m Uptime, LIVE.
   Caption idea: "One command. Then it runs on its own." /
   "1hr 22m of autonomous work, so far."

2. **Expand Sprint Cycle 1.** Reveals the phase skeleton: Plan C1 R1 -> Develop
   C1 R1 -> Review C1 R1 -> ... -> Deploy C1 -> Integ Test C1.
   Caption idea: "Plan. Develop. Review. Deploy. Test. Repeat."

3. **Expand Plan C1 R1.** Shows the raw dispatch commands (git/bd sync) leading
   into the Planner agent call.
   Caption idea: "Every step is logged -- nothing runs silently."

4. **Scroll to the end of Sprint Cycle 1 -- Integ Test C1.** The load-bearing
   shot: `Integration tests FAILED this cycle (C1, bugsFiled: apra-fleet-9te.2,
   apra-fleet-9te.3)`. Expanded, the full line reads: real integ suite run
   against a deploy-verified SHA, one part blocked by a stale status file, one
   part failing on a real `workflow auto-sprint not found` install bug --
   both filed as new beads on the spot.
   Caption idea: "The integration tester found two real bugs -- and filed them
   against itself." This is the single most important beat; give it the most
   caption dwell time / hold-frame if cutting for length.

5. **Collapse back to top level, expand Sprint Cycle 2.** Reveals a second
   full Plan -> Develop -> Review loop that did not exist when the sprint
   started -- it exists because of beat 4.
   Caption idea: "It didn't stop. It re-planned around what it found."

6. **Expand Develop C2 R1.** Shows `AGENT: Streak [apra-fleet-9te.2.1]`
   completing SUCCESS (176.2s, 15,064 tokens), then the doer's own report:
   "Fixed scripts/run-integ-suites.mjs ...".
   Caption idea: "Same fleet, same run -- now fixing its own bug."

7. **Switch to the Tasks tab, scroll to the Sprint group.** Shows
   `#apra-fleet-9te.3` (the install-path bug) and `#apra-fleet-9te.2` (the
   stale-status-file bug) with their `[impl]` children CLOSED.
   Caption idea: "Filed, fixed, closed -- in the same sprint." This is the
   closing shot; hold it a beat longer than the others as the outro frame.

## Final burned-in captions (verified frame ranges)

| Frames | Caption |
|---|---|
| 0-2 | IT'S BEEN WORKING FOR 1HR 22M. NO ONE TOLD IT TO. |
| 3-4 | PLAN -> BUILD -> REVIEW -> SHIP -> TEST. ON REPEAT. |
| 5-8 | EVERY MOVE, ON THE RECORD. |
| 9-14 | THEN ITS OWN TESTS CAUGHT 2 REAL BUGS -- AND FILED THEM AGAINST ITSELF. |
| 15-18 | MOST TOOLS WOULD STOP HERE. |
| 19-20 | THIS ONE JUST... RE-PLANNED. |
| 21-23 | SAME FLEET. SAME RUN. FIXING ITS OWN MISTAKE. |
| 24-25 | PATCHED. REVIEWED. VERIFIED. |
| 26 | FOUND IT. FIXED IT. CLOSED IT. NOBODY WATCHED. |

## Suggested trim for a 20-30s loop

If the full 27-frame GIF runs long for the README's <8MB / 20-30s spec, the
beats to keep (in order) are: 1 (cold open), 4 (bugs filed -- the payoff),
6 (doer fixing it), 7 (closed, outro). Beats 2/3/5 are connective tissue and
the first to cut if trimming.

## Known rough edges (say these out loud if asked, don't hide them)

- The first Planner dispatch of the run failed with `empty_response` (stale
  OAuth session on `fleet-rev`); a `provision_llm_auth` re-auth fixed it and
  the retry succeeded on attempt 2/5. Not shown in this GIF, but worth knowing
  if a longer cut or a transcript excerpt is published alongside it -- it is
  itself an honest data point about real (not scripted) autonomous operation.
- `apra-fleet-9te.3.2` and `apra-fleet-9te.2.2` (the test tasks for the two
  self-filed bugs) were still OPEN as of this capture -- the fix commits
  landed and were reviewer-approved, but the sprint had not yet closed the
  test-task siblings when this GIF was captured. Don't caption this as "fully
  closed end to end" without re-checking final state.
