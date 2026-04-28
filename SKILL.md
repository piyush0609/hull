# Toss CLI Skill

Self-host HTML artifact sharing on Cloudflare or Vercel. Generate time-expiring links for HTML files and folders. No third-party service required.

---

name: toss-cli
description: Deploy and manage a self-hosted HTML sharing service on Cloudflare Workers or Vercel Edge Functions. Share HTML files or folders with time-controlled links via CLI. Ideal for sharing reports, demos, prototypes, and static sites with expiry.
license: MIT
compatibility: macOS, Linux, Windows. Cloudflare or Vercel account required.
metadata:
  author: Toss
  version: "0.1.0"
  requires: ["node"]

---

## Overview

Toss deploys a complete sharing infrastructure to your chosen backend:

**Cloudflare:**
- **Worker** — Edge compute for upload, serve, list, delete
- **D1 Database** — Metadata storage (id, slug, name, size, expiry, passwords)
- **KV Storage** — File storage (25MB/value limit)

**Vercel:**
- **Edge Function** — Edge compute for upload, serve, list, delete
- **Neon Postgres** — Metadata storage with full SQL
- **Blob Storage** — File storage via REST API

Shared features:
- **Short Share URLs** — Human-readable slugs like `q4-report-Q7x9`
- **Password Protection** — SHA-256 hashed passwords with session cookie auth
- **Multi-Tenant Mode** — Per-user tokens with admin/user roles
- **Custom Domains** — Point any domain at your toss instance
- **Profile System** — Switch between multiple deployments and tenants

## When to Use This Skill

Use toss when:

- Sharing HTML reports, demos, or prototypes with controlled expiry
- Sharing folders containing static sites (HTML + CSS + JS + assets)
- Needing self-hosted sharing without relying on third-party services
- Working in environments where data residency matters
- Sharing content that should auto-expire (1h to 30d)
- Password-protecting sensitive shared content
- Running a team sharing service with per-user access control
- Wanting a custom domain for shared links

Don't use when:
- You need permanent/long-term hosting (toss max expiry is 30d)
- You're sharing files larger than 25MB total
- You need real-time collaboration or editing

## Prerequisites

1. A Cloudflare account (for Cloudflare backend) or Vercel account (for Vercel backend)
2. Node.js 18+

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/piyush0609/toss/main/install.sh | sh
```

## Interactive Setup

### Cloudflare

```bash
toss setup
```

- Checks Node.js version
- Installs Wrangler if missing
- Authenticates with Cloudflare (browser OAuth or API token)
- Verifies your workers.dev subdomain
- Optionally runs `toss deploy` immediately after

**Login methods:**
- **Browser login** — Opens Cloudflare OAuth. Use incognito/private mode to switch accounts.
- **API token** — Paste a token from https://dash.cloudflare.com/profile/api-tokens. No browser needed.

### Vercel

```bash
toss setup --backend vercel
```

- Checks Node.js and Vercel CLI
- Authenticates with Vercel

## Deploy

### Cloudflare

```bash
toss deploy
```

Interactive prompts walk you through:

**Profile selection:**
```
Existing profiles:
  default
  work
Use an existing profile? (Y/n):
```

**Deployment mode:**
```
Deployment mode:
  1. Single-user (personal use)
  2. Multi-tenant team (shared with teammates)
Select: 1
```

**Subdomain:**
```
Choose a subdomain (e.g., yourname): yourname
```

Creates:
- A Cloudflare Worker (`toss-you`)
- A D1 database (`toss-db-you`)
- A KV namespace (`toss-kv-you`)

### Vercel

```bash
toss deploy --backend vercel
```

Auto-provisions:
- Vercel project
- Neon Postgres database
- Vercel Blob store
- Sets environment variables
- Runs database migrations

## Share

```bash
# Basic share
toss share ./index.html --expires 24h

# Password-protected share (secure interactive prompt)
toss share ./report.html --expires 7d --password

# Password via CLI (visible in shell history — not recommended)
toss share ./report.html --expires 7d --password mysecret

# Use a specific profile
toss share ./file.html --expires 24h --profile work
```

**Password security:**
- Use `--password` (no value) for a secure interactive prompt. Characters are hidden with `*`.
- Passing `--password <value>` works but warns that the password is exposed in shell history.
- Passwords are SHA-256 hashed with the artifact ID as salt before storage.
- Recipients enter the password on a web form; a session cookie grants access for the link's lifetime.

## Manage

```bash
toss list
toss revoke <slug>
toss info
toss destroy
```

## Profile System

Profiles let you manage multiple toss deployments (personal, work, client projects, tenants, etc.).

```bash
# List all profiles
toss profile list

# Show current active profile
toss profile show

# Switch active profile
toss profile switch work

# Set active profile (alias for switch)
toss profile default work

# Rename a profile
toss profile rename old-name new-name

# Delete a profile
toss profile delete work
```

**Profile storage:**
- `~/.toss/config.json` — default profile
- `~/.toss/profiles.json` — named profiles + active marker

**Multi-account deploy:** Each profile stores its own endpoint and token. Use `--profile` on any command to target a specific deployment without switching:

```bash
toss deploy --profile work
toss share ./file.html --expires 24h --profile work
toss list --profile tenant-alice
```

## Multi-Tenant Team Mode

Enable during `toss deploy` by selecting "Multi-tenant team". This adds:

- Per-user upload tokens stored in the database
- Artifact ownership (users can only see/delete their own uploads)
- Admin vs user roles
- Token isolation at the database level

**Admin commands:**
```bash
# Create a token for a teammate
toss token create --label "alice"

# List all tokens
toss token list

# Revoke a token
toss token revoke <hash>

# Regenerate admin token
toss token rotate
```

**Teammate onboarding:**
```bash
# Option 1: Join command
toss join https://your-domain.com --token <their-token> --profile alice

# Option 2: Manual profile setup
toss profile switch alice
toss endpoint https://your-domain.com
toss token <their-token>
```

**Tenant testing:**
```bash
# Share as tenant
toss share ./file.html --expires 24h --profile alice

# List only tenant's artifacts
toss list --profile alice

# Admin sees all artifacts
toss list --profile default
```

## Custom Domains

1. Add your domain in the Vercel/Cloudflare dashboard
2. Update toss config:
```bash
toss endpoint https://share.yourdomain.com
```
3. All future shares use the custom domain

## Commands

| Command | Description |
|---------|-------------|
| `toss setup` | One-time setup: install CLI tools, login, verify |
| `toss setup --backend vercel` | Set up for Vercel backend |
| `toss deploy` | Deploy to Cloudflare (default) |
| `toss deploy --backend vercel` | Deploy to Vercel |
| `toss share <file> --expires <duration>` | Share an HTML file or folder |
| `toss share <file> --password` | Share with secure password prompt |
| `toss list` | List artifacts with size and expiry |
| `toss revoke <slug>` | Delete an artifact |
| `toss info` | Show endpoint, backend, count |
| `toss destroy` | Delete all infrastructure and local config |
| `toss doctor` | Check prerequisites (read-only) |
| `toss profile list` | List all profiles |
| `toss profile switch <name>` | Switch active profile |
| `toss profile default [name]` | Show or set active profile |
| `toss profile rename <old> <new>` | Rename a profile |
| `toss profile delete <name>` | Delete a profile |
| `toss token create --label <name>` | Create upload token (admin) |
| `toss token list` | List tokens (admin) |
| `toss token revoke <hash>` | Revoke token (admin) |
| `toss token rotate` | Regenerate admin token |
| `toss join <endpoint> --token <token>` | Join a shared instance |
| `toss endpoint <url>` | Set the API endpoint |

## Security Model

- **Upload** — hex owner token stored in `~/.toss/config.json` (chmod 600)
- **Share links** — Short slug URLs (`/s/:slug`) with optional password protection
- **Legacy links** — HS256 JWT with `sub` (artifact ID) and `exp` (expiry)
- **Passwords** — SHA-256(password + artifact.id) hashing, no plaintext storage
- **Folder sub-files** — HttpOnly cookie scoped to `/s/:slug`
- **Token comparison** — Constant-time comparison to prevent timing attacks
- **Path traversal** — Validated on serve route
- **Size limits** — 25MB enforced on the server side
- **Multi-tenant** — Token hash isolation in database queries

## Limitations

- 25MB total per upload
- Max expiry 30d
- No background cleanup of expired artifacts
- Cloudflare KV has eventual consistency (1–60s delay after upload)

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

### Password-protect a sensitive report

```bash
toss share ./financial-report.html --expires 7d --password
# Enter password securely (hidden input)
```

### CI integration

```bash
toss share ./coverage-report/index.html --expires 1d --json | jq -r '.url'
```

### Deploy to work account

```bash
toss deploy --profile work
```

### Create a tenant token

```bash
toss token create --label "alice"
# → token: abc123...
```

### Teammate joins with token

```bash
toss join https://share.company.com --token abc123... --profile alice
```

## References

- **Repo:** https://github.com/piyush0609/toss
- **Releases:** https://github.com/piyush0609/toss/releases
