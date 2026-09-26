// =============================================================================
// Review slices for the end-of-cycle review in build pipeline mode
// (docs/lazy-parallel-sprints.md section 9). Everything here is pure except
// planReviewSlicesFor(), whose git reads go through the injected command()
// (registered in guarded-modules.mjs, so every guard scans it).
//
// The cycle's changed files are grouped by area (their leading directories),
// the groups are packed into at most `maxSlices` balanced slices, and each
// slice gets its own reviewer. When there is more than one slice, one more
// reviewer looks across all of them for inconsistency. Verdicts are merged:
// approved only if every reviewer approves, findings are the union.
// =============================================================================

/** Leading-directory key a file is grouped under (up to two levels). */
export function areaOf(file) {
    const parts = String(file).split('/').filter(Boolean);
    if (parts.length <= 1) return '(root)';
    return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

/**
 * Split `files` into at most `maxSlices` slices by area, balanced by file
 * count (largest areas first, each into the currently smallest slice).
 * Returns [] when there is nothing to split or only one slice would result.
 */
export function buildReviewSlices(files, maxSlices) {
    const unique = [...new Set((files || []).map(String).filter(Boolean))];
    if (unique.length === 0 || !(maxSlices >= 2)) return [];
    const byArea = new Map();
    for (const f of unique) {
        const a = areaOf(f);
        if (!byArea.has(a)) byArea.set(a, []);
        byArea.get(a).push(f);
    }
    const areas = [...byArea.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]));
    const count = Math.min(maxSlices, areas.length);
    if (count < 2) return [];
    const slices = Array.from({ length: count }, () => ({ areas: [], files: [] }));
    for (const [area, list] of areas) {
        const target = slices.reduce((min, s) => (s.files.length < min.files.length ? s : min), slices[0]);
        target.areas.push(area);
        target.files.push(...list);
    }
    for (const s of slices) {
        s.areas.sort();
        s.files.sort();
    }
    return slices;
}

/** Instruction that narrows one reviewer to its slice. */
export function sliceFocus(slice, index, total) {
    const shown = slice.files.slice(0, 200);
    return 'REVIEW SLICE ' + (index + 1) + ' OF ' + total + ': other reviewers are covering the rest of this ' +
        'sprint at the same time. Review ONLY the changes to these files (areas: ' + slice.areas.join(', ') + '): ' +
        shown.join(', ') + (slice.files.length > shown.length ? ', ...' : '') + '. ' +
        'Judge them against the acceptance criteria of the work that touched them, and report findings only ' +
        'for these files.';
}

/** Instruction for the one reviewer who looks across every slice. */
export function crossCuttingFocus(slices) {
    return 'CROSS-AREA REVIEW: ' + slices.length + ' other reviewers are each reviewing one area of this sprint ' +
        'in detail (' + slices.map((s) => s.areas.join(' + ')).join('; ') + '). Do NOT repeat their line-by-line ' +
        'review. Look only ACROSS areas: the same thing done two different ways, duplicated helpers, names or ' +
        'data shapes that disagree between areas, and conventions followed in one area but broken in another.';
}

/** Merge several reviewer verdicts into one. */
export function mergeVerdicts(verdicts) {
    const list = verdicts.filter(Boolean);
    const approved = list.length > 0 && list.every((v) => v.verdict === 'APPROVED');
    const reopenIds = [];
    const seenReopen = new Set();
    for (const v of list) {
        for (const r of v.reopenIds || []) {
            const key = typeof r === 'string' ? r : (r && r.id) || JSON.stringify(r);
            if (seenReopen.has(key)) continue;
            seenReopen.add(key);
            reopenIds.push(r);
        }
    }
    const newTasks = [];
    const seenTask = new Set();
    for (const v of list) {
        for (const t of v.newTasks || []) {
            const key = String((t && t.title) || '').trim().toLowerCase() || JSON.stringify(t);
            if (seenTask.has(key)) continue;
            seenTask.add(key);
            newTasks.push(t);
        }
    }
    return {
        verdict: approved ? 'APPROVED' : 'CHANGES_NEEDED',
        notes: list.map((v, i) => 'Reviewer ' + (i + 1) + ': ' + (v.notes || '')).join('\n\n'),
        reopenIds,
        newTasks,
    };
}

/**
 * Plan the slices for this cycle: read the files the sprint changed, slice
 * them across `members` (keeping one for the cross-area reviewer), and put
 * every reviewer on the current sprint branch. Needs at least three members;
 * anything short of that, or a diff that cannot be read, returns null and the
 * caller keeps its single review.
 */
export async function planReviewSlicesFor({ command, validated, orchestratorMember, members, shouldSplit = () => true }) {
    if (!Array.isArray(members) || members.length < 3) return null;
    await command(`git fetch origin ${validated.baseBranch} --quiet`, {
        member_name: orchestratorMember, silent: true, failSoft: true, label: `Review slices: fetch '${validated.baseBranch}'`,
    });
    const diff = await command(`git diff --name-only origin/${validated.baseBranch}...${validated.branch}`, {
        member_name: orchestratorMember, silent: true, failSoft: true, label: 'Review slices: files changed this sprint',
    });
    if (!diff.ok) return null;
    const files = String(diff.output).split('\n').map((s) => s.trim()).filter(Boolean);
    // A sprint design can keep small diffs to one reviewer.
    if (!shouldSplit(files.length)) return null;
    const slices = buildReviewSlices(files, Math.min(6, members.length - 1));
    if (slices.length < 2) return null;
    const used = members.slice(0, slices.length + 1);
    for (const m of used) {
        if (m === orchestratorMember) continue;
        await command(`git fetch origin ${validated.branch} --quiet`, {
            member_name: m, silent: true, failSoft: true, label: `Review slices: fetch '${validated.branch}' on '${m}'`,
        });
        await command(`git checkout -B ${validated.branch} origin/${validated.branch}`, {
            member_name: m, silent: true, failSoft: true, label: `Review slices: '${validated.branch}' on '${m}'`,
        });
    }
    return { slices, members: used };
}
