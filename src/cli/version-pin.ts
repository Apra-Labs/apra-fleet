/**
 * Pure helpers for checking a tool's reported version against a pinned
 * major.minor (bd against BEADS_VERSION, dolt against DOLT_VERSION).
 *
 * Why major.minor: bd 1.4.0 migrates the beads database schema one way on
 * `bd bootstrap`, after which every 1.3.x clone fails with schema skew, and bd
 * older than 1.3 silently overwrites on a duplicate `bd create --id`. Both
 * directions matter, so the check is equality of major.minor, never ">=".
 * Patch releases inside the pinned minor are accepted.
 *
 * Dependency-free so the installer, tests and any status reporter may import it.
 */

/** "1.3.0" from "bd version 1.3.0 (abc)", "dolt version 2.2.0", "v2.2.0"; null when no x.y.z is present. */
export function parseVersionLine(line: string | null | undefined): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(line ?? ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** "1.3" from "1.3.0" / "v1.3.0"; null when unparseable. */
export function majorMinor(version: string | null | undefined): string | null {
  const m = /(\d+)\.(\d+)/.exec(String(version ?? ''));
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

export interface PinCheck {
  /** True only when the output parses AND its major.minor equals the pin's. */
  ok: boolean;
  /** The parsed x.y.z, or a quoted description of the unparseable output. */
  found: string;
  /** The pin, without a leading "v". */
  expected: string;
}

/**
 * Compare a tool's version output against a pin on major.minor.
 * Unparseable output is a mismatch, never a pass.
 */
export function checkPinnedVersion(versionOutput: string | null | undefined, pin: string): PinCheck {
  const expected = pin.replace(/^v/, '');
  const parsed = parseVersionLine(versionOutput);
  if (!parsed) {
    const raw = String(versionOutput ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
    return { ok: false, found: raw ? `unparseable version output "${raw.slice(0, 80)}"` : 'no version output', expected };
  }
  return { ok: majorMinor(parsed) === majorMinor(expected), found: parsed, expected };
}
