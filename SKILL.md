# Toss CLI Skill

Self-host HTML artifact sharing on Cloudflare. Generate time-expiring links for HTML files and folders. No third-party service required.

---

name: toss-cli
description: Deploy and manage a self-hosted HTML sharing service on Cloudflare Workers. Share HTML files or folders with time-controlled links via CLI. Ideal for sharing reports, demos, prototypes, and static sites with expiry.
license: MIT
compatibility: macOS, Linux, Windows. Cloudflare account required.
metadata:
  author: Toss
  version: "0.1.0"
  requires: ["node", "wrangler"]

---

## Overview

Toss deploys a complete sharing infrastructure to your Cloudflare account:

- **Cloudflare Worker** — Edge compute for upload, serve, list, delete
- **D1 Database** — Metadata storage (id, name, size, expiry)
- **KV Storage** — File storage (25MB/value limit)
- **JWT Share Links** — Self-contained signed tokens with enforced expiry

## When to Use This Skill

Use toss when:

- Sharing HTML reports, demos, or prototypes with controlled expiry
- Sharing folders containing static sites (HTML + CSS + JS + assets)
- Needing self-hosted sharing without relying on third-party services
- Working in environments where data residency matters
- Sharing content that should auto-expire (1h to 30d)

Don't use when:

- You need permanent/long-term hosting (toss max expiry is 30d)
- You're sharing files larger than 25MB total
- You need real-time collaboration or editing

## Prerequisites

1. A Cloudflare account with a [workers.dev subdomain](https://dash.cloudflare.com/workers/onboarding)
2. Node.js 18+ (for Wrangler CLI)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/piyush0609/toss/main/install.sh | sh
```


## Quick Start

### 1. Run setup

```bash
toss setup
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
toss deploy
# Choose a subdomain, e.g. "you"
```

### 3. Share

```bash
toss share ./index.html --expires 24h
toss share ./my-site --expires 7d
```

### 4. Manage

```bash
toss list
toss revoke <id>
toss info
toss destroy
```

## Commands

| Command | Description |
|---------|-------------|
| `toss setup` | One-time setup: install wrangler, login, verify subdomain |
| `toss deploy` | Deploy worker, D1, and KV to Cloudflare |
| `toss share <file> --expires <duration>` | Share an HTML file or folder |
| `toss list` | List artifacts with size and expiry |
| `toss revoke <id>` | Delete an artifact from KV and D1 |
| `toss info` | Show endpoint, subdomain, KV ID, count |
| `toss destroy` | Delete worker, D1, KV, and local config |
| `toss doctor` | Check prerequisites (read-only) |

## Security Model

- **Upload** — hex owner token stored in `~/.toss/config.json`
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
toss share ./report.html --expires 24h --clipboard
```

### Share a React build folder

```bash
npm run build
toss share ./dist --expires 7d
```

### CI integration

```bash
toss share ./coverage-report/index.html --expires 1d --json | jq -r '.url'
```

## References

- **Repo:** https://github.com/piyush0609/toss
- **Releases:** https://github.com/piyush0609/toss/releases
