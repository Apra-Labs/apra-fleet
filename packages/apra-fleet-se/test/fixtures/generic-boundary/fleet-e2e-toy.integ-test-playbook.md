<!-- Verbatim snapshot of integ-test-playbook.md from the public repo Apra-Labs/fleet-e2e-toy at commit 608c28e1bc878c542d8e2764cfb06fa905204ac1 (the second real fleet-sprint target). Only edit: non-ASCII dashes normalized to ASCII. It stands in for a MINIMAL conforming target: the generic engine may rely only on what this file guarantees. See docs/generic-engine-boundary.md. -->
# integ-test-playbook.md

Integration test environment for NoteAPI. The app is stateless and in-memory -- there
is no external database or message broker. All state is lost on restart, which makes
reset trivial.

## Setup

Install all npm dependencies and compile the TypeScript source.
Start the server in the background on port 3001 using `npm run start:test`.
Wait until `http://localhost:3001/health` returns 200 before proceeding (retry up to 10 times, 1 second apart).

## Reset

Stop any process listening on port 3001, then start the server again on port 3001.
Wait until `http://localhost:3001/health` returns 200 before proceeding.
This clears all in-memory data, returning the app to a clean state.

## Teardown

Stop any process listening on port 3001.
