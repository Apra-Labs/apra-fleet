import { execFileSync } from 'child_process';

// Derives a filesystem-safe slug from the git remote URL of the current repo.
// Examples:
//   https://github.com/Apra-Labs/apra-fleet.git -> apra-labs-apra-fleet
//   git@github.com:Apra-Labs/apra-fleet.git     -> apra-labs-apra-fleet
//   (no remote / git not available)              -> default
export function resolveProjectSlug(cwd?: string): string {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: cwd ?? process.cwd(),
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return slugify(remote);
  } catch {
    return 'default';
  }
}

function slugify(remoteUrl: string): string {
  // Strip protocol, auth, .git suffix
  let s = remoteUrl
    .replace(/^https?:\/\/[^@]*@?/, '')   // https://user@
    .replace(/^git@/, '')                   // git@
    .replace(/\.git$/, '')                  // .git suffix
    .replace(/[:/]/g, '-')                  // : and / -> -
    .replace(/[^a-zA-Z0-9-]/g, '')          // remove anything else
    .toLowerCase()
    .replace(/-+/g, '-')                    // collapse multiple dashes
    .replace(/^-|-$/g, '');                 // trim leading/trailing dashes
  return s || 'default';
}
