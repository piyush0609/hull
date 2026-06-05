---
title: Version + changelog process & agent harness for toss
type: chore
status: active
date: 2026-06-05
---

# 🛠️ Version + changelog process & agent harness

## Overview

Give `toss` **one source of truth for its version**, an **automated conventional-commits → version-bump + CHANGELOG** flow, **reliable skill propagation**, a **runtime "you're outdated" check**, and — the point of it all — **one canonical, unambiguous document an AI agent reads to version/changelog/ship without looping or guessing.** Explicitly *not* a heavy release pipeline: distribution stays "install from `main`," binary publishing is out of scope.

## ⚡ Enhancement Summary (deepened 2026-06-05)

Six review lenses (simplicity, architecture, TypeScript, security, agent-native parity) + an impl deep-dive. They **cut scope and fixed a security bug** — apply these over the original sections below.

### 🔴 Scope cut — ship a tight MVP (1–2 phases, not 5)
Simplicity + architecture + your own "manage version + changelog, *not* a heavy release; onboarding is simpler" all converge. **MVP (keep):**
1. **§A** generated `src/version.ts` (single source).
2. **§E** content-hash skill sync — *trimmed* (drop the user-edit guard; plain body-hash).
3. **§C** `commit-and-tag-version` invoked with **explicit `--release-as <level>`** — the user/agent picks the bump; the changelog is auto-generated from conventional commits.
4. **§D** `commitlint` + `simple-git-hooks` — enforce conventional-commit *format* (changelog quality), advisory.
5. **§F** update-check banner — *kept* (outdated-awareness in scope) but minimal.
6. **§I** `docs/RELEASING.md`.
7. delete stale `dist-bin/hull-0.1.0-*` (one `rm`, ~480 MB).

**DEFERRED (revisit only on a concrete need — each is something your framing already argued against):**
- **§B deploy-time template stamping + §G CLI↔server skew check** (a *pair*) — entirely net-new infra (the CLI has **no** `/version` client method today), justified by a hypothetical; and §G would **false-positive on every existing tenant** until they redeploy. For a solo operator the answer to "is my server behind?" is "redeploy."
- **§H SessionStart hook** — redundant third awareness channel (doc + banner already cover it) and it expands the buggy `skill install` into a hook-installer.

(**§D commitlint + simple-git-hooks is KEPT in v1** — you chose enforced conventional-commit format for changelog quality. It's advisory; the deterministic gate is the explicit `--release-as`, and the agent pre-checks with `echo "msg" | npx commitlint`, never `--no-verify`.)

### 🔴 Security + TS — `genversion` must not be a string-eval (CRITICAL)
The `node -e` one-liner interpolates the version into generated TS source **that ships inside the binary** — a malformed/crafted version string = code execution at every build. It's also CJS-in-an-ESM-project, untestable, and triple-quoted. **Fix:** a committed `scripts/genversion.mjs` (ESM) that reads `package.json`, **validates `version` against a strict semver regex** (fail the build otherwise), and writes via `JSON.stringify(version)` (no interpolation). The single control — *validate version/tag as semver at the boundary; emit generated source/JSON via serializers, never string-interpolation* — also defuses the (now-deferred) hook's tag-injection vector.

### 🔴 Real contradiction — committed `version.ts` vs the clean-tree precondition
We commit `version.ts` **and** regenerate it on every `build` → the working tree is dirty after every build, which trips the harness's own "bump only on a clean tree" precondition (Decision #11). **Fix:** make `genversion` **idempotent** — skip the write if the bytes are identical — so a build with no version change leaves the tree clean. Also run `genversion` in the **release** step so the bump commit includes the regenerated file (no lag between `package.json` and `version.ts`).

### 🟠 Corrections to bake in
- **Version increment is always an explicit decision** (user or agent), never auto-derived from commit types — *"auto-deciding is something we don't want now."* Every release is `npm run release -- --release-as <patch|minor|major>`; `commit-and-tag-version` generates the **CHANGELOG** from conventional commits, but the version *number* is chosen, not computed. This **dissolves the 0.x problem** entirely (no `.versionrc`/`prebump`-demotion script needed). Non-conventional commit subjects (squash `Merge PR #N`) drop from the changelog but don't break the run — surface them in the doc.
- **One shared frontmatter helper** for `injectVersion`/`extractVersion`/hash (three regexes today) + a **round-trip test** `extractBody(injectVersion(x)) === extractBody(x)`, and normalize before hashing (strip `version:` line, CRLF→LF, `trimEnd` per line, single trailing newline) so the `dist` path and the `raw.githubusercontent` fallback hash identically.
- **Update-check typing:** validate GitHub JSON with a typed guard (not a cast); add a **tested `compareSemver`** (no `semver` dep) — `"0.10.0" > "0.9.0"` is the classic string-compare bug; validate `latest` as semver at the cache write/read boundary; place the kickoff in a `program.hook('preAction')` after switching `index.ts` to `parseAsync()` (today it's a bare sync `program.parse()`).
- **SSOT is two mechanisms, by design:** `tsconfig` excludes `src/templates`, so templates can't `import version.ts` — that's *why* §B needs string-stamping. With §B deferred, the CLI's single-source story is clean; just **don't** try to `import version.ts` into a template.

### 🟢 Agent-loop-proofing — `docs/RELEASING.md` must be SELF-CONTAINED (the core ask)
The agent-native review found ~4 guaranteed loop points because the plan deferred the doc's *contents* to "documented in the doc." The doc must literally contain:
1. **One canonical deploy command:** `toss admin deploy --profile <name>` (a **hidden** `toss deploy` alias exists — never use it in automation).
2. **Full bump preamble:** decide the level (`patch`/`minor`/`major`) → `git checkout main && git pull --ff-only` → assert clean + on `main` (else ABORT with the exact message) → `npm run release -- --release-as <level> --dry-run` → `npm run release -- --release-as <level>` → `git push --follow-tags origin main` (+ what to do if `main` is protected).
3. **Choosing the level** (the rule the agent applies, since it's explicit): fix→`patch` · feature→`minor` · breaking while <1.0→`minor` · breaking at ≥1.0→`major`. Never hand-edit `package.json` to bump.
4. **Skill-sync output interpretation:** `✓ Updated N skill(s)` = propagated; `All installed skills are at vX` after a body edit = it did **not** (and requires the §E content-hash fix to be live first) + a `diff` verify line. ⚠️ **This step is only correct after §E ships** — gate it.
5. **Consistency verify command** (one line asserting `toss --version` == `package.json` and no stray version literals in `src/`).
6. **First-release clarity:** `v0.1.0` already exists, so the next release is a **normal** `npm run release`, **not** `--first-release`.
7. **"How a bump flows"** inlined (which command moves which site) so the agent never has to open `package.json`/`build.sh` to reason about a release.

## Problem Statement

Today the version is hand-duplicated across **8 independent sites**, all frozen at `0.1.0`, with **zero shared source**:

| # | Site | File |
|---|---|---|
| 1 | npm version | `package.json:3` |
| 2 | CLI `--version` | `src/index.ts:84` (literal) |
| 3 | Skill version | `src/commands/skill.ts:7` (`const VERSION`) |
| 4 | Vercel template pkg | `src/templates/vercel/package.json:3` |
| 5 | Vercel server `/version` | `src/templates/vercel/api/index.ts:1118` |
| 6 | Worker server `/version` | `src/templates/worker/src/index.ts:2228` |
| 7 | Git tag | `v0.1.0` (stale — points at an old commit) |
| 8 | Standalone binaries | `dist-bin/hull-0.1.0-*` (stale, pre-rename, never rebuilt) |

Consequences (all evidence-confirmed):
- **Skill edits never propagate.** `skill.ts` gates install/update purely on `installedVer === VERSION` (lines 176/232/326), and `injectVersion` stamps the installed file with that same frozen constant — so content-only edits to `SKILL.md` are structurally invisible (no hash/mtime/byte compare).
- **No agent harness exists.** No repo `CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING`/`RELEASING`, no `.github` CI, no SessionStart hook. Nothing tells an agent how to version, changelog, or ship — so it loops figuring it out (the exact pain reported).
- **"Latest" is ambiguous.** `install.sh` source path tracks `main` HEAD; its binary path assumes a GitHub Release that was never cut; the `v0.1.0` tag gates nothing. Three notions of "current."
- **CLI↔server skew is invisible.** The deployed server self-reports `0.1.0` at `GET /version`, but nothing compares it to the CLI — so a tenant on old server templates + a newer CLI calling new routes (e.g. the **comments** endpoints) fails silently.

## Decisions (from user + research)

> **⚠️ Scope superseded by the Enhancement Summary (above):** the version *number* is chosen explicitly via `--release-as` (conventional-commits automation applies to the **changelog**, not the number); **commitlint is kept**; **§B template stamping (Decision 6), the skew half of Decision 8, and §H are DEFERRED.** Below is the original draft, retained for reference.

1. **Bump discipline:** conventional commits drive the **changelog**; the version *number* is an explicit `--release-as` decision (user/agent), not auto-derived.
2. **Release shape:** *not* a heavy release — "manage version + changelog," distribution stays install-from-`main`. **Binary publishing is out of scope.**
3. **Outdated-version awareness:** in scope.
4. **Tool:** **`commit-and-tag-version`** (maintained `standard-version` fork) — "bump + regenerate `CHANGELOG.md` + git tag, nothing else," CI-optional, never pushes/publishes. **Always invoked with `--release-as <level>`** so the version is explicit (auto-derivation off); commits drive only the changelog. (Rejected: `release-please`/`semantic-release` force GitHub/CI/publish; `changesets`' intent-files are redundant given conventional commits.)
5. **Single source of truth:** a **generated `src/version.ts`** written from `package.json` at build time; `index.ts` + `skill.ts` import it; the **standalone binary needs build-time injection** (it has no sibling `package.json` at runtime — runtime reads break the binary path). This collapses sites #2, #3, and the binary into one.
6. **Server template versions (#4–6):** stamped from the CLI's version **at `toss deploy` time** (so a tenant truthfully reports which toss version deployed it) — enables the skew check.
7. **Skill propagation:** **content hash** (sha256 of body), write only on mismatch — independent of version. Optionally track last-written hash to avoid clobbering user edits.
8. **Two distinct "latest" authorities:** **git tags** = "is my CLI/skill behind" (update check); **server `GET /version`** = "is my *deployed instance* behind my CLI" (skew check). Both documented, never conflated.
9. **Commit enforcement:** `commitlint` + `simple-git-hooks` (commit-msg), rules at **level 2 (error)** — but treated as an *agent feedback signal*, not a security boundary. The agent pre-checks with `echo "msg" | npx commitlint` and **never uses `--no-verify`**.
10. **0.x semantics:** while `< 1.0`, a breaking change bumps **minor** (`0.x.0`), not major — encode it so the tool can't promote to `1.0.0` on the first `feat!`.
11. **Preconditions (kills the #1 agent loop):** version bumps happen **only on `main`, clean working tree, after merge.** The harness doc leads with a `git status --porcelain` + branch check that aborts with a specific message.
12. **Canonical harness doc:** **`docs/RELEASING.md`** — the single place with the deterministic command sequence + preconditions. `SKILL.md`/`README` link to it; nothing duplicates it.
13. **Cleanup:** delete the stale gitignored `dist-bin/hull-0.1.0-*`; document **source-from-`main`** as the supported install; note the binary install path needs a Release cut only if ever re-enabled.

## Technical Approach

### A. Single source of truth — generated `version.ts`
```jsonc
// package.json scripts (prepend genversion to build)
"scripts": {
  "genversion": "node scripts/genversion.mjs",  // committed ESM script: semver-validate version → JSON.stringify → write ONLY if changed (idempotent). NOT a node -e string (ships in the binary; see Enhancement Summary §Security).
  "build": "npm run genversion && tsc && rm -rf dist/templates && cp -r src/templates dist/templates && cp SKILL.md dist/SKILL.md"
}
```
- `src/index.ts:84` → `import { VERSION } from './version.js'; program.version(VERSION)`.
- `src/commands/skill.ts:7` → `import { VERSION } from '../version.js'`.
- **Commit `src/version.ts`** (greppable without a build, agent-friendly) and add it to `.gitignore`? No — commit it. Regenerated on every `build`, so it can't drift.
- **Binary** (`build.sh`, `bun build --compile`): the imported `version.ts` constant is bundled automatically → `--version` correct for free. Filename: `VERSION=$(node -p "require('./package.json').version")` → `toss-${VERSION}-<platform>` (build.sh already does this; it's correct once we stop hand-editing).

### B. Server template versions stamped at deploy — ⏸️ DEFERRED
The three template version literals (`vercel/package.json:3`, `vercel/api/index.ts:1118`, `worker/src/index.ts:2228`) are stamped from the CLI's `VERSION` during `toss deploy` (write into the copied deploy dir before pushing). A deployed instance's `GET /version` then reports the toss version that deployed it.

### C. Conventional commits → version + CHANGELOG
```jsonc
// package.json
"commit-and-tag-version": { "bumpFiles": [ { "filename": "package.json", "type": "json" } ] },
"scripts": { "release": "commit-and-tag-version" }
```
- Agent flow: `npx commit-and-tag-version --dry-run` → review → `npx commit-and-tag-version` → `git push --follow-tags`. First release: `--first-release`.
- 0.x policy encoded via config (breaking → minor) so it never jumps to 1.0.0 prematurely.

### D. Commit enforcement (advisory, agent-deterministic)
```jsonc
// package.json
"devDependencies": { "@commitlint/cli": "^19", "@commitlint/config-conventional": "^19", "simple-git-hooks": "^2" },
"simple-git-hooks": { "commit-msg": "npx --no -- commitlint --edit \"$1\"" }
```
```js
// commitlint.config.js
module.exports = { extends: ['@commitlint/config-conventional'] };
```
Grammar the agent must follow (documented in `docs/RELEASING.md`): `type(scope): description` · types `feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert` · lowercase, imperative, no trailing period, header ≤100 · breaking = `feat!:` / `BREAKING CHANGE:` footer. **Type choice = the version bump.** Pre-check: `echo "feat(share): add x" | npx commitlint`.

### E. Content-hash skill propagation (`skill.ts`)
Replace the version-equality gate with a sha256 content compare:
```ts
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// install/update: write only if installed body hash !== bundled body hash (version line stripped)
```
- Hash the **body** (strip the injected `version:` frontmatter line) so the version stamp doesn't mask content equality.
- Optional: stash last-written hash → if installed ≠ last-written ≠ bundled, the **user edited it** → warn instead of clobber.
- Binary install path: `getSkillContent` already falls back to fetching `SKILL.md` from `main` — hash those bytes the same way.

### F. Update check (CLI banner) — fail-open, TTL, opt-out
```ts
// at CLI start, non-blocking, swallow all errors; skip if TOSS_NO_UPDATE_CHECK || CI || !stdout.isTTY
// cache {latest, checkedAt} in ~/.cache/toss/update-check.json, TTL 24h, fetch timeout 1.5s
// source: GET https://api.github.com/repos/piyush0609/toss/tags  → [0].name (strip 'v')
// if semverGt(latest, VERSION) → stderr banner "toss <latest> available (you have <VERSION>)"
```
- **Fail open** on offline/timeout/403; first run primes cache quietly; banner to **stderr** only.

### G. CLI↔server skew check (relevant to comments) — ⏸️ DEFERRED
On commands that hit the server (`list`, `share`, comment ops), compare `GET /version` to `VERSION`; **warn on mismatch**: "your deployed toss is vX; CLI is vY — run `toss admin deploy` to update server." Reuses the server `/version` that already exists.

### H. SessionStart hook (agent awareness) — ⏸️ DEFERRED
`.claude/settings.json` + `.claude/hooks/toss-version.sh` that injects `hookSpecificOutput.additionalContext` (reads the CLI's cache file, not a fresh GitHub call, to spare the 60 req/h unauth limit). Fail-open, exit 0 always. Installed for `claude-code` by `toss skill install` (project + user level).

### I. `docs/RELEASING.md` — the canonical harness (the deliverable)
One file, deterministic, **preconditions first**:
1. **Preconditions:** on `main`, `git status --porcelain` empty, after merge — else abort.
2. **Commit grammar** (the agent's contract) + pre-check command.
3. **Cut a version:** `npm run release -- --dry-run` → review → `npm run release` → `git push --follow-tags`.
4. **Sync the skill:** `npm run build && toss skill update` (content-hash, always propagates).
5. **How versions flow** (one source → all sites), the two "latest" authorities, the update-check opt-out.
`SKILL.md` gains a `## Releasing` pointer to it; `README` links it.

## Implementation Phases (revised — MVP; supersedes the 5-phase draft)

**Phase 1 — Single source of truth.** Committed `scripts/genversion.mjs` (ESM, semver-validated, `JSON.stringify`, **idempotent** — no write if bytes identical) → `src/version.ts`; run it in `build` (prebuild) **and** in the release step; rewire `index.ts:84` + `skill.ts:7` to `import { VERSION }`; delete the CLI-side literals; verify `bun --compile` binary `--version`. (Server-template literals left as-is — §B deferred.)

**Phase 2 — Content-hash skill sync.** One shared frontmatter helper feeding `injectVersion`/`extractVersion`/hash; replace the 3 `=== VERSION` gates (`skill.ts:176/232/326`) with a **normalized body-hash** compare (strip `version:` line, CRLF→LF, `trimEnd`, single trailing `\n`); round-trip test. No user-edit guard. → `toss skill update` now propagates content edits.

**Phase 3 — Conventional commits + CHANGELOG + update-check + the doc.**
- `commit-and-tag-version` invoked **always with explicit `--release-as <level>`** (user/agent picks; no auto-derivation); `commitlint` + `simple-git-hooks` (commit-msg, advisory) enforce conventional format for changelog quality; seed `CHANGELOG.md` from `v0.1.0..HEAD`; `npm run release` (no push/publish).
- Update-check: switch `index.ts` to `parseAsync()` + `program.hook('preAction')`; GitHub **tags**, typed JSON guard, tested `compareSemver`, semver-validated cache, fail-open / 24h TTL / `TOSS_NO_UPDATE_CHECK` / `!isTTY` / `CI` opt-outs, stderr banner.
- Write **`docs/RELEASING.md`** — self-contained per the loop-proofing list in the Enhancement Summary.
- `rm -rf dist-bin/hull-0.1.0-*`; one line in the doc: install is source-from-`main`.

**Deferred (separate, revisit only on a concrete trigger):** §B template stamping + §G CLI↔server skew check (as a pair — net-new client infra + false-positives until tenants redeploy); §H SessionStart hook (redundant with banner+doc). See Enhancement Summary for each. (§D commitlint is **kept**.)

## Acceptance Criteria

### Functional
- [ ] `toss --version`, the skill's stamped version, and `package.json` are always equal (one source); bumping `package.json` (via the tool) moves all of them.
- [ ] The `bun --compile` binary prints the correct `--version` with no hand-edit.
- [ ] Editing `SKILL.md` body (no version bump) and running `toss skill update` **propagates** the change to installed copies.
- [ ] `npm run release -- --release-as <level>` sets the chosen version, regenerates `CHANGELOG.md` from conventional commits, commits `chore(release): x.y.z`, tags `vx.y.z`, and does **not** push or publish.
- [ ] The version *level* is an explicit decision (no auto-derivation); the agent applies the documented rule (fix→patch · feat→minor · breaking-<1.0→minor · breaking-≥1.0→major).
- [ ] A non-conventional commit is rejected locally by commitlint with a parseable reason; the agent can pre-check with `echo … | npx commitlint` without committing.
- [ ] `toss` warns (stderr, once/24h) when a newer git tag exists; honors `TOSS_NO_UPDATE_CHECK`; never errors offline.
- [ ] `docs/RELEASING.md` is the single canonical procedure; SKILL.md links it; running it from a dirty tree / non-`main` branch aborts with a specific message.

### Quality Gates
- [ ] Unit tests: `genversion` (valid/invalid semver + idempotent no-op); content-hash staleness (changed/unchanged) + frontmatter round-trip (`extractBody(injectVersion(x)) === extractBody(x)`); `compareSemver`; update-check fail-open + TTL + opt-out (mock fetch). `tsc` clean; `vitest` green.
- [ ] No remaining hardcoded version literal in `src/` (grep gate).

## Alternatives Considered
- **Runtime `package.json` read** (import attributes / `createRequire`): clean for npm/source, **breaks the standalone binary** (no sibling `package.json`). Rejected for build-time `version.ts`.
- **`release-please` / `semantic-release`:** force GitHub API/CI/publish — the ceremony explicitly rejected.
- **`changesets`:** intent-files redundant with conventional commits for a single-package agent repo.
- **Version-gated skill propagation:** misses same-version body edits — the exact failure to fix.
- **In-scope binary publishing + GitHub Releases:** out of scope per "onboarding is simpler"; delete stale artifacts instead.

## Risks & Edge Cases (from spec-flow)
- **C2 binary SSOT:** binary can't read `package.json` at runtime → build-time `version.ts` injection is mandatory (covered).
- **C4 non-conventional commits in history** (every squash `Merge PR #N`): tool scans `<last-tag>..HEAD`; non-conforming = ignored for version math but **listed as a warning** (nothing silently dropped). Pick **squash-merge with a conventional title**.
- **I1 dirty/branch bump:** preconditions check (covered) — top loop-risk killed.
- **I4 update-check offline/rate-limit/first-run:** fail-open, cached, short timeout, opt-out (covered).
- **I5 commitlint blocking agent:** advisory + documented grammar + "fix-and-recommit, never `--no-verify`" (covered).
- **dist drift direction:** `dist/` is gitignored and propagation is `main`-based — so the agent must **`git push` to `main`** before installs pick up skill edits; `dist/` can be *ahead* of `main`. State this in `docs/RELEASING.md`.
- **M3 tag-vs-package baseline:** after bump, assert `tag == package.json version`; fail loudly if a prior manual edit broke the invariant.
- **`package-lock.json`** version: `commit-and-tag-version` updates root `package.json` + lock automatically. The template `vercel/package.json` is a *server* version literal — left as-is in v1 (§B stamping deferred).

## Testing Plan
- Unit (vitest): `genversion` (valid/invalid semver, idempotent no-op), content-hash staleness + frontmatter round-trip, `compareSemver`, update-check (mocked fetch: success/offline/403/cache-hit/opt-out).
- Manual: `bun build --compile` → run binary `--version`; edit `SKILL.md` → `toss skill update` propagates; `npm run release -- --release-as patch --dry-run` on a branch with mixed conventional/non-conventional commits.
- No production/tenant impact — this is local tooling. (Server-template stamping + skew check are deferred, so no `toss-test` deploy is needed for v1.)

## Documentation Plan
- New `docs/RELEASING.md` (canonical). `SKILL.md` `## Releasing` pointer. `README` link. Optional `CONTRIBUTING.md` stub → links RELEASING.

## Sources & References
### Internal (file:line)
- Version sites: `package.json:3`, `src/index.ts:84`, `src/commands/skill.ts:7`, `src/templates/vercel/package.json:3`, `src/templates/vercel/api/index.ts:1118`, `src/templates/worker/src/index.ts:2228`
- Skill gates: `src/commands/skill.ts:176,232,326`; inject/extract `:103-119`; GitHub fallback `:8`
- Build/binary: `package.json` scripts, `build.sh` (`bun build --compile`, version→filename); `install.sh:9,66,133-138`
### External (best practices)
- [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) · [Conventional Commits](https://www.conventionalcommits.org/) · [commitlint local setup](https://commitlint.js.org/guides/local-setup.html) · [simple-git-hooks vs husky (2026)](https://www.andymadge.com/2026/03/10/git-hooks-comparison/)
- [Node SEA](https://nodejs.org/api/single-executable-applications.html) · [Bun single-file executables](https://bun.com/docs/bundler/executables) · [ESM JSON import attributes](https://nodejs.org/api/esm.html)
- [update-notifier](https://github.com/sindresorhus/update-notifier) · [vercel/update-check](https://github.com/vercel/update-check) · [NO_UPDATE_NOTIFIER](https://github.com/npm/cli/issues/3470) · [Claude Code hooks](https://code.claude.com/docs/en/hooks)
### Provenance
Three research passes (repo internals, spec-flow gaps, 2026 best practices) + user decisions 2026-06-05 (conventional-commits automation; "manage version + changelog, not a heavy release"; outdated-awareness in scope).
