import { z } from 'zod';
import { KB_REMOVED_SCOPE_KEYS_SHAPE } from '../services/knowledge/kb-removed-scope-keys.js';
import fs from 'node:fs';
import path from 'node:path';
import { getKbProviders } from '../services/knowledge/kb-providers.js';
import { resolveKbAnchor, type KbAnchor } from '../services/knowledge/kb-self.js';
import { parseBibleText, importBibleEntries } from '../services/knowledge/bible-import.js';
import { requireSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import { KbMaintainerGrantError, memberLacksKbMaintainer } from '../services/knowledge/kb-maintainer-grant.js';
import {
  OWN_BIBLE_REL, BibleBlobIntegrityError, bibleBytesBlobId, isSafeBibleRef, readCommittedBibleBlob,
} from '../services/knowledge/bible-blob-id.js';

// T2.1 (F4, D3 HARDENED): kb_import -- the trusted-channel write path that lets a
// warm local KB absorb a merged-in bible (.fleet/kb-canonical.json). The
// cold-seed in kb_session_prime is OUTPUT-ONLY and fires only under
// COLD_KB_MAX=3; it never writes the DB. This tool is that missing write path.
//
// Each bible entry routes through provider.capture() (the AUDN choke point) so
// dedupe/supersede/flag semantics apply, with an INTERNAL import mode (a second,
// non-deserializable capture() parameter -- R4) that (a) preserves the entry's
// bible confidence for NON-directive types (the SOLE clamp exemption -- the
// bible is a git-reviewed, human-merged artifact), stamping source='import';
// (b) forces type='user-directive' entries through the existing directive gate
// so they land as pending proposals, never active -- a bible cannot smuggle an
// active directive; and (c) suppresses provenance normalization so the tool's
// source='import' survives. After the loop it runs freshnessSweep() so imported
// entries whose basis does not match THIS worktree are staled immediately.
//
// TRUST BOUNDARY (LOW-1, honest statement): kb_import reads a caller-named local
// file. A local caller with tool access could hand-craft a bible and import it.
// This is equivalent in power to the already-MCP-exposed kb_promote surface
// (which walks any entry INFERRED->CONFIRMED one call at a time), so
// import-from-path adds bulk convenience, not a new privilege class. The
// "git-reviewed artifact" rationale only holds for the repo-resolved
// .fleet/kb-canonical.json; an explicit --path bible is CALLER-ASSERTED trust.
// The unforgeable tier remains user-directives, which are CLI-gated -- the
// directive gate quarantines them either way.
//
// MEMBER sessions: because an explicit path is equivalent in power to
// kb_promote (it keeps bible confidence, and a v3 bible's carried hashes are
// stored verbatim, so a hand-made bible can later pass kb_bible_commit
// admission), a member session WITHOUT the kb_maintainer grant is refused an
// explicit path with E-KB-MAINTAINER-REQUIRED -- the same sessions that are not
// served kb_promote. A path naming the session's own repo-resolved bible is
// the trusted channel and is allowed, as is no path at all (the engine's
// priming import). FULL sessions and the kb_maintainer session are unchanged.
//
// The own bible is only the trusted channel AS COMMITTED: the work-tree file
// is member-writable, so a member agent could hand-edit it (CONFIRMED entries
// plus v3 hashes matching HEAD) and import it without the grant. A member
// session WITHOUT the grant therefore reads the committed blob
// (HEAD:./.fleet/kb-canonical.json, git without a shell) and never the work-
// tree file. A clean tree or fresh clone yields the same bytes, so priming is
// unchanged; uncommitted edits are ignored and reported (worktree_ignored).
// With no committed copy (unborn HEAD, untracked bible, no git) nothing is
// imported: E-KB-MAINTAINER-REQUIRED, naming the cause.
//
// TRUST ANCHOR: committed is still not trusted on its own -- the member
// controls its own .git, so it can commit a hand-made bible locally, import
// it, and reset the commit away with nothing ever pushed. Pinning to a ref
// does not help either: every ref lives in the member-writable checkout. So
// the no-grant path imports the committed bible only when its git blob id is
// recorded in the hub-side per-repo KB DB (trusted_bible_blobs), which the
// maintainer side fills: kb_bible_commit records every bible it writes, and a
// FULL or kb_maintainer kb_import records every bible it imports. An
// unrecorded blob is refused with E-KB-MAINTAINER-REQUIRED and nothing is
// imported. The checkout supplies only the blob id and bytes to check: the
// bytes are hashed in-process and must equal that id (bible-blob-id.ts), so
// a replace ref, alternates entry or overwritten object in the member's .git
// cannot pair a trusted id with forged bytes; the trust decision itself is
// taken against the hub-side record alone.
//
// `ref`: read the bible as committed at that git ref (hash-verified the same
// way) instead of the file system. For a grant session this is what makes a
// seeding import independent of the maintainer's work tree.
//
// Bootstrap: a fresh clone whose bible came from the pushed base branch
// carries a blob the maintainer wrote (kb_bible_commit on this hub) and so
// imports normally. A bible this hub never saw (fresh hub, bible merged from
// elsewhere) is seeded by the engine's sprint-start priming, which imports
// through the repository's kb_maintainer session (a grant session the member
// agent cannot open) with `ref` naming the base branch's remote-tracking ref
// (refs/remotes/origin/<base>). Priming runs before anything cleans the
// maintainer's checkout (launch alignment runs only for multi-member legacy
// launches, and branch-ensure runs after priming), so it must not read the
// work tree or HEAD: only a bible on the fetched, reviewed base branch is
// seeded. Residual exposure: that ref is as fresh as the member's last fetch,
// and like every ref it lives in the member-writable .git -- the same
// boundary as the grant itself (a routing guard, not a security boundary
// against a process on the member's host).

export const kbImportSchema = z.object({
  path: z.string().optional()
    .describe('Explicit path to a bible JSON file (e.g. <worktree>/.fleet/kb-canonical.json). This is a file path, not a scope selector: the KB written is always the calling session\'s own (a member session -> its work folder; otherwise the server folder). When omitted, resolves to <own folder>/.fleet/kb-canonical.json. TRUST NOTE: importing the repo-resolved .fleet/kb-canonical.json as committed is the git-reviewed trusted channel; an explicit --path bible is caller-asserted trust (equivalent in power to kb_promote). In a MEMBER session without the kb_maintainer grant an explicit path other than the session\'s own .fleet/kb-canonical.json is refused with E-KB-MAINTAINER-REQUIRED and nothing is imported, and the own bible is read as committed at HEAD (never the work-tree file); with no committed copy, or when that committed bible was never written or imported by the maintainer side (kb_bible_commit, or kb_import from the kb_maintainer or a FULL session), nothing is imported (E-KB-MAINTAINER-REQUIRED). Directives are quarantined to pending proposals either way.'),
  ref: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/).optional()
    .describe('Read the bible as COMMITTED at this git ref (a ref name such as HEAD or refs/remotes/origin/main; no rev expressions) instead of the file on disk; with path, reads that repository-relative file at the ref. The bytes are verified in-process against the git blob id before import. A ref that does not hold the bible fails with E-BIBLE-NOT-FOUND and nothing is imported. In the kb_maintainer or a FULL session the verified blob is what gets recorded as trusted, so a seeding import does not depend on the work tree; in a member session without the grant the trust check still applies. Omitted: the file on disk (or, in a member session without the grant, HEAD).'),
  scope: z.literal('project').optional()
    .describe('Only project scope is supported (imports into the project KB). Global bibles are a separate concern.'),
  // KB audit 2026-08-12, found by a LIVE sprint rather than by review. The
  // sprint engine imports the bible per member at sprint start; the sweep that
  // follows re-judged the WHOLE KB against that worktree and staled 16 of 17
  // CONFIRMED entries, purely because the repo had moved on since capture.
  // Three observed consequences in one run: retrieval degraded to a single
  // matchable entry, kb_export tried to write 9 over a 17-entry bible, and
  // kb_list (which filters stale=0) handed the reviewer an EMPTY promotion
  // candidate list -- reintroducing apra-fleet-0ef, "kb_promote can never
  // fire", by a side door. Opt-out, defaulting to today's behaviour.
  skip_sweep: z.boolean().optional()
    .describe('Skip the post-import freshness sweep. The sweep re-judges EVERY entry in the KB against this worktree, which is right for a deliberate audit but wrong for a routine import: an import performed to warm the KB should not mass-stale it because unrelated files have changed since capture. prime() still runs its own bounded freshness check on the entries it actually returns, so skipping this does not surface stale claims. Default false (sweep runs, unchanged).'),
  // Removed pre-redesign scope keys: declared only so a caller still passing one
  // is refused with E-SCOPE-KEY-REMOVED instead of silently re-scoped.
  ...KB_REMOVED_SCOPE_KEYS_SHAPE,
});

export type KbImportInput = z.infer<typeof kbImportSchema>;

// The KB anchor is the calling session's own folder (kb-self.ts). kb_import
// reads the bible and sweeps against that folder on THIS host, so an anchor
// naming a folder on another host refuses rather than silently skipping.
function requireLocalFolder(folder: string): string {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error('kb_import: repo folder does not exist or is not a directory on this host: ' + folder);
  }
  return folder;
}

export interface KbImportReport {
  imported: number;
  skipped: number;
  linked: number;
  flagged: number;
  /**
   * Bible entries refused by the Phase 1 capture basis check -- no source_files,
   * or source_files absent from this worktree. Import is NOT exempt: an
   * unfalsifiable entry must not enter through any path, including a legacy
   * bible, so re-importing an old bible deliberately drops those entries.
   */
  rejected: number;
  sweep: { checked: number; staled: number; unstaled: number };
  /**
   * Present exactly when the bible was read from git rather than the file
   * system: the ref read ('HEAD' for a member session without the
   * kb_maintainer grant and no `ref`; otherwise the `ref` given).
   */
  bible_source?: string;
  /**
   * With bible_source: true when the work-tree .fleet/kb-canonical.json
   * differed from (or was missing versus) the committed copy, so its
   * uncommitted content was not imported.
   */
  worktree_ignored?: boolean;
}

export async function kbImport(input: KbImportInput, anchor?: KbAnchor): Promise<string> {
  const resolved = resolveKbAnchor(anchor);
  const repoAnchor = requireLocalFolder(resolved.folder);
  const ownBible = path.join(repoAnchor, '.fleet', 'kb-canonical.json');
  const biblePath = input.path ?? ownBible;

  const lacksGrant = memberLacksKbMaintainer(anchor);
  const namesOwnBible = input.path === undefined || path.resolve(input.path) === path.resolve(ownBible);
  if (!namesOwnBible && lacksGrant) {
    throw new KbMaintainerGrantError(
      `kb_import with an explicit path ('${input.path}') keeps the bible's confidence, which is equivalent to kb_promote, so it needs the kb_maintainer grant; this member session does not carry it and nothing was imported.`,
      'Call kb_import without path to import your own checkout bible (.fleet/kb-canonical.json), or run the import from the kb_maintainer session or a FULL session.',
    );
  }

  // Validate the file resolves and parses to the bible array shape BEFORE
  // importing anything (reject otherwise -- non-zero exit at the CLI).
  // Parsing (both on-disk shapes) is shared with the member bible view
  // (services/knowledge/bible-import.ts); a malformed file throws KbBibleError.
  let bibleEntries: unknown[];
  // Set whenever the bible was read from git (no-grant sessions always; any
  // session passing `ref`): the ref read, the hash-verified blob id, and
  // whether the work-tree copy differed.
  let committedSource: { ref: string; worktree_ignored: boolean; blobId: string } | undefined;
  // Set when the bible was read from the file system (grant/FULL without ref):
  // the exact bytes parsed, whose blob id is recorded below.
  let fileBytes: Buffer | undefined;
  if (lacksGrant || input.ref !== undefined) {
    const ref = input.ref ?? 'HEAD';
    // namesOwnBible holds for a no-grant session (an explicit other path was
    // refused above); a grant session may name another repository-relative
    // file to read at `ref`.
    const rel = path.relative(repoAnchor, path.resolve(biblePath)).split(path.sep).join('/');
    const inRepo = rel !== '' && !rel.startsWith('../') && rel !== '..' && !path.isAbsolute(rel);
    if (!isSafeBibleRef(ref)) {
      throw new Error(`kb_import: ref '${ref}' is not a plain git ref name (no leading '-', no rev expressions); nothing was imported`);
    }
    let committed: { blobId: string; text: string } | null;
    try {
      committed = inRepo ? await readCommittedBibleBlob(repoAnchor, ref, rel) : null;
    } catch (err) {
      if (err instanceof BibleBlobIntegrityError) throw new Error('kb_import: ' + err.message);
      throw err;
    }
    if (committed === null && input.ref !== undefined) {
      throw new Error(`kb_import: bible file not found: ${ref}:${inRepo ? rel : biblePath}`);
    }
    // No bible anywhere (a repo that has not adopted one): the plain
    // not-found error, as for every other session -- not a grant problem.
    if (committed === null && !fs.existsSync(ownBible)) {
      throw new Error('kb_import: bible file not found: ' + ownBible);
    }
    if (committed === null) {
      throw new KbMaintainerGrantError(
        `kb_import in a member session without the kb_maintainer grant imports only the committed ${OWN_BIBLE_REL} (HEAD), and this checkout has no committed copy (unborn HEAD, untracked bible, or git unavailable); the work-tree file is not trusted at its own confidence and nothing was imported.`,
        `Commit ${OWN_BIBLE_REL} (the kb_maintainer's kb_bible_commit does this), or run the import from the kb_maintainer session or a FULL session.`,
      );
    }
    let worktree: string | null = null;
    try { worktree = fs.readFileSync(biblePath, 'utf-8'); } catch { worktree = null; }
    // Line endings are normalized for the comparison only (autocrlf checkouts).
    const lf = (t: string) => t.replace(/\r\n/g, '\n');
    committedSource = { ref, worktree_ignored: worktree === null || lf(worktree) !== lf(committed.text), blobId: committed.blobId };
    bibleEntries = parseBibleText(committed.text, ref + ':' + rel, 'kb_import');
  } else {
    if (!fs.existsSync(biblePath)) {
      throw new Error('kb_import: bible file not found: ' + biblePath);
    }
    // Read once: the bytes parsed are the bytes whose blob id is recorded.
    fileBytes = fs.readFileSync(biblePath);
    bibleEntries = parseBibleText(fileBytes.toString('utf-8'), biblePath, 'kb_import');
  }

  // repoAnchor (resolved above) selects the KB, so an import 'for' repo B can
  // never land in whichever repo the server process happens to sit in.
  const providers = await getKbProviders(repoAnchor, resolved.remoteUrl);
  const provider = requireSqliteProject(providers.project, 'kb_import');

  // Trust anchor (see the header): a committed bible is imported by a member
  // session without the grant only when the maintainer side recorded its
  // blob id in this hub-side DB. Otherwise NOTHING is imported -- refusing the
  // whole import rather than clamping CONFIRMED entries to a lower tier,
  // because a clamped row would occupy its id, and the id-exists skip in
  // importBibleEntries would then keep the genuine CONFIRMED entry out when
  // the maintainer's bible arrives later; a refusal leaves the KB untouched.
  if (lacksGrant && committedSource && !provider.isTrustedBibleBlob(committedSource.blobId)) {
    throw new KbMaintainerGrantError(
      `kb_import in a member session without the kb_maintainer grant imports the committed ${OWN_BIBLE_REL} only when the maintainer side wrote or imported that exact bible, and this checkout's committed bible (blob ${committedSource.blobId}) was never recorded by it (a bible committed only in this checkout is not trusted at its own confidence); nothing was imported.`,
      `Import a bible the kb_maintainer published (kb_bible_commit) -- e.g. reset ${OWN_BIBLE_REL} to the base branch -- or run the import from the kb_maintainer session or a FULL session, which records the bible it imports.`,
    );
  }

  // Same entry loop the member bible view uses: import mode (bible confidence
  // preserved, directives quarantined), id-exists skip first, per-entry
  // isolation of capture basis rejections.
  const { imported, skipped, linked, flagged, rejected } = await importBibleEntries(provider, bibleEntries);

  // A FULL or kb_maintainer session is trusted to import at bible confidence,
  // so the bible it just imported becomes trusted for member sessions too:
  // record the blob id the bytes would have as this repo's committed own
  // bible: the hash-verified blob id for a `ref` read, else the in-process id
  // of the exact file bytes parsed (no `git hash-object` on the path, so no
  // re-read and no member-configured clean filter decides the id). This is
  // also how a hub that never saw a bible (fresh hub, bible merged from
  // elsewhere) is seeded: the engine's sprint-start priming imports the base
  // branch's bible through the kb_maintainer session with `ref`. A member
  // session without the grant never records (it only reads the record).
  if (!lacksGrant) {
    const blobId = committedSource ? committedSource.blobId : await bibleBytesBlobId(repoAnchor, fileBytes!);
    provider.recordTrustedBibleBlob(blobId, 'kb_import');
  }

  // After the entry loop, run freshnessSweep() (T1.3) so imported entries whose
  // basis does not match THIS worktree stale immediately rather than serving
  // wrong-branch claims (D3).
  //
  // T3.1 (D4 fold-in, Phase 2 review MEDIUM yashr-d8b) sweep anchoring:
  // freshnessSweep() re-hashes each entry's stored basis via
  // computeFileHashBatch, which resolves RELATIVE paths against an explicit
  // root when given. A bible imported into THIS worktree carries repo-relative
  // basis paths, so the sweep anchors at the resolved repo -- previously via a
  // global process.chdir(repoAnchor)/process.chdir(prevCwd) pair straddling
  // the await (a process-wide mutation any other concurrent async work in this
  // process would also observe); now via freshnessSweep's own `root` parameter,
  // which threads the anchor straight into computeFileHashBatch's { cwd }
  // option with no global side effect at all. Behavior is unchanged (absolute
  // basis paths remain cwd-independent either way).
  // skip_sweep (audit 2026-08-12): report the same shape with zeroes rather
  // than omitting the field, so every existing caller reading report.sweep
  // keeps working.
  const sweep = input.skip_sweep
    ? { checked: 0, staled: 0, unstaled: 0 }
    : await provider.freshnessSweep(repoAnchor);

  const report: KbImportReport = committedSource
    ? { imported, skipped, linked, flagged, rejected, sweep, bible_source: committedSource.ref, worktree_ignored: committedSource.worktree_ignored }
    : { imported, skipped, linked, flagged, rejected, sweep };
  return JSON.stringify(report);
}
