# Pull requests: GraphQL vs REST for GitHub App installation tokens

This is the long form of the note carried in
`fleet-sprint/vcs-providers/github.mjs` next to `CREATE_PR_GRAPHQL_REFUSAL`.
It exists so the asymmetry below does not live only in a review thread.

## The asymmetry

A GitHub App **installation token** that holds `pull_requests: write` can
create a pull request over REST:

```
POST /repos/{owner}/{repo}/pulls
```

and is commonly **refused** on the equivalent GraphQL mutation:

```
mutation { createPullRequest(...) }
```

The two surfaces do not grant the same thing for the same token. A token can
hold the permission and still be refused the mutation.

## Why that is a trap, not a footnote

The refusal GraphQL returns is:

```
GraphQL: Resource not accessible by integration (createPullRequest)
```

That reads exactly like "this credential is missing the `pull_requests`
permission". It is not. The consequences of believing it are expensive:

- The caller concludes that opening a pull request is impossible.
- It reports a permission block and stops.
- The supported REST route would have succeeded with the very same token.

That is a full review cycle burned, and it recurs every time a side branch
needs landing, because the misleading text is identical every time.

It is also the failure shape this project's guidance warns about explicitly:
an implicit environment detail (which credential type is in play) decides the
behaviour, and the failure is misleading rather than loud.

## What to use instead

Use the REST route. Everything in this package already does:

- `buildGitHubCreatePrCommand()` in
  `fleet-sprint/vcs-providers/github.mjs` builds the
  `POST /repos/{owner}/{repo}/pulls` request.
- `raiseVcsPrForMember()` in `fleet-sprint/vcs-auth.mjs` mints a
  just-in-time push+pr credential and dispatches that request through the
  server-side credential handoff, so the token never transits the caller.
- `fleet-se-pr` (`bin/open-pr.mjs`) exposes that same path for an
  **arbitrary head and base branch**, outside any sprint:

  ```
  fleet-se-pr --member my-dev-box \
              --base main \
              --head fix/some-side-branch \
              --title "fix: handle key rotation timeout"
  ```

  Run `fleet-se-pr --help` for the full argument list.

## Why `gh pr create` was retired here

`gh pr create` issues the GraphQL `createPullRequest` mutation. With a
fleet-minted installation token it therefore cannot work, and it fails with
the misleading text above. The `gh`-based PR path was removed from this
package for that reason; do not reintroduce it, and do not reach for it as a
manual fallback.

## How the refusal is classified now

`GitHubVCS.permissionScope` claims the refusal and describes it:

- `classifyFailure(raw, { provider: 'github' })` returns
  `kind: AUTH_DENIED`, `retryable: false`, `permissionScope: true`.
- `operatorReferral` names the REST route and `fleet-se-pr`, and states
  explicitly that this is **not** a missing `pull_requests` permission.
- `permissionScope: true` is what tells the self-heal gate that re-minting
  the same credential cannot help, so nothing retries.

The match is deliberately **narrow**. The bare string `Resource not
accessible by integration` is *not* claimed on its own, because GitHub
returns that same message for a genuine REST 403 where the token really is
missing `pull_requests: write`. Claiming it would replace a true "you lack
the permission" with a false "use REST instead". Every pattern additionally
requires a GraphQL pull-request mutation context: the mutation name, or the
`gh pr create` invocation that issues it.
