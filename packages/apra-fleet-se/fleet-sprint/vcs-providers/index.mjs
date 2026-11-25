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
 *     matchesHostForAuth: (host) => boolean // OPTIONAL; the CREDENTIAL-
 *                                          // PROVISIONING axis, for
 *                                          // resolveVcsAuthProviderForHost()
 *                                          // below. Declare it ONLY when a
 *                                          // provider's matchesHost() is
 *                                          // deliberately wider than the set
 *                                          // of hosts it is safe to auto-mint
 *                                          // a push credential for (see
 *                                          // ./github.mjs). Omitted means
 *                                          // "matchesHost is already exactly
 *                                          // right for auth too", which is
 *                                          // the case for every anchored
 *                                          // matcher.
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
 *     buildProvisionArgs: (ctx) => { args, note? }|{ skip: true, note? }|{ error }   // OPTIONAL;
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
 *                                          // {{secret.NAME}} placeholder,
 *                                          // never a value -- resolution is
 *                                          // hub-side (see ./azure-devops.mjs).
 *                                          // ctx also carries the raw
 *                                          // `remoteUrl` the caller read and
 *                                          // `remoteReadError` (why it could
 *                                          // not be read, else null). An
 *                                          // optional `note` string next to
 *                                          // `args` is logged as an advisory,
 *                                          // never treated as a failure.
 *                                          // A THIRD answer, `{ skip: true }`,
 *                                          // means "nothing to provision for
 *                                          // this request -- proceed on the
 *                                          // credential already deployed":
 *                                          // for a provider whose credential
 *                                          // is deployed out of band and has
 *                                          // no scope axis to widen, a
 *                                          // just-in-time re-provision is
 *                                          // both impossible and pointless,
 *                                          // and failing it would abort the
 *                                          // call it exists to enable (see
 *                                          // ./bitbucket.mjs). Pair it with a
 *                                          // `note` so the skip is never
 *                                          // silent.
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
 *                                                // PR-comment actions: 'comment'
 *                                                // (create), 'list-comments',
 *                                                // 'update-comment' and
 *                                                // 'delete-comment'; a list
 *                                                // builder's mapResponse yields
 *                                                // [{ id, body, ref }] and
 *                                                // update/delete take that
 *                                                // `ref` as `comment_ref`.
 *     descriptionMaxLength: number        // OPTIONAL; text-limit axis. The
 *                                         //   longest PR description (chars)
 *                                         //   this provider is sent, with a
 *                                         //   margin under its real limit.
 *     commentMaxLength: number            // OPTIONAL; the same for one PR
 *                                         //   comment. Both are declared by
 *                                         //   every hosted provider; a
 *                                         //   classification-only provider
 *                                         //   (generic-git, dolt) has no PR
 *                                         //   text and declares neither.
 *     commentWebUrl: ({ response, ref, prUrl }) => string|null  // OPTIONAL;
 *                                         //   the browser link of one PR
 *                                         //   comment, from the comment
 *                                         //   create/update response or a
 *                                         //   list-comments item (`response`),
 *                                         //   its `ref`, and the PR's web
 *                                         //   URL; null when unknown. The
 *                                         //   overflow pointer links to it.
 *     httpFailureHint: (statusOrCtx) => string|{ hint, remedy }  // OPTIONAL;
 *                                         //   REST failure explanation.
 *                                         //   Called with a bare status
 *                                         //   (legacy; returns a diagnosis
 *                                         //   string, '' for none) or with
 *                                         //   { status, body, headers,
 *                                         //   availableSecrets, memberName,
 *                                         //   repoRef, repo, local? } --
 *                                         //   headers are the RESPONSE
 *                                         //   headers (lowercased names) a
 *                                         //   builder captured with curl
 *                                         //   `-D -`; availableSecrets is
 *                                         //   the credential-store name list
 *                                         //   (null when unreadable). The
 *                                         //   ctx form returns { hint,
 *                                         //   remedy }: `hint` diagnoses the
 *                                         //   failure from the response, and
 *                                         //   a non-empty `remedy` REPLACES
 *                                         //   authRemedy.hint for this one
 *                                         //   failure (lead with the one-line
 *                                         //   fix). Providers that ignore the
 *                                         //   ctx keep working: a string
 *                                         //   answer is used as the hint and
 *                                         //   the generic remedy stays.
 *     credentialProbe: {                  // OPTIONAL; preflight credential
 *       build: (params) => { command,     //   probe axis, only consulted for
 *         logSafeCommand, interpret },    //   a non-re-mintable provider
 *       expectedUsername?: string,        //   (authRemedy.serverSideReMintable
 *       remedy?: (ctx) => string          //   === false). With it, the VCS
 *     }                                   //   preflight (vcs-auth.mjs
 *                                         //   createVcsAuthPreflightCallback)
 *                                         //   judges two channels by function:
 *                                         //   git -- ls-remote origin through
 *                                         //   ONLY the provider-labelled fleet
 *                                         //   helper (host helper chain reset);
 *                                         //   PR -- `build`'s REST command
 *                                         //   through vcs_credential_exec with
 *                                         //   the provider label (params:
 *                                         //   repoRef, token = the
 *                                         //   {{vcs_token_inline}} placeholder,
 *                                         //   os, shell), the exact credential
 *                                         //   Publish PR reads. ok only if both
 *                                         //   pass; "No PR" is predicted only
 *                                         //   when the PR channel fails. A
 *                                         //   status inside
 *                                         //   interpret.successStatusRange
 *                                         //   whose body is an HTML sign-in
 *                                         //   page is still a refusal
 *                                         //   (classifyPrResponseBody below,
 *                                         //   shared by every provider).
 *                                         //   expectedUsername is the
 *                                         //   PREFERRED helper username= line
 *                                         //   (read member-side, token line
 *                                         //   never printed): a different one
 *                                         //   is one WARN, never a failure. A
 *                                         //   REST refusal is worded via
 *                                         //   httpFailureHint(ctx);
 *                                         //   `remedy(ctx)` (ctx:
 *                                         //   availableSecrets, memberName,
 *                                         //   repoRef, local, secretName) words
 *                                         //   the fix for every other failure.
 *                                         //   Omit it and the preflight probes
 *                                         //   with host-chain git ls-remote
 *                                         //   only, as before.
 *     findBeforeCreate: boolean,          // OPTIONAL; create is not an upsert.
 *                                         //   raiseVcsPrForMember runs
 *                                         //   find-pull-request first and
 *                                         //   updates a hit (PUT) instead of
 *                                         //   POSTing a duplicate.
 *     authRemedy: {                       // OPTIONAL; auth-self-heal axis
 *       serverSideReMintable: boolean,    //   (apra-fleet-5co8.4.2). Whether
 *       hint: string                      //   the REACTIVE self-heal callback
 *     }                                   //   (runner.js's
 *                                          //   createVcsAuthSelfHealCallback)
 *                                          //   can actually fix an
 *                                          //   auth-classified failure by
 *                                          //   calling provision_vcs_auth
 *                                          //   again on its own: true for a
 *                                          //   GitHub App installation token
 *                                          //   (minted fresh server-side
 *                                          //   every call) or a credential the
 *                                          //   fleet can otherwise regenerate
 *                                          //   without a human; false for a
 *                                          //   long-lived PAT/app password the
 *                                          //   fleet only ever stores and
 *                                          //   redeploys, never mints (see
 *                                          //   ./azure-devops.mjs) -- re-
 *                                          //   provisioning there just
 *                                          //   redeploys the SAME dead
 *                                          //   secret, so the self-heal
 *                                          //   attempt is expected to fail
 *                                          //   again. `hint` is the exact
 *                                          //   operator-facing remedy text
 *                                          //   printed alongside the self-
 *                                          //   heal attempt when
 *                                          //   `serverSideReMintable` is
 *                                          //   false, so a provider-specific
 *                                          //   literal never leaks into the
 *                                          //   shared runner.js caller.
 *                                          //   Omitting this hook (or
 *                                          //   omitting `serverSideReMintable`
 *                                          //   from it) means "assume
 *                                          //   re-mintable" -- the
 *                                          //   pre-existing GitHub/generic
 *                                          //   behavior, unchanged.
 *     permissionScope: {                  // OPTIONAL; permission-scope axis.
 *       rules: RegExp[],                  //   Patterns whose match means "the
 *       describe?: (raw) => string        //   identity was understood and the
 *     }                                   //   PRINCIPAL lacks the granted
 *                                          //   permission/scope for this
 *                                          //   operation". Two things follow
 *                                          //   from a match, and neither is
 *                                          //   expressible through `rules` +
 *                                          //   `precedence` alone:
 *                                          //   (1) the verdict is AUTH_DENIED
 *                                          //   OUTRIGHT, ahead of every kind
 *                                          //   in KIND_PRECEDENCE -- because
 *                                          //   a host's permission refusal
 *                                          //   usually arrives wrapped in the
 *                                          //   host's GENERIC rejection tail
 *                                          //   (for git: "failed to push some
 *                                          //   refs", which DIVERGED matches
 *                                          //   and which outranks AUTH), and
 *                                          //   reordering a whole provider's
 *                                          //   `precedence` to fix one rule
 *                                          //   would re-read every other
 *                                          //   ambiguous text too;
 *                                          //   (2) the failure is NOT
 *                                          //   self-healable -- re-minting the
 *                                          //   same principal's credential
 *                                          //   reproduces the same permission
 *                                          //   set, so runGitStep returns it
 *                                          //   immediately with no
 *                                          //   onAuthFailure call and no
 *                                          //   retry.
 *                                          //   `describe(raw)` returns the
 *                                          //   operator-facing referral
 *                                          //   (which resource, which missing
 *                                          //   permission, what an operator
 *                                          //   must grant) that travels on
 *                                          //   classifyFailure()'s
 *                                          //   `operatorReferral`, so the
 *                                          //   provider-specific wording never
 *                                          //   leaks into a shared caller.
 *                                          //   Omitting this hook means "this
 *                                          //   provider has no
 *                                          //   permission-scope rules" --
 *                                          //   every AUTH_DENIED it produces
 *                                          //   keeps today's self-heal
 *                                          //   treatment.
 *     ciGate: {                           // OPTIONAL; engine CI gate axis
 *       requiredPermission: string,       //   (../ci-gate.mjs). Lets the
 *       build(action, params),            //   orchestrator trigger and await
 *       isPermissionRefusal(status, text),//   a CI workflow run on the sprint
 *       parseBranchHead(body),            //   branch head. `build` returns a
 *       parseFindRuns(body, sha),         //   { command, logSafeCommand }
 *       parseRun(body),                   //   curl for one of 'branch-head',
 *       isRunComplete(run),               //   'find-runs', 'dispatch',
 *       isRunSuccess(run),                //   'get-run', 'list-jobs'; the
 *       parseJobs(body),                  //   parse hooks keep every REST
 *     }                                   //   field name in the provider.
 *                                          //   Omitted = no CI support:
 *                                          //   supportsCiGate() is false and
 *                                          //   a configured gate fails loudly
 *                                          //   naming the provider.
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
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`rules\` table.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
    }
    if (impl.extractProviderCode != null && typeof impl.extractProviderCode !== 'function') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function \`extractProviderCode\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
    }
    // apra-fleet-5co8.1.1: the host/URL-axis hooks. All OPTIONAL (a
    // classification-only provider declares none of them), but validated up
    // front for the same reason as `extractProviderCode` above -- a malformed
    // hook must fail at registration, not inside resolveVcsProviderForHost()
    // or a remote-URL preflight where the error would mask the real failure.
    for (const hook of ['matchesHost', 'matchesHostForAuth', 'capabilitiesForHost', 'parseRepoRef', 'buildProvisionArgs']) {
        if (impl[hook] != null && typeof impl[hook] !== 'function') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function \`${hook}\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
    }
    // apra-fleet-5co8.1.2: the remedy text quoted into a preflight ERROR. A
    // non-string here would land the literal 'undefined'/'[object Object]' in
    // an operator-facing error, so reject it at registration too.
    if (impl.repoRefHint != null && typeof impl.repoRefHint !== 'string') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-string \`repoRefHint\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
    }
    // apra-fleet-647.1.5.1: the two auth-backend fields folded in from
    // vcs-module.mjs's former BUILDERS/DEFAULT_AUTH_MODES tables. Both are
    // OPTIONAL (a classification-only provider like generic-git/dolt omits
    // them entirely -- see isAuthBackend() below), but validated up front,
    // same rationale as `rules`/`extractProviderCode` above.
    if (Object.prototype.hasOwnProperty.call(impl, 'defaultAuthMode') && impl.defaultAuthMode !== null && typeof impl.defaultAuthMode !== 'string') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-string, non-null \`defaultAuthMode\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
    }
    // apra-fleet-lzfv.4: the create-pull-request RESPONSE mapping. OPTIONAL
    // (a classification-only provider, or one with no PR builder, declares
    // none), but validated up front for the same reason as the hooks above --
    // a malformed mapping must fail at registration, not while reporting an
    // already-created pull request, where the error would mask a success.
    if (impl.pullRequestResponse != null) {
        const prr = impl.pullRequestResponse;
        if (typeof prr !== 'object') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`pullRequestResponse\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        if (typeof prr.idField !== 'string' || !prr.idField.trim()) {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`pullRequestResponse\` with no non-empty string \`idField\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        if (typeof prr.map !== 'function') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`pullRequestResponse\` with a non-function \`map\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        for (const field of ['webUrlField', 'webUrlTemplate']) {
            if (prr[field] != null && typeof prr[field] !== 'string') {
                throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`pullRequestResponse\` with a non-string, non-null \`${field}\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
            }
        }
    }
    // apra-fleet-5co8.4.2: the auth-self-heal remedy axis. OPTIONAL (omitting
    // it means "assume re-mintable", the pre-existing behavior), but
    // validated up front for the same reason as the hooks above -- a
    // malformed remedy must fail at registration, not while reporting an
    // already-failed self-heal attempt, where the error would mask the real
    // auth failure.
    // The text-limit axis: a positive integer when declared, so a typo can
    // never turn into an unbounded (or zero-length) PR description.
    for (const field of ['descriptionMaxLength', 'commentMaxLength']) {
        if (impl[field] != null && !(Number.isInteger(impl[field]) && impl[field] > 0)) {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-positive-integer ${field}.`);
        }
    }
    if (impl.authRemedy != null) {
        const remedy = impl.authRemedy;
        if (typeof remedy !== 'object') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`authRemedy\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        if (typeof remedy.serverSideReMintable !== 'boolean') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has an \`authRemedy\` with a non-boolean \`serverSideReMintable\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        if (typeof remedy.hint !== 'string' || !remedy.hint.trim()) {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has an \`authRemedy\` with no non-empty string \`hint\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
    }
    // The preflight credential-probe axis. OPTIONAL, validated up front for
    // the same reason as the hooks above: a malformed probe must fail at
    // registration, not inside a sprint preflight that never throws.
    if (impl.httpFailureHint != null && typeof impl.httpFailureHint !== 'function') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function httpFailureHint.`);
    }
    if (impl.commentWebUrl != null && typeof impl.commentWebUrl !== 'function') {
        throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function commentWebUrl.`);
    }
    if (impl.credentialProbe != null) {
        const probe = impl.credentialProbe;
        if (typeof probe !== 'object' || typeof probe.build !== 'function') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a credentialProbe with no build function.`);
        }
        if (probe.expectedUsername != null && (typeof probe.expectedUsername !== 'string' || !probe.expectedUsername.trim())) {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a credentialProbe with a non-string or empty expectedUsername.`);
        }
        if (probe.remedy != null && typeof probe.remedy !== 'function') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a credentialProbe with a non-function remedy.`);
        }
    }
    // The permission-scope axis. OPTIONAL (omitting it means "this provider
    // declares no permission-scope rules", i.e. today's behavior for every
    // AUTH_DENIED it produces), but validated up front for the same reason as
    // the hooks above: a malformed hook must fail at registration, not inside
    // classifyFailure() where the error would mask the very failure being
    // classified.
    if (impl.permissionScope != null) {
        const scope = impl.permissionScope;
        if (typeof scope !== 'object') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`permissionScope\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        if (!Array.isArray(scope.rules) || scope.rules.length === 0) {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`permissionScope\` with no non-empty \`rules\` array.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        for (const re of scope.rules) {
            if (!(re instanceof RegExp)) {
                throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-RegExp entry in \`permissionScope.rules\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
            }
            if (re.global) {
                throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a global (/g) entry in \`permissionScope.rules\` -- a /g regex carries lastIndex between calls and would make classifyFailure non-deterministic.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
            }
        }
        if (scope.describe != null && typeof scope.describe !== 'function') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a \`permissionScope\` with a non-function \`describe\`.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
    }
    if (impl.builders != null) {
        if (typeof impl.builders !== 'object') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object \`builders\` table.`); // shell-guard-allow: escaped backtick is markdown-style inline-code formatting in a thrown developer-facing Error message, never a shell command string -- shell-command-guard flags any literal backtick in any JS string, not just dispatched command-string arguments.
        }
        for (const [action, builder] of Object.entries(impl.builders)) {
            if (typeof builder !== 'function') {
                throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-function builder for action "${action}".`);
            }
        }
    }
    if (impl.ciGate != null) {
        if (typeof impl.ciGate !== 'object') {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a non-object ciGate.`);
        }
        for (const hook of CI_GATE_HOOKS) {
            if (typeof impl.ciGate[hook] !== 'function') {
                throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a ciGate with a non-function ${hook}.`);
            }
        }
        if (typeof impl.ciGate.requiredPermission !== 'string' || !impl.ciGate.requiredPermission.trim()) {
            throw new Error(`ERROR: VCSModule: provider "${impl.name}" has a ciGate with no non-empty string requiredPermission.`);
        }
    }
    registry.set(impl.name, impl);
    return impl.name;
}

/** Every function a provider's `ciGate` descriptor must declare (see the
 *  header's ciGate contract and ../ci-gate.mjs, its only consumer). */
const CI_GATE_HOOKS = Object.freeze([
    'build', 'isPermissionRefusal', 'parseBranchHead', 'parseFindRuns',
    'parseRun', 'isRunComplete', 'isRunSuccess', 'parseJobs',
]);

/**
 * The engine CI gate's provider capability flag: whether `impl` can trigger
 * and await a CI workflow run on a branch head (its descriptor declares a
 * `ciGate`). A provider without it (generic-git, bitbucket, azure-devops
 * today) makes a configured gate FAIL LOUDLY naming the provider -- never a
 * silent skip (see ../ci-gate.mjs).
 *
 * @param {object|undefined} impl
 * @returns {boolean}
 */
export function supportsCiGate(impl) {
    return !!impl && !!impl.ciGate && typeof impl.ciGate === 'object';
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

/**
 * The CREDENTIAL-PROVISIONING sibling of resolveVcsProviderForHost().
 *
 * Same dispatch, one deliberate difference: a provider that declares
 * `matchesHostForAuth` is asked THAT instead of `matchesHost`. Recognizing a
 * host for capabilities() ("could a PR be opened here?") is cheap to get
 * wrong -- the worst case is a PR attempt that fails. Recognizing it for auth
 * is not: the caller mints a real push credential and points it at the host,
 * so a substring matcher (see ./github.mjs's matchesHost, deliberately wide
 * for GitHub Enterprise Server) would hand that credential to any lookalike
 * domain containing the vendor name. Providers whose matcher is already
 * anchored (bitbucket, azure-devops) declare no separate hook and are
 * unaffected.
 *
 * Returns null rather than the generic-git catch-all: "no registered auth
 * backend claims this host" is the answer a provisioning caller needs, and a
 * catch-all descriptor there would read as a detection when it is a guess.
 *
 * @param {string|null} host
 * @returns {object|null} an auth-backend provider descriptor, or null.
 */
export function resolveVcsAuthProviderForHost(host) {
    for (const provider of [...registry.values()].reverse()) {
        if (provider.name === 'generic-git') continue;
        if (!isAuthBackend(provider)) continue;
        const matcher = typeof provider.matchesHostForAuth === 'function'
            ? provider.matchesHostForAuth
            : provider.matchesHost;
        if (typeof matcher === 'function' && matcher(host)) return provider;
    }
    return null;
}

// -----------------------------------------------------------------------------
// Provider-neutral PR response rule.
//
// A 2xx status alone does not prove a PR REST call did what it was asked to:
// a server (or a proxy in front of it) can answer an unauthenticated request
// with a 2xx HTML sign-in page -- e.g. HTTP 203 Non-Authoritative Information
// carrying a login form -- so "status in successStatusRange" read as "PR
// created" even though nothing was created. The rule below applies to every
// provider alike (never one copy per descriptor): a 2xx whose body is an HTML
// page or a sign-in page is an AUTH failure, and a 2xx whose body cannot be
// read as the expected JSON (no PR id/URL for a create, non-JSON text for a
// find/get/update) is a typed unexpected-response failure.
// -----------------------------------------------------------------------------

/** Typed reason for a 2xx PR response whose body is a sign-in/HTML page. */
export const PR_RESPONSE_SIGN_IN = 'pr-response-sign-in';
/** Typed reason for a 2xx PR response whose body maps to no PR (or is not JSON). */
export const PR_RESPONSE_UNMAPPED = 'pr-response-unmapped';

// The comment group is unambiguous (no overlapping lazy quantifier), and the
// inspected text is capped, so a hostile body cannot cause backtracking blowup.
const HTML_START_RE = /^(?:<\?xml[^>]*>\s*)?(?:<!--(?:[^-]|-(?!->))*-->\s*)*<(?:!doctype\s+html|html[\s>])/i;
const HTML_INSPECT_LIMIT = 2048;
const SIGN_IN_MARKER_RE = /\bsign[\s-]?in\b|\bsignin\b|\blog[\s-]?in\b|login\.microsoftonline\.com|_signin|id="?loginform|\bauthenticate to continue\b/i;

/**
 * Whether a response body is an HTML page or a sign-in page.
 * @param {string} bodyText
 * @returns {{ html: boolean, signIn: boolean }}
 */
export function classifyPrResponseBody(bodyText) {
    const text = String(bodyText ?? '').slice(0, HTML_INSPECT_LIMIT).trim();
    const html = HTML_START_RE.test(text);
    const signIn = html || (text !== '' && SIGN_IN_MARKER_RE.test(text) && !/^[[{]/.test(text));
    return { html, signIn };
}

// Token-shaped text: provider token prefixes, JWTs, Authorization schemes,
// key=value credentials, and any long opaque run of token alphabet.
const TOKEN_SHAPED_RES = [
    /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\b(?:access_token|refresh_token|id_token|token|password|passwd|pwd|secret|api[_-]?key|sig|code)=([^&\s"'<>]+)/gi,
    /\b(?:gh[pousr]_|github_pat_|glpat-|ATBB|ATATT|ATCTT|xox[abprs]-)[A-Za-z0-9_=-]{6,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g,
    /[A-Za-z0-9_+=-]{32,}/g,
];

/**
 * A short, log-safe excerpt of a response body: whitespace collapsed,
 * non-ASCII/control characters replaced, URL userinfo redacted (through the
 * caller's `redactUrl`, so the one URL-redaction rule is reused), every
 * token-shaped run replaced with `***`, then cut to `max` characters.
 * @param {string} bodyText
 * @param {{ max?: number, redactUrl?: (s: string) => string }} [opts]
 * @returns {string}
 */
export function prResponseExcerpt(bodyText, { max = 200, redactUrl } = {}) {
    let text = String(bodyText ?? '');
    if (typeof redactUrl === 'function') text = redactUrl(text);
    text = text.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (const re of TOKEN_SHAPED_RES) {
        text = text.replace(re, (m, value) => (typeof value === 'string' ? m.slice(0, m.length - value.length) + '***' : '***'));
    }
    const limit = Math.max(0, Math.min(200, Number(max) || 0));
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

/**
 * The typed failure for a 2xx PR response that did not do what it was asked:
 * `{ authFailure, reason, message, excerpt }`. `what` names the call
 * (e.g. 'create-pull-request'); the message carries the status and the
 * log-safe body excerpt, never the raw body.
 * @param {{ status: number|null, bodyText: string, what: string, redactUrl?: (s: string) => string }} ctx
 * @returns {{ authFailure: boolean, reason: string, message: string, excerpt: string }}
 */
export function unmappedPrResponseFailure({ status, bodyText, what, redactUrl }) {
    const { html, signIn } = classifyPrResponseBody(bodyText);
    const excerpt = prResponseExcerpt(bodyText, { redactUrl });
    const shown = excerpt ? `: ${excerpt}` : ' (empty body)';
    const statusText = `HTTP ${status ?? '(unknown)'}`;
    if (signIn) {
        return {
            authFailure: true,
            reason: PR_RESPONSE_SIGN_IN,
            message: `${what} answered ${statusText} with ${html ? 'an HTML' : 'a'} sign-in page instead of a pull request -- the request was not authenticated, so nothing was done (${PR_RESPONSE_SIGN_IN})${shown}`,
            excerpt,
        };
    }
    return {
        authFailure: false,
        reason: PR_RESPONSE_UNMAPPED,
        message: `${what} answered ${statusText} but the response does not identify a pull request, so it cannot be treated as done (${PR_RESPONSE_UNMAPPED})${shown}`,
        excerpt,
    };
}

for (const impl of BUILT_IN_PROVIDERS) registerVcsProvider(impl);

export { GenericGitVCS, GitHubVCS, DoltVCS, BitbucketVCS, AzureDevOpsVCS };
