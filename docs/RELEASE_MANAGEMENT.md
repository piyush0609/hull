# toss Release Management Guide

A self-contained runbook for cutting a toss release. No prior context needed.

## How versioning works

`package.json` `"version"` is the **single source of truth**. Everything else is
derived from it:

- **`src/version.ts`** is generated from `package.json` by `scripts/genversion.mjs`
  (runs automatically as the first step of `npm run build`). It exports `VERSION`,
  which `toss --version` and the skill installer import. Never hand-edit it.
- **Binaries** (`npm run build:bin` → `build.sh`) read the version from
  `package.json` and name the artifacts `toss-<version>-<platform>`.
- **The skill** (`SKILL.md`) is stamped with `version` on install, but skill
  *staleness* is decided by a content hash (`toss-hash`), not the version — see
  "Skill propagation" below.

So a release is fundamentally: **bump `package.json`, regenerate the derived
files, write a changelog, commit, tag.** The `release` scripts do all of it.

## Commit convention

Changelog sections come from [Conventional Commits](https://www.conventionalcommits.org/)
prefixes. Use them on every commit:

| Prefix | Changelog section | Implies |
|--------|-------------------|---------|
| `feat:` | Features | minor bump |
| `fix:` | Bug Fixes | patch bump |
| `perf:` | Performance | patch bump |
| `refactor:` / `docs:` | Refactoring / Documentation | — |
| `test:` / `chore:` / `ci:` | hidden from changelog | — |

A breaking change adds a `!` (`feat!:`) or a `BREAKING CHANGE:` footer → major bump.

> There is no commit-lint git hook — the convention is enforced by habit and
> review, not tooling. Keep commits conventional so the changelog stays useful.

## Cutting a release

Prerequisites: on `main`, working tree clean, `npm test` green.

```bash
npm test                 # all green
npm run release:patch    # 0.1.0 -> 0.1.1   (bug fixes)
# or
npm run release:minor    # 0.1.0 -> 0.2.0   (new features)
npm run release:major    # 0.1.0 -> 1.0.0   (breaking changes)
# or, to let it infer the bump from commit history:
npm run release
```

Each `release:*` passes an explicit `--release-as`, so the bump is intentional and
never a surprise. `commit-and-tag-version` (invoked via `npx --yes`, no permanent
dependency) then:

1. bumps `"version"` in `package.json` (+ `package-lock.json`),
2. runs the `postbump` hook from `.versionrc.json`
   (`node scripts/genversion.mjs && git add src/version.ts`) so the regenerated
   SSOT is part of the very same commit,
3. updates `CHANGELOG.md` from the conventional commits since the last tag,
4. creates a release commit and a `vX.Y.Z` git tag.

## Publishing the release

`commit-and-tag-version` only commits and tags **locally**. Push deliberately:

```bash
git push --follow-tags origin main
```

> ⚠️ **Production deploy caution.** The Vercel prod backend (`share.realfast.ai`)
> may auto-deploy on push to `main`. The release commit only touches CLI files
> (no `src/templates/vercel/**` changes), so a version bump alone is safe — but
> confirm what's in the push if your release also carries backend changes.

### Binaries (optional)

```bash
npm run build:bin        # writes toss-<version>-<platform> for all targets
```

Attach the artifacts to the GitHub release for the new tag if you distribute
binaries. (Note: `dist-bin/` is gitignored and not committed.)

## Skill propagation

Installed skills re-sync by **content hash**, not version. After a release that
changed `SKILL.md`, users run:

```bash
toss skill update          # re-stamps every installed skill whose content changed
```

A version bump that did **not** change `SKILL.md` will *not* churn installs — the
`toss-hash` is unchanged, so `skill update` reports "already up to date".

## Update notifications

`toss` shows a one-line "update available" banner (to stderr) when a newer tag
exists on GitHub. It is TTY-only (never pollutes piped/JSON output or agent runs),
cached for 24h in `~/.toss/update-check.json`, and fail-open. Users silence it with
`TOSS_NO_UPDATE_CHECK=1`. Nothing to do at release time — publishing the tag is what
triggers it.

## Rollback

If a release commit is wrong and **not yet pushed**:

```bash
git tag -d vX.Y.Z            # delete the local tag
git reset --hard HEAD~1      # drop the release commit
```

If already pushed, cut a new corrective release (`fix:` + `npm run release:patch`)
rather than rewriting published history.
