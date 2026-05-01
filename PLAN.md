## Planning Session  
- Member: fleet-dev2  
- Date: 2026-05-01  
- Gemini session: 14044074-7c50-48ec-a12c-17a91d3dcac6  
  
---  
  
# provision_llm_auth cross-provider - Implementation Plan  
  
> Refactor provision_llm_auth to support cross-provider scenarios by implementing a three-strategy flow: pre-auth probing, local OAuth credential detection for the target provider, and improved OOB API key collection with provider-specific guidance.  
  
---  
  
## Tasks  
  
### Phase 1: Audit and compatibility matrix  
  
#### Task 1: Audit provider combinations  
- **Change:** Read src/providers/ to document which combinations actually work today. Produce a compatibility matrix comment block in provision-auth.ts (or a separate docs/provider-auth-matrix.md). Cover: claude->gemini, claude->codex, claude->copilot, gemini->claude, gemini->codex, gemini->copilot. Mark each: WORKS / BROKEN / UNTESTED.  
- **Files:** src/tools/provision-auth.ts or docs/provider-auth-matrix.md (new)  
- **Tier:** cheap  
- **Done when:** matrix committed with honest WORKS/BROKEN/UNTESTED status per combination  
- **Blockers:** none  
  
#### VERIFY: Phase 1  
- Matrix committed; npm run build passes  
  
---  
  
### Phase 2: Pre-auth probe  
  
#### Task 2: Add pre-auth probe before provisioning  
- **Change:** Before Flow A or B, run a lightweight CLI check on the member to detect if already authenticated. For Claude: claude -p \" "hello\ --output-format json --max-turns 1. For Gemini: gemini -p \hello\ --output-format json --max-turns 1. For Codex/Copilot: <cli> --version (audit required in Task 1 before implementing - may be UNTESTED). Strategy per combination: claude->gemini (prompt), claude->codex (version), claude->copilot (version), gemini->claude (prompt), gemini->codex (version), gemini->copilot (version). If probe succeeds -> return \already" authenticated "skipping\ immediately.  
- **Files:** src/tools/provision-auth.ts (add probeExistingAuth() helper before Flow A)  
- **Tier:** cheap  
- **Done when:** provision_llm_auth on an already-authenticated member returns immediately without copying files; Gemini probe uses real prompt verification.  
- **Blockers:** none  
  
#### VERIFY: Phase 2  
- npm test passes; manual test on authenticated member skips re-provisioning  
  
---  
  
### Phase 3: Cross-provider OAuth and OOB key flows  
  
#### Task 3: Fix Flow A for cross-provider OAuth detection  
- **Change:** (a) Detect orchestrator provider by reading %%FLEET_PROVIDER%% (or fallback to local agent config). (b) Compare it to the target member's provider. (c) Flow A currently calls provider.oauthCredentialFiles() on the TARGET provider, using LOCAL file paths. Add explicit check: if local credential file doesn't exist AND target provider != orchestrator's own provider -> skip to OOB (don't silently fail). Strategy per combination: claude->gemini (local gemini OAuth check), claude->codex (local codex check - audit required), claude->copilot (local copilot check - audit required), etc.  
- **Files:** src/tools/provision-auth.ts  
- **Tier:** standard  
- **Done when:** claude->gemini with no local Gemini OAuth -> logs \cross-provider:" no local Gemini credentials falling back to OOB API "key\; orchestrator provider detected and logged.  
- **Blockers:** none  
  
#### Task 4: Improve OOB fallback message per provider  
- **Change:** Current OOB prompt is generic. For cross-provider cases, customise: \Enter" GEMINI_API_KEY for member fleet-dev2  . Get one at: "https://aistudio.google.com/apikey\. Similarly for Codex (OPENAI_API_KEY) and Copilot. Strategy: all 6 combinations use provider-specific labels and URLs.  
- **Files:** src/tools/provision-auth.ts, src/services/auth-socket.ts (collectOobApiKey prompt param)  
- **Tier:** standard  
- **Done when:** OOB prompt shows provider-specific instructions and URL  
- **Blockers:** none  
  
#### VERIFY: Phase 3  
- npm test passes; manual cross-provider test (if feasible) confirms correct flow  
  
---  
  
### Phase 4: Tests  
  
#### Task 5: Unit tests for pre-auth probe  
- **Change:** Mock execCommand to return exit=0 -> probe detects auth -> provisionAuth returns early. Mock exit=1 -> falls through to Flow A/B.  
- **Files:** tests/provision-auth.test.ts (new or existing)  
- **Tier:** standard  
- **Done when:** npm test passes with probe path covered  
- **Blockers:** Tasks 2, 3, 4 must be complete  
  
#### Task 6: Unit tests for cross-provider flow selection  
- **Change:** Test each cross-provider combination: verify correct flow selected (probe -> OAuth -> OOB). Test that missing local credential file triggers OOB, not silent failure.  
- **Files:** tests/provision-auth.test.ts  
- **Tier:** standard  
- **Done when:** npm test covers all 6 cross-provider combinations  
- **Blockers:** Tasks 2, 3, 4 must be complete  
  
#### VERIFY: Phase 4  
- npm test passes clean  
  
## Risk Register  
  
| Risk | Impact | Mitigation |  
|------|--------|------------|  
| Pre-auth probe for Claude/Gemini uses real API call (slow) | med | Use --max-turns 1 and 10s timeout; cache result in session |  
| False-positive probe | med | Check both exit code AND absence of error patterns in stdout (e.g. \expired" "token\) |  
| Token-refresh race | low | Probe occurs immediately before dispatch; window is < 1s |  
| Cross-provider OAuth files may exist locally but be expired | med | Existing validateCredentials already catches this; ensure it's called in cross-provider path too |  
| Codex/Copilot auth mechanisms undocumented | high | Audit step (Task 1) must document before implementing; flag as UNTESTED if CLI not available |  
| OOB API key collection not available on headless CI machines | low | Document: provision_llm_auth requires interactive terminal for OOB path |  
  
## Notes  
- Base branch: main  
- Each task = one git commit  
- VERIFY = checkpoint, stop and report 
