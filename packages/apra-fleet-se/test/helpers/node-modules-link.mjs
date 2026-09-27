import fs from 'node:fs';

// apra-fleet-v6t7.19: fs.symlinkSync(target, linkPath, 'dir') throws EPERM on
// Windows hosts without Developer Mode or admin (no "create symbolic links"
// privilege). A directory junction needs no privilege and Windows treats it
// identically for the purpose these sandbox tests need (resolving bare
// specifiers from a symlinked/junctioned node_modules). On non-Windows
// platforms the junction type is meaningless to Node's fs layer, which
// silently treats any type value as a plain symlink there, so it is safe to
// always request 'junction' on win32 and 'dir' everywhere else.
//
// Falls back from 'dir' to 'junction' on EPERM even off win32-detection, in
// case a platform report is wrong or a non-default account configuration
// still lacks the privilege -- matching the acceptance criteria's "or fall
// back to junction on EPERM" alternative.
export function linkNodeModulesSync(target, linkPath) {
    const preferredType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
        fs.symlinkSync(target, linkPath, preferredType);
    } catch (err) {
        if (err && err.code === 'EPERM' && preferredType !== 'junction') {
            fs.symlinkSync(target, linkPath, 'junction');
            return;
        }
        throw err;
    }
}
