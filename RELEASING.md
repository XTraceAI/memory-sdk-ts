# Releasing `@xtraceai/memory`

Releases are **published manually from a local machine**. There is no CI/GitHub
Action, no release-please, and no Stainless step — any such config in git history
is **legacy and unused**. **npm `latest` is the source of truth** for what's
actually released (git tags are just bookkeeping).

## Steps

1. **Start from a clean, green `main`:**
   ```bash
   git checkout main && git pull
   ```

2. **Bump the version in `package.json`, commit, and push.** This is a *file*
   edit — a bare `git commit -am` reports "nothing to commit" if you skip it.
   Let npm do the edit (no tag yet — we tag after publishing):
   ```bash
   npm version 0.2.1 --no-git-tag-version      # edits package.json only
   git commit -am "release: v0.2.1"
   git push origin main
   ```

3. **Confirm you're logged in as the right npm account.** `npm whoami` only
   tells you *someone* is logged in — make sure it's `tristangc` (the `@xtraceai`
   maintainer), not a different cached account, or the next `npm publish` runs
   under / fails on the wrong user:
   ```bash
   npm whoami                                  # must print: tristangc
   # if it prints a different user (or errors):
   npm logout && npm login                     # browser OAuth — log in as tristangc
   ```

4. **Publish — the real, irreversible step.** The `prepublishOnly` hook runs
   `typecheck → test → build` first and aborts if any fail. `--access public` is
   required because the package is scoped (`@xtraceai/…`).
   ```bash
   npm publish --access public
   npm view @xtraceai/memory version           # confirm → 0.2.1
   ```

5. **Tag the release commit — _only after_ npm confirms the version.** Tagging
   before a successful publish is how tags get orphaned (a `vX.Y.Z` tag pointing
   at a version that never shipped).
   ```bash
   git tag v0.2.1 && git push origin v0.2.1
   ```

## Notes

- **Versioning** (pre-1.0): breaking changes bump the minor (e.g. removing a
  method). Call out breaking changes in the PR / release notes.
- The **`prepublishOnly` gate** in `package.json` is the safety net — a red
  typecheck/test/build means nothing ships.
- Tag format is `vX.Y.Z`, on the `release: vX.Y.Z` commit, matching
  `package.json` exactly.

## Troubleshooting

- **`403 … cannot publish over the previously published version`** — you didn't
  bump `package.json` (step 2); it still matches what's on npm. Bump and re-publish.
- **`fatal: tag 'vX.Y.Z' already exists`** — a stale *local* tag from a prior
  attempt. Delete and recreate it on the current release commit:
  ```bash
  git tag -d vX.Y.Z && git tag vX.Y.Z          # recreates on HEAD
  ```
- **Remote tag points at the wrong commit** (e.g. one commit before the bump) —
  cosmetic, but to fix, force-update it to the release commit:
  ```bash
  git tag -f vX.Y.Z origin/main && git push -f origin vX.Y.Z
  ```
- **npm has the version but the git tag is missing/old** — npm `latest` is the
  source of truth, so the package is fine; just (re)create the tag per above.
