// apra-fleet-xuo.12.1 -- Auto-grant runbook-declared permissions.
//
// Each lifecycle playbook (deploy.md, integ-test-playbook.md,
// regression-test-playbook.md) carries a `## Permissions` section that is the
// single source of truth for the Bash(...) command families a member running
// that playbook needs. Historically nothing re-composed a member's permissions
// when the sprint's own doers authored (or edited) one of these playbooks, so
// the very first Deploy/Integ-Test/Regression-Test dispatch would fail its
// Step 0 permission self-check every cycle (see fleet-sprint stabilization-log
// Issue 18). This module parses those sections and feeds them into the fleet's
// compose_permissions tool in reactive-grant mode at Sprint Setup, then
// READS BACK the member's settings.local.json to prove the grants actually
// persisted -- the POSIX heredoc write path in compose_permissions was observed
// silently no-op'ing while still reporting "Granted", so a write that reports
// success is NOT trusted until the read-back confirms it.
//
// Everything here is pure/injectable so it can be unit-tested without an MCP
// client or a live member (see test/permission-autogrant.test.mjs). The runner
// wires the real command()/compose_permissions/read-back callbacks.

// Playbook file -> the role(s) that run it. A member serving any of these roles
// is granted that playbook's declared permissions. Keys are repo-root-relative
// filenames exactly as the runner probes/reads them; role strings are the
// canonical lowercase contracts.ROLES values.
export const PLAYBOOK_ROLE_MAP = {
  'deploy.md': ['deployer'],
  'integ-test-playbook.md': ['integ-test-runner'],
  'regression-test-playbook.md': ['regression-test-runner'],
};

/**
 * Extract the `Bash(...)` permission tokens declared in a playbook's
 * `## Permissions` section. The section runs from its heading to the next
 * markdown heading (any level) or end-of-file. Tokens are matched wherever they
 * appear in that block -- bullet list, inline backticks, or prose "e.g."
 * examples -- because a broader example prefix is valid coverage too and
 * granting it is harmless (compose_permissions still filters the never-auto-
 * grant set). Returns a de-duplicated, order-preserving array; `[]` when the
 * markdown has no `## Permissions` section.
 *
 * @param {string} markdown - Full playbook file contents.
 * @returns {string[]}
 */
export function parsePermissionsSection(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];
  const lines = markdown.split(/\r?\n/);
  let inSection = false;
  const collected = [];
  const bashRe = /Bash\([^)]*\)/g;
  for (const line of lines) {
    const heading = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      const title = heading[1].trim().toLowerCase();
      if (!inSection) {
        if (title === 'permissions') inSection = true;
        continue;
      }
      // Any subsequent heading ends the Permissions section.
      break;
    }
    if (!inSection) continue;
    let m;
    bashRe.lastIndex = 0;
    while ((m = bashRe.exec(line)) !== null) collected.push(m[0]);
  }
  return [...new Set(collected)];
}

/**
 * Compute, per member, the union of playbook-declared grants that member needs.
 * A member is granted the union across EVERY playbook whose role it serves, so
 * a generalist mapped to both deployer and integ-test-runner gets both sets in
 * a single grant.
 *
 * @param {object} opts
 * @param {Record<string, string[]>} opts.playbookGrants - filename -> parsed grants.
 * @param {(role: string) => string[]} opts.getMembersForRole - resolves a role to member names.
 * @returns {Map<string, string[]>} member name -> sorted, de-duped grants.
 */
export function planMemberGrants({ playbookGrants, getMembersForRole }) {
  const perMember = new Map();
  for (const [file, grants] of Object.entries(playbookGrants || {})) {
    if (!Array.isArray(grants) || grants.length === 0) continue;
    const roles = PLAYBOOK_ROLE_MAP[file] || [];
    for (const role of roles) {
      const members = (typeof getMembersForRole === 'function' ? getMembersForRole(role) : []) || [];
      for (const member of members) {
        if (!member) continue;
        const set = perMember.get(member) || new Set();
        for (const g of grants) set.add(g);
        perMember.set(member, set);
      }
    }
  }
  const result = new Map();
  for (const [member, set] of perMember) result.set(member, [...set].sort());
  return result;
}

/**
 * Read-back verification: given the raw text of a member's
 * `.claude/settings.local.json` (read AFTER the grant write) and the grants we
 * asked compose_permissions to add, confirm every expected grant is present in
 * `permissions.allow`. Unparseable/empty content counts as "nothing persisted"
 * so the caller treats it as a failed write, not a pass.
 *
 * @param {string} settingsLocalText - raw settings.local.json contents.
 * @param {string[]} expectedGrants
 * @returns {{ ok: boolean, missing: string[], allow: string[] }}
 */
export function verifyGrantsPersisted(settingsLocalText, expectedGrants) {
  let allow = [];
  try {
    const raw = (settingsLocalText || '').trim() || '{}';
    const parsed = JSON.parse(raw);
    const a = parsed && parsed.permissions && parsed.permissions.allow;
    if (Array.isArray(a)) allow = a;
  } catch {
    allow = [];
  }
  const allowSet = new Set(allow);
  const missing = (expectedGrants || []).filter((g) => !allowSet.has(g));
  return { ok: missing.length === 0, missing, allow: [...allowSet] };
}

/**
 * Orchestrate the Sprint-Setup auto-grant: probe for each lifecycle playbook,
 * parse its `## Permissions` section, plan the per-member grant union, deliver
 * it via compose_permissions (reactive grant mode), then read back each
 * member's settings.local.json and HARD-FAIL if any grant did not persist.
 *
 * All I/O is injected so this is unit-testable:
 * @param {object} deps
 * @param {(filename: string) => Promise<boolean>} deps.probeFileExists
 * @param {(filename: string) => Promise<string>} deps.readPlaybook
 * @param {(role: string) => string[]} deps.getMembersForRole
 * @param {(opts: object) => Promise<any>} deps.composePermissions - fleet client compose_permissions.
 * @param {(member: string) => Promise<string>} deps.readMemberSettings - reads member settings.local.json.
 * @param {string} [deps.projectFolder] - optional permissions.json ledger folder.
 * @param {(msg: string) => void} [deps.log]
 * @returns {Promise<{ skipped: boolean, grantedByMember: Record<string, string[]> }>}
 * @throws {Error} when a member's read-back does not show the granted permissions.
 */
export async function autoGrantRunbookPermissions(deps) {
  const {
    probeFileExists,
    readPlaybook,
    getMembersForRole,
    composePermissions,
    readMemberSettings,
    projectFolder,
    log = () => {},
  } = deps || {};

  // 1. Gather each existing playbook's declared grants.
  const playbookGrants = {};
  for (const file of Object.keys(PLAYBOOK_ROLE_MAP)) {
    const exists = await probeFileExists(file);
    if (!exists) continue;
    const content = await readPlaybook(file);
    const grants = parsePermissionsSection(content);
    if (grants.length > 0) {
      playbookGrants[file] = grants;
      log(`Grant Runbook Permissions: '${file}' declares ${grants.length} permission(s).`);
    }
  }

  if (Object.keys(playbookGrants).length === 0) {
    log('Grant Runbook Permissions: no playbook with a ## Permissions section found -- nothing to grant.');
    return { skipped: true, grantedByMember: {} };
  }

  // 2. Plan the per-member union.
  const memberGrants = planMemberGrants({ playbookGrants, getMembersForRole });
  if (memberGrants.size === 0) {
    log('Grant Runbook Permissions: no members mapped to the runbook-serving roles -- nothing to grant.');
    return { skipped: true, grantedByMember: {} };
  }

  // 3. Grant + read-back per member. A read-back miss is a HARD error -- the
  // silent no-op write path must abort Sprint Setup, never proceed as if the
  // member were granted.
  const grantedByMember = {};
  const grantReason = 'runbook ## Permissions requirements (auto-granted at Sprint Setup, apra-fleet-xuo.12.1)';
  for (const [member, grants] of memberGrants) {
    const composeArgs = {
      member_name: member,
      grant: grants,
      grant_reason: grantReason,
    };
    if (projectFolder) composeArgs.project_folder = projectFolder;
    await composePermissions(composeArgs);

    const settingsText = await readMemberSettings(member);
    const { ok, missing } = verifyGrantsPersisted(settingsText, grants);
    if (!ok) {
      throw new Error(
        `Runbook permission auto-grant read-back FAILED for member '${member}': ` +
        `compose_permissions reported success but ${missing.length} grant(s) are ` +
        `absent from .claude/settings.local.json (permissions.allow): ${missing.join(', ')}. ` +
        `This is the silent no-op write path -- aborting Sprint Setup rather than ` +
        `dispatching a member whose runbook permissions never actually persisted.`
      );
    }
    grantedByMember[member] = grants;
    log(`Grant Runbook Permissions: member '${member}' granted and read-back-verified ${grants.length} permission(s).`);
  }

  return { skipped: false, grantedByMember };
}
