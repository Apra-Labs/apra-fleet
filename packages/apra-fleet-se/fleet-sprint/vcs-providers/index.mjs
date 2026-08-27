/**
 * VCS provider registry (apra-fleet-647.1.3.1; extended apra-fleet-647.1.5.1
 * to be THE single provider manifest -- see isAuthBackend()/known-vocabulary
 * note below).
 *
 * The manifest of provider implementations available to
 * VCSModule.classifyFailure(), VCSModule.resolveProvider() and
 * VCSModule.buildVcsCommand() (create-pull-request / comment). ADDING A
 * PROVIDER IS: write one file next to this one exporting a descriptor of the
 * shape documented in ./generic-git.mjs, then add it to BUILT_IN_PROVIDERS
 * below -- NO OTHER FILE under fleet-sprint/ changes. classifyFailure's
 * dispatch contract -- its signature, its return shape, its kind precedence,
 * its inheritance walk -- is never touched, and no existing provider file is
 * edited either.
 *
 * REQUIRED EXPORT SHAPE (registerVcsProvider() validates the fields marked
 * required; everything else is optional and only needed for the axis it
 * supports):
 *   {
 *     name:       string                  // required; the `provider` value callers pass
 *     extends:    string|null             // provider whose classifyFailure() rules are inherited
 *     rules:      { [VCS_FAILURE_KIND]: RegExp[] }   // classifyFailure() axis
 *     precedence: string[]|undefined      // optional kind-check order override
 *     extractProviderCode: (raw) => string|null       // classifyFailure() axis
 *     matchesHost: (host) => boolean                  // OPTIONAL; capabilities()
 *                                          // axis. Which remote hosts this
 *                                          // provider claims, for
 *                                          // resolveVcsProviderForHost()
 *                                          // below. Omit for a provider that
 *                                          // never owns a host (dolt), and
 *                                          // for the generic-git catch-all
 *                                          // it returns true unconditionally.
 *     capabilitiesForHost: (host) => { canOpenPullRequest: boolean }  // OPTIONAL;
 *                                          // capabilities() axis. What a
 *                                          // claimed host supports. MUST stay
 *                                          // in lockstep with `builders`:
 *                                          // report canOpenPullRequest:false
 *                                          // while the create-pull-request
 *                                          // builder is absent, so publish
 *                                          // never builds an unsupported
 *                                          // command (see ./azure-devops.mjs).
 *                                          // A provider that omits this hook
 *                                          // is treated as capability-less.
 *     parseRepoRef: (url) => { org, project, repo, canonical }|null   // OPTIONAL;
 *                                          // remote-URL axis. Parse a git
 *                                          // remote URL into the coordinates
 *                                          // this provider's REST API needs,
 *                                          // for providers whose identity is
 *                                          // not the portable "owner/name"
 *                                          // pair (see ./azure-devops.mjs).
 *                                          // MUST return null -- never throw,
 *                                          // never a partial guess -- for
 *                                          // input it does not recognize, so
 *                                          // the caller can raise its own
 *                                          // typed ERROR naming the expected
 *                                          // shape.
 *     repoRefHint: string                 // OPTIONAL; remote-URL axis. The
 *                                          // human-readable remote shape
 *                                          // parseRepoRef() expects, e.g.
 *                                          // 'https://dev.azure.com/ORG/
 *                                          // PROJECT/_git/REPO'. Quoted
 *                                          // verbatim into the typed ERROR
 *                                          // VCSModule.parseProviderRepoRef()
 *                                          // raises for a claimed-but-
 *                                          // unrecognized remote, which is
 *                                          // what keeps that remedy text --
 *                                          // and every other provider-specific
 *                                          // literal -- out of the shared
 *                                          // callers. Only meaningful
 *                                          // alongside parseRepoRef.
 *     buildProvisionArgs: (ctx) => { args }|{ error }   // OPTIONAL;
 *                                          // provisioning axis. Build the
 *                                          // provision_vcs_auth argument
 *                                          // object for a member of this
 *                                          // provider, given the shared
 *                                          // caller's `base` args, this
 *                                          // provider's own parseRepoRef()
 *                                          // output for the member's remote
 *                                          // (`repoRef`) and the credential-
 *                                          // store entry names the caller
 *                                          // observed (`availableSecrets`,
 *                                          // null when unreadable). Omit it
 *                                          // and the caller sends its shared
 *                                          // GitHub-App-shaped arguments
 *                                          // unchanged. MUST return a typed
 *                                          // 'ERROR: ' string in `error`
 *                                          // rather than prompting: the
 *                                          // callers are unattended preflight
 *                                          // and self-heal paths, where an
 *                                          // out-of-band prompt stalls a
 *                                          // sprint. MUST pass a secret as a
 *                                          // {{secure.NAME}} placeholder,
 *                                          // never a value -- resolution is
 *                                          // hub-side (see ./azure-devops.mjs).
 *     defaultAuthMode: string|null        // OPTIONAL, but declaring it (even
 *                                          // as null) is what makes a provider
 *                                          // part of resolveProvider()'s/
 *                                          // buildVcsCommand()'s known-provider
 *                                          // vocabulary -- see isAuthBackend()
 *                                          // below. Omit entirely for a
 *                                          // classification-only provider
 *                                          // (generic-git, dolt) that is not a
 *                                          // member-facing VCS auth backend.
 *     pullRequestResponse: {              // OPTIONAL; response axis
 *       idField: string,                  //   apra-fleet-lzfv.4. How to read a
 *       webUrlField: string|null,         //   create-pull-request 2xx response
 *       webUrlTemplate: string|null,      //   BODY, which is as provider-
 *       map: (body, ctx) => { id, url }   //   specific as the request is:
 *     }                                   //   GitHub answers with `number` +
 *                                          //   `html_url`, Azure DevOps with
 *                                          //   `pullRequestId` and NO web-URL
 *                                          //   field at all (its `url` is the
 *                                          //   REST resource, not a page), so
 *                                          //   its browsable URL must be
 *                                          //   CONSTRUCTED from the request's
 *                                          //   own org/project/repo plus the
 *                                          //   returned id. Declaring the
 *                                          //   mapping on the descriptor is
 *                                          //   what keeps either dialect out
 *                                          //   of the shared caller, which
 *                                          //   until this hook existed read
 *                                          //   `html_url` off the body itself.
 *                                          //   `idField`/`webUrlField`/
 *                                          //   `webUrlTemplate` are the
 *                                          //   DECLARATION (what a consumer
 *                                          //   mirroring this contract in
 *                                          //   another language/package
 *                                          //   restates); `map` is the single
 *                                          //   executable source of truth and
 *                                          //   MUST read those same declared
 *                                          //   fields rather than repeat them.
 *                                          //   `map` MUST NOT throw and MUST
 *                                          //   return { id: number|null,
 *                                          //   url: string|null } -- an
 *                                          //   unreadable id or a coordinate
 *                                          //   missing from `ctx` yields null,
 *                                          //   never a guessed value, so a
 *                                          //   successful PR is never turned
 *                                          //   into a crash by its own
 *                                          //   reporting step. `ctx` is the
 *                                          //   request-side coordinates
 *                                          //   (org/project/repo, or a
 *                                          //   `repoRef` object -- the same
 *                                          //   shape the builders take); a
 *                                          //   provider whose body is
 *                                          //   self-sufficient ignores it.
 *     builders:   { [action]: Function }|null  // create-pull-request/comment
 *                                                // command builders; null means
 *                                                // "known provider, action(s)
 *                                                // not yet implemented" (fails
 *                                                // closed with a typed ERROR:,
 *                                                // never a silently wrong command)
 *   }
 *
 * The manifest is an explicit import list rather than a directory scan on
 * purpose: this package is bundled into a single executable (npm run
 * build:binary), where a runtime readdir of the source tree does not exist.
 *
 * Out-of-tree/experimental providers (and tests) can register at runtime via
 * registerVcsProvider(); the same one-file contract applies.
 *
 * ASCII only.
 */

import { GenericGitVCS } from './generic-git.mjs';
import { GitHubVCS } from './github.mjs';
import { DoltVCS } from './dolt.mjs';
import { BitbucketVCS } from './bitbucket.mjs';
import { AzureDevOpsVCS } from './azure-devops.mjs';

/** The provider assumed when a caller passes no `provider`. GitHub, NOT
 *  generic-git: runner.js applies the GitHub literals unconditionally today
 *  regardless of who hosts the remote, so defaulting to the narrower generic
 *  set would silently drop two auth patterns (see ./github.mjs). */
export const DEFAULT_VCS_PROVIDER = 'github';

const BUILT_IN_PROVIDERS = [
    GenericGitVCS,
    GitHubVCS,
    DoltVCS,
    BitbucketVCS,
    AzureDevOpsVCS,
];

const registry = new Map();

/**
 * Register (or replace) a provider implementation. Validates the descriptor
 * shape up front so a malformed provider fails at registration time rather
 * than inside a failure classifier, where the error would mask the very
 * failure being classified.
 *
 * @param {{ name: string, extends?: string|null, rules?: object, precedence?: string[], extractProviderCode?: Function, defaultAuthMode?: string|null, builders?: object|null }} impl
 * @returns {string} the registered provider name
 */
export function registerVcsProvider(impl) {
    if (!impl || typeof impl !== 'object' || typeof impl.name !== 'string' || !impl.name.trim()) {
        throw new Error('ERROR: VCSModule: a provider implementation must be an object with a non-empty string `name`.');
    }
    if (impl.rules != null && typeof impl.rules !== 'object') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`rules\` table.`);
    }
    if (impl.extractProviderCode != null && typeof impl.extractProviderCode !== 'function') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function \`extractProviderCode\`.`);
    }
    // apra-fleet-5co8.1.1: the host/URL-axis hooks. All OPTIONAL (a
    // classification-only provider declares none of them), but validated up
    // front for the same reason as `extractProviderCode` above -- a malformed
    // hook must fail at registration, not inside resolveVcsProviderForHost()
    // or a remote-URL preflight where the error would mask the real failure.
    for (const hook of ['matchesHost', 'capabilitiesForHost', 'parseRepoRef', 'buildProvisionArgs']) {
        if (impl[hook] != null && typeof impl[hook] !== 'function') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function \`${hook}\`.`);
        }
    }
    // apra-fleet-5co8.1.2: the remedy text quoted into a preflight ERROR. A
    // non-string here would land the literal 'undefined'/'[object Object]' in
    // an operator-facing error, so reject it at registration too.
    if (impl.repoRefHint != null && typeof impl.repoRefHint !== 'string') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-string \`repoRefHint\`.`);
    }
    // apra-fleet-647.1.5.1: the two auth-backend fields folded in from
    // vcs-module.mjs's former BUILDERS/DEFAULT_AUTH_MODES tables. Both are
    // OPTIONAL (a classification-only provider like generic-git/dolt omits
    // them entirely -- see isAuthBackend() below), but validated up front,
    // same rationale as `rules`/`extractProviderCode` above.
    if (Object.prototype.hasOwnProperty.call(impl, 'defaultAuthMode') && impl.defaultAuthMode !== null && typeof impl.defaultAuthMode !== 'string') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-string, non-null \`defaultAuthMode\`.`);
    }
    // apra-fleet-lzfv.4: the create-pull-request RESPONSE mapping. OPTIONAL
    // (a classification-only provider, or one with no PR builder, declares
    // none), but validated up front for the same reason as the hooks above --
    // a malformed mapping must fail at registration, not while reporting an
    // already-created pull request, where the error would mask a success.
    if (impl.pullRequestResponse != null) {
        const prr = impl.pullRequestResponse;
        if (typeof prr !== 'object') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`pullRequestResponse\`.`);
        }
        if (typeof prr.idField !== 'string' || !prr.idField.trim()) {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`pullRequestResponse\` with no non-empty string \`idField\`.`);
        }
        if (typeof prr.map !== 'function') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`pullRequestResponse\` with a non-function \`map\`.`);
        }
        for (const field of ['webUrlField', 'webUrlTemplate']) {
            if (prr[field] != null && typeof prr[field] !== 'string') {
                throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`pullRequestResponse\` with a non-string, non-null \`${field}\`.`);
            }
        }
    }
    if (impl.builders != null) {
        if (typeof impl.builders !== 'object') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`builders\` table.`);
        }
        for (const [action, builder] of Object.entries(impl.builders)) {
            if (typeof builder !== 'function') {
                throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function builder for action "${action}".`);
            }
        }
    }
    registry.set(impl.name, impl);
    return impl.name;
}

/** Remove a registered provider. Intended for tests that register a throwaway
 *  provider and must not leak it into later cases. */
export function unregisterVcsProvider(name) {
    return registry.delete(name);
}

/** @returns {boolean} whether `name` names a registered provider. */
export function isKnownVcsProvider(name) {
    return registry.has(name);
}

/** @returns {string[]} every registered provider name, in registration order. */
export function listVcsProviders() {
    return [...registry.keys()];
}

/** @returns {object|undefined} the raw descriptor, or undefined if unknown. */
export function getVcsProvider(name) {
    return registry.get(name);
}

/**
 * Whether `impl` is a member-facing "VCS auth backend" -- one a member can
 * actually be provisioned/registered against via provision_vcs_auth (github,
 * bitbucket, azure-devops) -- as opposed to a classification-only entry in
 * this SAME registry (generic-git, dolt) that exists purely for
 * classifyFailure()'s inheritance walk and is never a value a member's own
 * `vcsProvider` field holds.
 *
 * The marker is declaring the `defaultAuthMode` OWN property at all (even as
 * `null` -- see ./bitbucket.mjs, ./azure-devops.mjs), NOT its value, so a
 * provider opts into VCSModule.resolveProvider()'s/buildVcsCommand()'s known
 * vocabulary by declaring that one field, with no second list to keep in
 * sync (apra-fleet-647.1.5.1 AC: "registry and vocabulary can never drift
 * apart").
 *
 * @param {object|undefined} impl
 * @returns {boolean}
 */
export function isAuthBackend(impl) {
    return !!impl && Object.prototype.hasOwnProperty.call(impl, 'defaultAuthMode');
}

/** @returns {string[]} every registered auth-backend provider name (see
 *  isAuthBackend()), in registration order -- the known-provider vocabulary
 *  for VCSModule.resolveProvider() and buildVcsCommand()'s "unsupported
 *  provider" error. */
export function listVcsAuthProviders() {
    return listVcsProviders().filter((name) => isAuthBackend(registry.get(name)));
}

/**
 * Resolve `name` to its inheritance chain, most-derived FIRST, so a provider's
 * own patterns are always checked before the ones it inherits. A missing
 * provider resolves to the generic base rather than throwing -- see the
 * non-throwing rationale in vcs-module.mjs classifyFailure(). A cyclic or
 * dangling `extends` terminates the walk instead of looping.
 *
 * @param {string} name
 * @returns {object[]}
 */
export function resolveVcsProviderChain(name) {
    const chain = [];
    const seen = new Set();
    let current = registry.get(name) || registry.get(DEFAULT_VCS_PROVIDER) || GenericGitVCS;
    while (current && !seen.has(current.name)) {
        seen.add(current.name);
        chain.push(current);
        current = current.extends ? registry.get(current.extends) : null;
    }
    return chain;
}

/**
 * Resolve which registered provider claims `host` for VCSModule.capabilities()
 * (apra-fleet-647.1.4.1) -- a DIFFERENT dispatch axis than
 * resolveVcsProviderChain() above (that one resolves a NAME the caller
 * already knows to its inheritance chain for failure classification; this
 * one resolves an unknown remote HOST to the provider that recognizes it).
 *
 * Every non-catch-all provider (anything but 'generic-git' itself) is tried
 * first, most-recently-registered first, so a provider registered at runtime
 * via registerVcsProvider() can claim a host without editing this file.
 * 'generic-git' is always the fallback -- its own matchesHost() returns true
 * unconditionally, so it never needs to be tried first.
 *
 * @param {string|null} host
 * @returns {object} a provider descriptor; never undefined.
 */
export function resolveVcsProviderForHost(host) {
    for (const provider of [...registry.values()].reverse()) {
        if (provider.name === 'generic-git') continue;
        if (typeof provider.matchesHost === 'function' && provider.matchesHost(host)) {
            return provider;
        }
    }
    return registry.get('generic-git') || GenericGitVCS;
}

for (const impl of BUILT_IN_PROVIDERS) registerVcsProvider(impl);

export { GenericGitVCS, GitHubVCS, DoltVCS, BitbucketVCS, AzureDevOpsVCS };
