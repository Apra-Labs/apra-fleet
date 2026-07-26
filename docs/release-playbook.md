# Release Playbook

How to cut a release. That's it.

## 1. Bump the version -- in both package.json AND version.json

Both files must be bumped together, in the same commit. This is not
optional: CI does NOT commit a version bump back to git for you. It only
injects the tag value into these files transiently, inside the release
runner, for the artifact it's building at that moment (see
`.github/workflows/ci.yml`, the "Inject version from tag" steps in the
`build-binary` and `npm-publish` jobs) -- that injected value is never
pushed back to the repo. If you skip this step, the committed
`version.json`/`package.json` stay stale for anyone building from source at
that commit.

```json
// package.json
"version": "0.3.6"
```

```json
// version.json
{ "version": "0.3.6" }
```

Commit the bump:

```bash
git add package.json package-lock.json version.json
git commit -m "chore: bump version to 0.3.6"
git push
```

## 2. Tag and push

Releases are tag-triggered. Pushing a `v*` tag kicks off the `release` job
in `.github/workflows/ci.yml`, which builds the binaries and creates the
GitHub release.

```bash
git tag v0.3.6
git push origin v0.3.6
```

## 3. Wait for CI

```bash
gh run list --workflow=ci.yml --branch v0.3.6 --limit 3
```

Wait until it shows `completed / success`.

## 4. Clean up the release notes

`generate_release_notes: true` makes GitHub auto-write draft notes from the
raw commit log the moment the release is created. Those are a placeholder,
not the final notes -- always replace them with a short, human-written
summary:

```bash
gh release view v0.3.6                 # see the auto-generated draft
gh release edit v0.3.6 --notes "..."   # replace with a clean summary
```

Keep the summary short: what changed and why. It's fine to leave GitHub's
"Full Changelog" link at the bottom for anyone who wants the raw commit diff.

Done.
