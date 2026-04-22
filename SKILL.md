# Hull CLI Skill

Self-host HTML artifact sharing on Cloudflare. Generate time-expiring links for HTML files and folders. No third-party service required.

---

name: hull-cli
description: Deploy and manage a self-hosted HTML sharing service on Cloudflare Workers. Share HTML files or folders with time-controlled links via CLI. Ideal for sharing reports, demos, prototypes, and static sites with expiry.
license: MIT
compatibility: macOS, Linux, Windows. Cloudflare account required.
metadata:
  author: Hull
  version: "0.1.0"
  requires: ["node", "wrangler"]

---

## Overview

Hull deploys a complete sharing infrastructure to your Cloudflare account:

- **Cloudflare Worker** — Edge compute for upload, serve, list, delete
- **D1 Database** — Metadata storage (id, name, size, expiry)
- **KV Storage** — File storage (25MB/value limit)
- **JWT Share Links** — Self-contained signed tokens with enforced expiry

## When to Use This Skill

Use hull when:

- Sharing HTML reports, demos, or prototypes with controlled expiry
- Sharing folders containing static sites (HTML + CSS + JS + assets)
- Needing self-hosted sharing without relying on third-party services
- Working in environments where data residency matters
- Sharing content that should auto-expire (1h to 30d)

Don't use when:

- You need permanent/long-term hosting (hull max expiry is 30d)
- You're sharing files larger than 25MB total
- You need real-time collaboration or editing

## Prerequisites

1. A Cloudflare account with a [workers.dev subdomain](https://dash.cloudflare.com/workers/onboarding)
2. Node.js 18+ (for Wrangler CLI)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/piyush0609/hull/main/install.sh | sh
```

Or via npm fallback:
```bash
npm install -g hull-cli
```

## Quick Start

### 1. Run setup

```bash
hull setup
```

Handles all prerequisites interactively:
- Checks Node.js version
- Installs Wrangler if missing
- Authenticates with Cloudflare (browser OAuth or API token)
- Verifies your workers.dev subdomain

**Multi-account users:** If you have multiple Cloudflare accounts, setup extracts the account ID automatically. Use incognito mode or API tokens to switch accounts.

**Login methods:**
- **Browser login** — Opens Cloudflare OAuth. Use incognito/private mode to switch accounts.
- **API token** — Paste a token from https://dash.cloudflare.com/profile/api-tokens. No browser needed.

### 2. Deploy

```bash
hull deploy
# Choose a subdomain, e.g. "you"
```

### 3. Share

```bash
hull share ./index.html --expires 24h
hull share ./my-site --expires 7d
```

### 4. Manage

```bash
hull list
hull revoke <id>
hull info
hull destroy
```

## Commands

| Command | Description |
|---------|-------------|
| `hull setup` | One-time setup: install wrangler, login, verify subdomain |
| `hull deploy` | Deploy worker, D1, and KV to Cloudflare |
| `hull share <file> --expires <duration>` | Share an HTML file or folder |
| `hull list` | List artifacts with size and expiry |
| `hull revoke <id>` | Delete an artifact from KV and D1 |
| `hull info` | Show endpoint, subdomain, KV ID, count |
| `hull destroy` | Delete worker, D1, KV, and local config |
| `hull doctor` | Check prerequisites (read-only) |

## Security Model

- **Upload** — hex owner token stored in `~/.hull/config.json`
- **Share links** — HS256 JWT with `sub` (artifact ID) and `exp` (expiry)
- **Folder sub-files** — HttpOnly cookie scoped to `/a/{id}`

## Limitations

- 25MB total per upload
- Max expiry 30d
- KV eventual consistency (1–60s delay after upload)
- No background cleanup of expired artifacts

## Example Workflows

### Share a generated report

```bash
node generate-report.js > report.html
hull share ./report.html --expires 24h --clipboard
```

### Share a React build folder

```bash
npm run build
hull share ./dist --expires 7d
```

### CI integration

```bash
hull share ./coverage-report/index.html --expires 1d --json | jq -r '.url'
```

## References

- **Repo:** https://github.com/piyush0609/hull
- **Releases:** https://github.com/piyush0609/hull/releases
