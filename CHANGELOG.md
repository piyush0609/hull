# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.2.3](https://github.com/piyush0609/toss/compare/v0.2.2...v0.2.3) (2026-06-08)


### Features

* **share:** folder shares take --id, render correctly, reconcile on re-share ([ff0f166](https://github.com/piyush0609/toss/commit/ff0f1665aa7eef95f12ad6000f5e3f1513ba59af))

## [0.2.2](https://github.com/piyush0609/toss/compare/v0.2.1...v0.2.2) (2026-06-08)


### Bug Fixes

* **deploy:** treat promote 409 (already current) as success, not a warning ([08bfb79](https://github.com/piyush0609/toss/commit/08bfb79c0484d8b47c6f3ec965be7a94f7d70903))

## [0.2.1](https://github.com/piyush0609/toss/compare/v0.2.0...v0.2.1) (2026-06-08)


### Bug Fixes

* **deploy:** auto-promote to current production + preserve custom-domain endpoint ([7b5e097](https://github.com/piyush0609/toss/commit/7b5e0973b03a4a6022ce87c32c8ffb1619e9d087))


### Documentation

* add AGENTS.md routing agents to the release runbook ([7591dd6](https://github.com/piyush0609/toss/commit/7591dd6d656e717c12bb5d4780044b5ee88f9ff7))
* **readme:** add Releasing section linking the runbook ([ced899e](https://github.com/piyush0609/toss/commit/ced899e91bc302d854fd1418a41f8e443f4548e9))

## [0.2.0](https://github.com/piyush0609/toss/compare/v0.1.0...v0.2.0) (2026-06-08)


### Features

* --yes flag for non-interactive setup ([d0452c4](https://github.com/piyush0609/toss/commit/d0452c4027ca03c36710c7f73819e1b093fc027d))
* add toss skill install for AI assistants ([1502cd2](https://github.com/piyush0609/toss/commit/1502cd275e4509bc7a7d778d2125713458186621))
* allow empty subdomain for cleaner worker names ([ec966a2](https://github.com/piyush0609/toss/commit/ec966a2aaeaaabaffd8694e7dfd9b2f42ade76c1))
* auto-install agent SKILL.md during toss install ([95279a1](https://github.com/piyush0609/toss/commit/95279a1249d599ddb7e7e5a79d627dd105c3d1ef))
* check subdomain availability during setup ([601e899](https://github.com/piyush0609/toss/commit/601e89954676df1fe7576040ef0b7cf55bfc3640))
* **cli:** update-check banner + release tooling + RELEASING runbook ([b308240](https://github.com/piyush0609/toss/commit/b3082404637f89d2e4e76e8b7df7de5128e69e27))
* **comments:** add comments_enabled column (worker + vercel migrations) ([5a3f68f](https://github.com/piyush0609/toss/commit/5a3f68fc0a9720bce50089f583fd118da6ef85cd))
* **comments:** CLI --comments flag + toss comments on|off ([fe5340e](https://github.com/piyush0609/toss/commit/fe5340ec482d6e6b6334e8788a8efe3f0ad59bea))
* **comments:** component-anchored, DB-backed comment widget (vercel) ([e217e58](https://github.com/piyush0609/toss/commit/e217e58fb9133896f5348c98beaccaf2dc9d713f))
* **comments:** distinct comment grant (aud:comment) + owner-token access ([5765755](https://github.com/piyush0609/toss/commit/5765755c0c95330db0b431d763771b9e64fa634b))
* **comments:** owner-scoped read + collaborative password read via env key ([4520e40](https://github.com/piyush0609/toss/commit/4520e40a1b1ff4ba2ee6fad041949a8066a212b4))
* **comments:** password_epoch column + pin JWT alg (grant groundwork) ([b1e9f83](https://github.com/piyush0609/toss/commit/b1e9f83860d2e8790f4b7d193bef9f781ec01785))
* **comments:** programmatic retrieval — toss comments <id> [--json] + skill docs ([#4](https://github.com/piyush0609/toss/issues/4)) ([6065317](https://github.com/piyush0609/toss/commit/6065317008564aebac9166efc184aeb5eb2f4509))
* **comments:** toss share --force to override the re-share no-op guard ([9dcad90](https://github.com/piyush0609/toss/commit/9dcad9073c9c059dae69b93008f026a58f9da4d5))
* **comments:** vercel auth mirror — grant + name + anyone (backward compatible) ([c487d68](https://github.com/piyush0609/toss/commit/c487d684769185a168f3debcb8f0f25396859377))
* **comments:** vercel opt-in gating (mirror of worker) ([65489cf](https://github.com/piyush0609/toss/commit/65489cf3a42dcae8ea27cffc06b442158c2bf9ef))
* **comments:** vercel widget — name prompt instead of toss token ([aaeb124](https://github.com/piyush0609/toss/commit/aaeb12499780fbdfde6e713fb0f9bd801e06a887))
* **comments:** versioning logic on vercel — mint / guard / latest-only ([3d04cd0](https://github.com/piyush0609/toss/commit/3d04cd046e0371a20f86c1009acf6803e388e4fd)), closes [#5](https://github.com/piyush0609/toss/issues/5)
* **comments:** versioning schema — artifact_versions + version_id (both backends) ([26d7242](https://github.com/piyush0609/toss/commit/26d72421821f9e7c549afaf6fe7e5271356c7760))
* **comments:** worker name identity + anyone-edits (backward compatible) ([bdb1309](https://github.com/piyush0609/toss/commit/bdb13097c0835aa72d9305ca4f2654690542d85a))
* **comments:** worker opt-in gating (comments_enabled, not MULTI_TENANT) ([e21a324](https://github.com/piyush0609/toss/commit/e21a324f3aa91eb7f92792ceeb409a827be7eca8))
* commit dist/ for source install — no build step needed ([2de15a8](https://github.com/piyush0609/toss/commit/2de15a8b40c56065dc29204e022ca7cb9501e979))
* **deploy:** migrate before promote + fail-loud (vercel) ([251417c](https://github.com/piyush0609/toss/commit/251417cb3d0a10a09f7aeeeca21f5abd2bf2b12b))
* **deploy:** shared secret resolver + persist jwtSecret locally ([9b6f3e7](https://github.com/piyush0609/toss/commit/9b6f3e7800950bba087402fd7687e2c69b15e808))
* install.sh prefers source install (~100KB) when Node.js is available ([c6d2f50](https://github.com/piyush0609/toss/commit/c6d2f50c0680865914d42d113d348cd2fa1e40f3))
* interactive setup with profile selection, deployment mode, secure password prompt ([5389881](https://github.com/piyush0609/toss/commit/5389881155ab5d4925f067d17a59883132d07bd4))
* interactive subdomain prompt during setup ([20f0cd9](https://github.com/piyush0609/toss/commit/20f0cd9f53559abc84a44d7f876851c8b503bb78))
* multi-account deploy via --profile ([3e44811](https://github.com/piyush0609/toss/commit/3e44811a1aaa181663579c4a85b6a7a5136e8b2b))
* multi-tenant team mode + short share URLs ([e986781](https://github.com/piyush0609/toss/commit/e986781387cb069d5cfdb3656ab8880054362625))
* password-protected shares ([b535eb6](https://github.com/piyush0609/toss/commit/b535eb6fdaa6ed5a5c65bffb490c40d4d9bd6780))
* permanent links + stable URLs via --id (replace-in-place) ([de71394](https://github.com/piyush0609/toss/commit/de71394d8c241ba7e0ece5250bff70b3ea94c10f))
* preset subdomain during setup --profile ([af6e0ac](https://github.com/piyush0609/toss/commit/af6e0ace65906d1edc1b902b76c618ef18bd9827))
* profile support for multiple toss instances ([d525b28](https://github.com/piyush0609/toss/commit/d525b28bf5b4fa1a54dec9f46f416193cf263113))
* profile-aware setup — auth flows from setup to deploy per profile ([37b1e8b](https://github.com/piyush0609/toss/commit/37b1e8b2ffff8bb83c5ff71eb701cb533d55afad))
* **share:** structured slug_taken error + agent recovery guidance ([bcda110](https://github.com/piyush0609/toss/commit/bcda1103c876d2028b97a0badfa74dc488eb54ce))
* **skill:** gate skill sync on content hash, not version equality ([2d1e68f](https://github.com/piyush0609/toss/commit/2d1e68fed148e8fc0492c7adbf5758e368f5da59))
* vercel backend, multi-tenant, custom domains, tenant tokens ([cc01909](https://github.com/piyush0609/toss/commit/cc019098f1d4004d4180c9c9b834fb7bf9cfa03c))
* **version:** generate src/version.ts as the version SSOT ([8fc6e47](https://github.com/piyush0609/toss/commit/8fc6e47d70e6d63aae315a8e5f00087319221964))


### Bug Fixes

* address codex review findings on PR [#2](https://github.com/piyush0609/toss/issues/2) ([02ef2f0](https://github.com/piyush0609/toss/commit/02ef2f0598b980a3917bc7a1af352ba4b5104625))
* cleanup must skip permanent artifacts (expires_at = 0) ([70bc69b](https://github.com/piyush0609/toss/commit/70bc69b970105792a573c74364e9cb5c9e2a830e)), closes [#1](https://github.com/piyush0609/toss/issues/1)
* **cli:** hidden deploy/setup/destroy now honor --profile ([e103fa1](https://github.com/piyush0609/toss/commit/e103fa1fbbecba6984bd6475f3fecadb2cba4227))
* comment routes refuse access to revoked/expired artifacts; cascade-delete on revoke ([3202461](https://github.com/piyush0609/toss/commit/32024611117c7fda8a035494880f5af73b4371aa)), closes [#3](https://github.com/piyush0609/toss/issues/3) [#2](https://github.com/piyush0609/toss/issues/2) [#3](https://github.com/piyush0609/toss/issues/3)
* **comments:** re-share guard counts CURRENT-version comments only ([226b478](https://github.com/piyush0609/toss/commit/226b4785b6d7c47cf556c56b76309f19fc3e94c8))
* D1 migration 0003_slugs.sql fails on tables with existing data ([c649a10](https://github.com/piyush0609/toss/commit/c649a107ab0f5434dafe6e0a5136cf943116e3a6))
* **deploy:** stop rotating secrets on redeploy; fix Vercel CLI 52 env ([2097f42](https://github.com/piyush0609/toss/commit/2097f4242e77566554a1745b91e23186006ca1e5))
* handle partial deploy failures gracefully in destroy ([cc0eab1](https://github.com/piyush0609/toss/commit/cc0eab12f639079bb7a312840c2bf2a29233f531))
* harden slugs, normalize permanent JWTs, apply incoming metadata on --id replace ([b94b390](https://github.com/piyush0609/toss/commit/b94b3905cfb9a54aeac55ae44505cd2458990507))
* pass CLOUDFLARE_ACCOUNT_ID for multi-account users during deploy ([9724a76](https://github.com/piyush0609/toss/commit/9724a76dab2cde5e5b2115d97117029c966a5cde))
* random opaque slugs + basename-only storage (no path/filename leaks) ([945a79e](https://github.com/piyush0609/toss/commit/945a79ef8bada68982b83fc89f731733e36a2ac4))
* **release:** register src/version.ts as a bumpFile ([bd5f5b4](https://github.com/piyush0609/toss/commit/bd5f5b485a1e946c7c443253df95eec53136a73f))
* remove dist/ from git — build during install instead ([82f198a](https://github.com/piyush0609/toss/commit/82f198a3f9836a3b86792c307e8a78d605c0915d))
* restore --subdomain flag and TOSS_SUBDOMAIN env support ([9c84898](https://github.com/piyush0609/toss/commit/9c848989abb727c03a3b0b5d84b512eff930e6ad)), closes [#1](https://github.com/piyush0609/toss/issues/1) [#1](https://github.com/piyush0609/toss/issues/1)
* set CLOUDFLARE_ACCOUNT_ID for multi-account users during setup verification ([641b442](https://github.com/piyush0609/toss/commit/641b442649d269a04e00858f77e8a8c5aca21742))
* skip 410 in serveArtifact() for permanent shares (expires_at = 0) ([f65ea6f](https://github.com/piyush0609/toss/commit/f65ea6f28a1780fa878b32b75fbff3ede930b51f))
* **vercel:** make redeploys safe, correct, and idempotent ([e9e601f](https://github.com/piyush0609/toss/commit/e9e601fb36986981ec568d97cf8c4f1bab4828c2))


### Refactoring

* centralize artifact expiry semantics ([37dd92e](https://github.com/piyush0609/toss/commit/37dd92eda2d5a70f65139400c4e0599d146f436b)), closes [#3](https://github.com/piyush0609/toss/issues/3) [#1](https://github.com/piyush0609/toss/issues/1) [#3](https://github.com/piyush0609/toss/issues/3)
* **config:** unify profiles into a single config.json with auto-migration ([09a3f3b](https://github.com/piyush0609/toss/commit/09a3f3ba429551b8b2ee1ecf96fcedfd7ea38a78))


### Documentation

* add Before You Start section for new Cloudflare users ([98c07da](https://github.com/piyush0609/toss/commit/98c07dae3170e66004d161bcb819147c29f098de))
* clean up SKILL.md ([81e126c](https://github.com/piyush0609/toss/commit/81e126ca2660aadf176546cb0f0b8f84ce125a3e))
* **comments:** finalize plan — component-anchored, optional password ([f085708](https://github.com/piyush0609/toss/commit/f085708d1e446e8f4ea49488543153cc0ca7f647)), closes [#4](https://github.com/piyush0609/toss/issues/4) [#5](https://github.com/piyush0609/toss/issues/5) [#11](https://github.com/piyush0609/toss/issues/11)
* **comments:** plan for universal document comments (name+password, versioned) ([f4106eb](https://github.com/piyush0609/toss/commit/f4106ebcbe6b14aac0030f0bdc70c655828d41e7))
* **config:** describe the unified single-file config store ([9588490](https://github.com/piyush0609/toss/commit/958849012ad3e0dfaf501cf12d6c45ac54660dfe))
* remove npm fallback claim — not published yet ([2aa6e53](https://github.com/piyush0609/toss/commit/2aa6e53dc6eea995fd2f45941fe2dfdf6b1e88c0))
* rename RELEASING.md to RELEASE_MANAGEMENT.md ([6d0e9eb](https://github.com/piyush0609/toss/commit/6d0e9eb7f81ed6d30479ae9d9fb81ec381e8ee32))
* **skill:** document first-time vs iterative deploy + safety rules ([57bd112](https://github.com/piyush0609/toss/commit/57bd1120ee1ca4ffa03e35e9e7db2261cecf9f23))
* **skill:** document stable/static links (--id) + tie to versioning ([7224164](https://github.com/piyush0609/toss/commit/7224164dbbf2254af0ac5d1406975a1620f94d3b))
* update GitHub URLs after repo rename hull → toss ([9b8b0c5](https://github.com/piyush0609/toss/commit/9b8b0c540fd4dadda1e6d53fdf649d616fecdb03))
* update README and SKILL.md for vercel, multi-tenant, custom domains ([8280b00](https://github.com/piyush0609/toss/commit/8280b00f21c62bf78b70bac734676861f613ceb6))
* update README and SKILL.md to reflect current setup flow ([e8fdaa2](https://github.com/piyush0609/toss/commit/e8fdaa2b5d1d3960bd0c2d9b907200224cba26d9))
