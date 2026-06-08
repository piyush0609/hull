# toss — agent guide

toss is a CLI that self-hosts HTML artifact sharing on Cloudflare Workers or
Vercel Edge (TypeScript/ESM, commander-based). This file orients an agent working
**in this repo**. To *use* the `toss` command itself, see `SKILL.md`.

## Commands
- `npm run build` — regenerate `src/version.ts`, compile TS, copy templates
- `npm test` — full vitest suite (run before pushing)
- `npm run dev` — run the CLI from source via tsx

## Conventions
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, …).
  The type drives the version bump and the changelog — keep every commit conventional.
- **`src/version.ts` is generated** from `package.json` by `scripts/genversion.mjs`.
  Never hand-edit it; change the version through a release, not by editing the file.
- Tests live in `tests/`; keep files focused.

## Releasing
**Follow `docs/RELEASE_MANAGEMENT.md`.** It is the canonical, order-dependent runbook
(bump → changelog → commit → tag → publish, plus rollback). Do not improvise a release —
use `npm run release:patch|minor|major`, which the runbook documents.

## ⚠️ Production guardrail
The Vercel production backend (`share.realfast.ai`, the `toss-team` project) may
**auto-deploy on push to `main`**. Never `git push` to `main` unless you intend to
deploy to production. Develop and test against a separate instance (`--profile test`),
never against prod.

## More
- `SKILL.md` — how to *use* toss (share, comments, profiles, tokens)
- `README.md` — overview, install, and backend setup
