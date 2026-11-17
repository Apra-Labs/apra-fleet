// Upgrade-baseline selection and stale-pin check for the fresh-install harness.
// The upgrade passes (U, U2) must start from the LATEST published release; a
// pin that lags the newest release cannot prove that upgrade, so the run is
// INCONCLUSIVE rather than PASS. Pure except resolveLatestRelease, whose
// fetch is injected. Unit-tested by host-baseline.test.ts.

/** Parse "v1.2.3" (optional suffix ignored) into [1,2,3], or null. */
export function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(tag ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Semver-ish compare of two release tags; unparsable tags sort first. */
export function compareTags(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Newest pinned baseline tag in pins.json (semver order, not key order), or null. */
export function newestBaselineTag(pins) {
  const tags = Object.keys(pins?.baselines ?? {}).filter(t => parseTag(t));
  return tags.sort(compareTags).pop() ?? null;
}

export function baselineAsset(platform) {
  return {
    windows: 'apra-fleet-installer-win-x64.exe',
    linux: 'apra-fleet-installer-linux-x64',
    macos: 'apra-fleet-installer-darwin-arm64',
  }[platform];
}

/** Public, tokenless download URL of a release asset. */
export function releaseAssetUrl(repo, tag, asset) {
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

/**
 * Is the baseline used for the upgrade passes the latest release?
 * Returns { status: 'current'|'stale'|'unknown', note }. Only 'current' lets
 * the run PASS; 'stale' and 'unknown' make it INCONCLUSIVE.
 */
export function baselineStaleness({ usedTag, latestTag, lookupError = null }) {
  if (!latestTag) {
    return { status: 'unknown', note: `baseline pin unverified: could not resolve the latest release (${lookupError ?? 'no tag'}); upgrade from the latest release is not proven` };
  }
  const c = compareTags(usedTag, latestTag);
  if (c < 0) {
    return { status: 'stale', note: `baseline pin stale: upgrade passes started from ${usedTag} but the latest release is ${latestTag}; pin ${latestTag} in pins.json` };
  }
  return { status: 'current', note: `baseline ${usedTag} is the latest release (${latestTag})` };
}

/**
 * Resolve the latest release tag of `repo` without a token: the public REST
 * API first, then the releases/latest web redirect (hosted runners share IPs,
 * so the 60/h unauthenticated API limit is hit in practice).
 * Returns { tag, source } or { tag: null, error }.
 */
export async function resolveLatestRelease(repo, fetchImpl = fetch) {
  const errors = [];
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'apra-fleet-fresh-install-harness' },
    });
    if (r.ok) {
      const tag = (await r.json())?.tag_name;
      if (parseTag(tag)) return { tag, source: 'api' };
      errors.push('api: no tag_name');
    } else errors.push(`api: HTTP ${r.status}`);
  } catch (e) { errors.push(`api: ${e.message}`); }
  try {
    const r = await fetchImpl(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'apra-fleet-fresh-install-harness' } });
    const loc = r.headers?.get?.('location') ?? '';
    const m = /\/releases\/tag\/([^/?#]+)/.exec(loc);
    if (m && parseTag(decodeURIComponent(m[1]))) return { tag: decodeURIComponent(m[1]), source: 'redirect' };
    errors.push(`redirect: HTTP ${r.status} location "${loc}"`);
  } catch (e) { errors.push(`redirect: ${e.message}`); }
  return { tag: null, error: errors.join('; ') };
}
