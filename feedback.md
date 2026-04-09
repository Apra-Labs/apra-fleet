# Onboarding UX Feedback — `src/onboarding/text.ts`

**Reviewer perspective:** First-time user who knows Claude Code, never used Apra Fleet.

---

## Verdict: CHANGES NEEDED

The text is already in good shape after the rewrite to natural language. The structure is clear, the tone is friendly, and the token budget is well-managed. However, several issues would trip up a real first-time user.

---

## 1. Getting Started Guide — Clarity

**Issue: Step 4 (`/pm`) is presented as a core onboarding step, but it's an advanced workflow.**
A first-time user hasn't even registered a member yet. Showing `/pm init → /pm pair → /pm plan → /pm start` as step 4 of "Getting Started" creates cognitive overload. These commands mean nothing without context — what does "pair" mean here? What does "init" initialize?

**Recommendation:** Remove step 4 from the getting-started guide entirely. The multi-member nudge (`NUDGE_AFTER_MULTI_MEMBER`) already introduces `/pm` at the right moment. The guide should end at step 3.

---

## 2. Getting Started Guide — Natural Language

**Issue: "Send this prompt to my-server: \<task\>" in step 2 still feels like API documentation.**
A user would never say "send this prompt to..." — they'd say something like "Ask my-server to build the frontend." The first example in step 2 is great; the second one undermines it by reverting to tool-speak.

**Recommendation:** Replace with a second natural example:
- `'Send the src/ folder to my-server and run the build'`

This shows both prompt execution and file transfer in one natural sentence.

---

## 3. Box-Drawing Formatting

**Issue: The right-side box borders in the getting-started guide don't align consistently.**
Lines have varying content lengths but the closing `│` is placed at different column positions. For example, line with "Each member works in its own directory..." extends further than others. In a monospace terminal this will look ragged.

**Recommendation:** Verify all lines are padded to the same width (the `─` border line sets the expected width). Every content line's `│` should land at the same column. A quick fix: pad all lines to match the longest content line.

---

## 4. PM Skill Introduction (Step 4 and Multi-Member Nudge)

**Issue: Neither the guide nor the nudge explains *what* the PM skill actually does in plain terms.**
"Coordinate doer-reviewer pairs across your fleet" — a new user doesn't know what a "doer-reviewer pair" is. The guide says "like a dev team" which is vague.

**Recommendation:** For the nudge, rewrite to something concrete:
> "You have multiple members — try `/pm` to split work across them. One member builds, another reviews — like pair programming across machines."

---

## 5. NUDGE_AFTER_FIRST_REGISTER (Local Member)

**Issue: The local-member nudge says "Ask \<member\> to run the test suite" with a literal `<member>` placeholder.**
A first-time user may not realize they should substitute their actual member name. Since the `memberType` is available, the member name should ideally be passed in too.

**Recommendation:** Either pass the actual member name into the function and interpolate it, or change the example to use a concrete name like `'Ask my-server to run the test suite'` — matching the getting-started guide's examples.

---

## 6. NUDGE_AFTER_FIRST_REGISTER (Remote Member)

**Issue: The SSH key nudge fires immediately after registration, before the user has even done anything with the member.**
A user who just registered a remote member wants to *use* it, not immediately change the auth method. This nudge interrupts the "aha moment" of first registration.

**Recommendation:** Show the same "give it work" nudge for both local and remote members. Move the SSH key upgrade suggestion to a later point (e.g., after the first prompt execution on a password-authenticated remote member).

---

## 7. Welcome-Back Message

**Issue: The welcome-back always shows `0 online` because the function is called with a hardcoded `0` for `onlineCount`.**
(See `onboarding.ts:194` — `WELCOME_BACK(agents.length, 0, lastActive)`.) Showing "3 members, 0 online" on every restart is misleading and makes the fleet look broken.

**Recommendation:** This is partly a code issue, but the text should handle this gracefully. Either:
- Fix the caller to pass real online counts, or
- Remove the online count from the welcome-back message until connectivity checks are implemented. Show: `Fleet: 3 members · Last active: 2h ago`

---

## 8. Welcome-Back (Zero Members)

**Issue: "Fleet ready. Register a member to get started." is fine but redundant.**
If the banner and guide were already shown (which they must have been, since `bannerShown` is true), repeating "register a member" doesn't add value. The user already knows this.

**Recommendation:** Shorten to just: `Fleet ready. No members registered yet.` — states the fact without re-instructing.

---

## 9. Docs Link

**Confirmed correct:** `https://github.com/Apra-Labs/apra-fleet` matches the project's actual GitHub URL.

---

## 10. Tone Consistency

**Overall good.** The banner tagline ("One model is a tool. A fleet is a team.") is punchy and sets the right tone. The guide steps use natural language consistently (apart from the issues noted above). The nudges use emoji tastefully as visual anchors.

**One minor inconsistency:** The banner uses `⚡` emoji framing which feels marketing-y, while the rest of the text is practical and understated. Not a blocker, but something to be aware of.

---

## Summary of Recommended Changes

| Priority | Item | Action |
|----------|------|--------|
| High | Remove PM from getting-started guide | Move to nudge-only (already exists) |
| High | Fix `<member>` placeholder in nudge | Pass real name or use concrete example |
| High | Fix misleading "0 online" in welcome-back | Remove online count or wire up real data |
| Medium | Replace "Send this prompt to..." phrasing | Use natural example sentence |
| Medium | Rewrite PM nudge with concrete explanation | Explain what it does, not just commands |
| Medium | Defer SSH key nudge for remote members | Show "give it work" nudge instead |
| Low | Fix box-drawing column alignment | Pad all lines to same width |
| Low | Simplify zero-member welcome-back text | State fact, don't re-instruct |
