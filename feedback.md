# Onboarding UX Feedback — Round 2

**Reviewer perspective:** First-time user who knows Claude Code, never used Apra Fleet.

---

## Verdict: APPROVED

All 5 requested fixes are correctly implemented. The onboarding flow now reads naturally from a first-time user's perspective.

---

## Fix Verification

### 1. PM skill removed from getting-started guide ✅
The guide now has 3 focused steps: add a member, give it work, check status. No cognitive overload. The PM skill is properly deferred to the multi-member nudge where it belongs.

### 2. NUDGE_AFTER_FIRST_REGISTER uses actual member name ✅
The function now accepts `memberName` and interpolates it into the example: `'Ask build-server to run the test suite'`. The caller passes `input.friendly_name`. Dynamic padding via `Math.max(1, 28 - memberName.length)` keeps the box border aligned for typical names.

### 3. WELCOME_BACK no longer shows misleading "0 online" ✅
The `onlineCount` parameter is gone entirely. The signature is now `(memberCount, lastActive)` and the output reads `Fleet: 3 members · Last active: 2h ago`. Clean and honest — no misleading data.

### 4. Step 2 phrasing is natural ✅
Both examples are now things a user would actually say:
- `'Ask my-server to run the test suite'`
- `'Send the src/ folder to my-server and run the build'`

The second example also demonstrates file transfer, which is a nice way to show two capabilities in one natural sentence.

### 5. NUDGE_AFTER_MULTI_MEMBER has plain-language PM explanation ✅
Now reads: "One member builds, another reviews — across machines." This is concrete and immediately understandable without knowing fleet internals.

### 6. SSH key nudge timing (kept as-is per user decision) — Acknowledged
Not re-flagging. The nudge is still useful security guidance even if the timing is eager.

---

## Full Read-Through — Final Notes

Reading through the entire flow as a new user (banner → guide → nudges → welcome-back), it flows well. Two minor observations that are **not blockers**:

**A. Nudge box padding with very long member names:** If a user registers a member with a name longer than ~27 characters (e.g., `production-build-server-east`), the nudge text line will exceed the box width since the padding floors at 1 space. This is an edge case — most names are short — but worth a defensive clamp or truncation if you want pixel-perfect boxes.

**B. Zero-member welcome-back:** Still says "Register a member to get started" which is slightly redundant after the first-run guide. Minor — the user may not remember the guide from a previous session, so repeating it is reasonable.

Neither of these warrant blocking the merge.

---

## Summary

| Fix | Status |
|-----|--------|
| PM removed from guide | ✅ Verified |
| Real member name in nudge | ✅ Verified |
| No misleading "0 online" | ✅ Verified |
| Natural step 2 phrasing | ✅ Verified |
| Plain-language PM nudge | ✅ Verified |
| SSH nudge timing (kept) | Acknowledged |

**The onboarding text is ready to ship.**
