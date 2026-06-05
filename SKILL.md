---
name: toss
description: Use when sharing HTML files, folders, reports, demos, or static sites with expiring links — or when the user mentions toss, self-hosted artifact sharing, or commands like `toss share`, `toss deploy`, `toss setup`, `toss list`, `toss revoke`, `toss profile`, `toss token`, `toss join`. Covers Cloudflare Workers and Vercel Edge backends, multi-tenant teams, password-protected shares, profile switching across deployments, and custom domains. Trigger when user asks how to share an HTML file/folder with an expiry, set up a self-hosted share service, or onboard teammates to a shared toss instance.
license: MIT
---

# Toss CLI

Self-host HTML artifact sharing on Cloudflare or Vercel. Generate time-expiring links for HTML files and folders. No third-party service required.

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
- **Short share URLs** — Human-readable slugs like `q4-report-Q7x9`
- **Password protection** — SHA-256 hashed with session cookie auth
- **Multi-tenant mode** — Per-user tokens with admin/user roles
- **Custom domains** — Point any domain at your toss instance
- **Profile system** — Switch between multiple deployments and tenants

## When to Use

Use toss when:

- Sharing HTML reports, demos, or prototypes with controlled expiry
- Sharing folders containing static sites (HTML + CSS + JS + assets)
- Needing self-hosted sharing without third-party services
- Working in environments where data residency matters
- Auto-expiring content (1h to 30d)
- Password-protecting sensitive shared content
- Running a team sharing service with per-user access control
- Wanting a custom domain for shared links

Don't use when:
- You need permanent/long-term hosting (max expiry 30d)
- Files exceed 25MB total
- You need real-time collaboration or editing

## Onboarding Flow

When the user wants to use toss, **detect state first, ask only what's unknown**. Never assume install state or jump straight to questions a probe could answer. Walk these steps in order.

### Step 1 — Is toss installed?

Probe:
```bash
command -v toss && toss --version
```

- **Not installed** → install it, then continue:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/piyush0609/toss/main/install.sh | sh
  ```
  Verifies Node.js 18+ and falls back to standalone binary if Node is missing.
- **Installed** → continue.

### Step 2 — Is there existing config?

Probe:
```bash
toss profile list 2>/dev/null
toss info 2>/dev/null
```

- **No profiles / no config** → first-time user. Go to Step 3.
- **Has profiles** → the user already has at least one toss instance configured. Show them what exists and ask what they want to do:
  - "Use existing profile `<name>` to share something?" → skip ahead to **Share**.
  - "Add another profile (different deployment, different tenant)?" → Step 3.
  - "Switch backends or rebuild?" → `toss destroy` first (confirm with user), then Step 3.

### Step 3 — Owner or tenant?

> "Are you setting up your own toss instance, or joining one a teammate already deployed?"

| Answer | What you need from the user | Next |
|--------|------------------------------|------|
| **Tenant** (joining) | endpoint URL + access token + a local profile name | Step 4a |
| **Owner** (own setup) | which backend (Cloudflare or Vercel) | Step 4b |

### Step 4a — Tenant onboarding

Confirm you have:
- **Endpoint URL** (e.g. `https://share.company.com`)
- **Access token** (provided by the owner via `toss token create`)
- **Local profile name** (e.g. `work`, `alice`)

Run:
```bash
toss join <endpoint-url> --token <token> --profile <name>
```

Done. The user can now `toss share`, `toss list`, etc. against that instance.

### Step 4b — Owner onboarding

**Pick a backend:**

| Backend | Storage | Required account | Setup + deploy |
|---------|---------|------------------|----------------|
| **Cloudflare** (default) | D1 + KV | Cloudflare + workers.dev subdomain | `toss setup` → `toss deploy` |
| **Vercel** | Neon Postgres + Blob | Vercel | `toss setup --backend vercel` → `toss deploy --backend vercel` |

`toss setup` is interactive: installs missing CLIs (Wrangler / Vercel CLI), authenticates, verifies prerequisites. It can run `toss deploy` immediately after.

**During `toss deploy`, the user picks a deployment mode:**

- **Single-user** — personal use, one owner token.
- **Multi-tenant team** — admin issues per-user tokens; each tenant only sees their own artifacts. Pick this if teammates will share the instance.

After deploy: the owner can hand out tokens with `toss token create --label <name>`, and teammates onboard via the **tenant path (Step 4a)**.

## Setup

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
- **Browser** — Opens Cloudflare OAuth. Use incognito to switch accounts.
- **API token** — Paste a token from https://dash.cloudflare.com/profile/api-tokens.

### Vercel

```bash
toss setup --backend vercel
```

Checks Node.js and Vercel CLI, then authenticates.

## Deploy

### Cloudflare

```bash
toss deploy
```

Interactive prompts:

```
Existing profiles:
  default
  work
Use an existing profile? (Y/n):

Deployment mode:
  1. Single-user (personal use)
  2. Multi-tenant team (shared with teammates)
Select: 1

Choose a subdomain (e.g., yourname): yourname
```

Creates: a Worker (`toss-you`), a D1 database (`toss-db-you`), a KV namespace (`toss-kv-you`).

### Vercel

```bash
toss deploy --backend vercel
```

Auto-provisions a Vercel project, Neon Postgres database, Vercel Blob store, env vars, and runs migrations.

## Share

```bash
# Basic share
toss share ./index.html --expires 24h

# Password-protected (secure interactive prompt)
toss share ./report.html --expires 7d --password

# Password via CLI (visible in shell history — not recommended)
toss share ./report.html --expires 7d --password mysecret

# Use a specific profile
toss share ./file.html --expires 24h --profile work
```

**Password security:**
- Use `--password` (no value) for an interactive prompt — characters hidden with `*`.
- Passing `--password <value>` works but exposes the password in shell history.
- Passwords are SHA-256 hashed with the artifact ID as salt before storage.
- Recipients enter the password on a web form; a session cookie grants access for the link's lifetime.

## Manage

```bash
toss list
toss revoke <slug>
toss info
toss destroy
```

## Profiles

Profiles let you manage multiple toss deployments (personal, work, client projects, tenants).

```bash
toss profile list
toss profile show
toss profile switch work
toss profile default work
toss profile rename old-name new-name
toss profile delete work
```

**Storage:**
- `~/.toss/config.json` — all profiles (including `default`) + active marker (legacy two-file installs migrate automatically)

**Per-command targeting:** Use `--profile <name>` on any command without switching:

```bash
toss deploy --profile work
toss share ./file.html --expires 24h --profile work
toss list --profile tenant-alice
```

## Multi-Tenant Team Mode

Enable during `toss deploy` by selecting "Multi-tenant team". Adds:

- Per-user upload tokens stored in the database
- Artifact ownership (users see/delete only their own uploads)
- Admin vs user roles
- Token isolation at the database level

**Admin commands:**
```bash
toss token create --label "alice"
toss token list
toss token revoke <hash>
toss token rotate
```

**Teammate onboarding:**
```bash
# Option 1: Join command
toss join https://your-domain.com --token <their-token> --profile alice

# Option 2: Manual setup
toss profile switch alice
toss endpoint https://your-domain.com
toss token <their-token>
```

**Tenant testing:**
```bash
toss share ./file.html --expires 24h --profile alice
toss list --profile alice          # only tenant's artifacts
toss list --profile default        # admin sees all
```

## Custom Domains

1. Add your domain in the Cloudflare/Vercel dashboard
2. Point toss at it:
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

- **Upload** — hex owner token in `~/.toss/config.json` (chmod 600)
- **Share links** — Short slug URLs (`/s/:slug`) with optional password
- **Legacy links** — HS256 JWT with `sub` (artifact ID) and `exp` (expiry)
- **Passwords** — SHA-256(password + artifact.id), no plaintext storage
- **Folder sub-files** — HttpOnly cookie scoped to `/s/:slug`
- **Token comparison** — Constant-time, prevents timing attacks
- **Path traversal** — Validated on serve route
- **Size limits** — 25MB enforced server-side
- **Multi-tenant** — Token hash isolation in database queries

## Limitations

- 25MB total per upload
- Max expiry 30d
- No background cleanup of expired artifacts
- Cloudflare KV has eventual consistency (1–60s delay after upload)

## Example Workflows

**Share a generated report**
```bash
node generate-report.js > report.html
toss share ./report.html --expires 24h --clipboard
```

**Share a React build folder**
```bash
npm run build
toss share ./dist --expires 7d
```

**Password-protect a sensitive report**
```bash
toss share ./financial-report.html --expires 7d --password
```

**CI integration**
```bash
toss share ./coverage-report/index.html --expires 1d --json | jq -r '.url'
```

**Deploy to work account**
```bash
toss deploy --profile work
```

**Create a tenant token + onboard teammate**
```bash
toss token create --label "alice"
# → token: abc123...
toss join https://share.company.com --token abc123... --profile alice
```

## References

- **Repo:** https://github.com/piyush0609/toss
- **Releases:** https://github.com/piyush0609/toss/releases
