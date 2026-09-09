<!-- Verbatim snapshot of deploy.md from the public repo Apra-Labs/fleet-e2e-toy at commit 608c28e1bc878c542d8e2764cfb06fa905204ac1 (the second real fleet-sprint target). Only edit: non-ASCII dashes normalized to ASCII. It stands in for a MINIMAL conforming target: the generic engine may rely only on what this file guarantees. See docs/generic-engine-boundary.md. -->
# deploy.md

## Deploy

Install all npm dependencies, then compile the TypeScript source.
Start the server in the background on port 3001 using `npm run start:test` and wait a few seconds for it to become ready.

## Smoke test

Send an HTTP GET to `http://localhost:3001/health`.
A 200 response with `{"status":"ok"}` means the deployment is healthy.
Any other response or connection failure means the deployment failed.

## CI

```yaml
trigger: auto
```

CI fires automatically on push via `.github/workflows/ci.yml`. It runs lint, tests, and build.

## Teardown

Stop any process listening on port 3001.
