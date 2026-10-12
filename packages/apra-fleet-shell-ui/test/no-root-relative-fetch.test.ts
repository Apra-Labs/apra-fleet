import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// apra-fleet-o9nv.1: every shell fetch must resolve through apiUrl() so the
// console works behind a reverse-proxy sub-path. A raw fetch("/api/...") or
// fetch("/ext/...") literal silently breaks that.

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("no root-relative fetch literals (o9nv.1)", () => {
  it("no fetch( call in src is given a root-relative '/api/' or '/ext/' string literal", () => {
    const offenders: string[] = [];
    const re = /fetch\(\s*[`"']\/(api|ext)\//;
    for (const file of sourceFiles(join(__dirname, "..", "src"))) {
      if (re.test(readFileSync(file, "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
