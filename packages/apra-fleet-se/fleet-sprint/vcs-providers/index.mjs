/**
 * VCS provider registry (apra-fleet-647.1.3.1).
 *
 * The manifest of provider implementations available to
 * VCSModule.classifyFailure(). ADDING A PROVIDER IS: write one file next to
 * this one exporting a descriptor of the shape documented in ./generic-git.mjs,
 * then add it to BUILT_IN_PROVIDERS below. classifyFailure's dispatch contract
 * -- its signature, its return shape, its kind precedence, its inheritance
 * walk -- is never touched, and no existing provider file is edited either.
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

/** The provider assumed when a caller passes no `provider`. GitHub, NOT
 *  generic-git: runner.js applies the GitHub literals unconditionally today
 *  regardless of who hosts the remote, so defaulting to the narrower generic
 *  set would silently drop two auth patterns (see ./github.mjs). */
export const DEFAULT_VCS_PROVIDER = 'github';

const BUILT_IN_PROVIDERS = [
    GenericGitVCS,
    GitHubVCS,
    DoltVCS,
];

const registry = new Map();

/**
 * Register (or replace) a provider implementation. Validates the descriptor
 * shape up front so a malformed provider fails at registration time rather
 * than inside a failure classifier, where the error would mask the very
 * failure being classified.
 *
 * @param {{ name: string, extends?: string|null, rules?: object, precedence?: string[], extractProviderCode?: Function }} impl
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

export { GenericGitVCS, GitHubVCS, DoltVCS };
