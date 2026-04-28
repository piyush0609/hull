# toss

Share HTML artifacts with access-controlled links. Self-hosted on **Cloudflare** or **Vercel** — your choice.

```
toss share ./report.html --expires 24h
# → https://your-domain.com/s/report-AbC1
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/piyush0609/toss/main/install.sh | sh
```

The installer detects your OS/arch, downloads the latest binary from [GitHub Releases](https://github.com/piyush0609/toss/releases), and installs it to `/usr/local/bin` (or `~/.local/bin` with PATH auto-configured).

**Note:** `npm install -g toss-cli` is not yet available. Use the install script or build from source.

---

## Backends

| Backend | Stack | Best For |
|---------|-------|----------|
| **Cloudflare** | Workers + D1 + KV | Free tier, no credit card |
| **Vercel** | Edge Function + Neon + Blob | Postgres-native, larger files |

Switch backends with `toss deploy --backend cloudflare` or `toss deploy --backend vercel`.

---

## Quick Start (Cloudflare)

### 1. Set up prerequisites

```bash
toss setup
```

- Checks Node.js version
- Installs Wrangler if missing
- Authenticates with Cloudflare (browser OAuth or API token)
- Verifies your workers.dev subdomain

### 2. Deploy

```bash
toss deploy
# Choose a subdomain, e.g. "you"
```

Creates:
- A Cloudflare Worker (`toss-you`)
- A D1 database (`toss-db-you`)
- A KV namespace (`toss-kv-you`)

### 3. Share

```bash
toss share ./index.html --expires 24h
```

---

## Quick Start (Vercel)

### 1. Set up prerequisites

```bash
toss setup --backend vercel
```

- Checks Node.js and Vercel CLI
- Authenticates with Vercel

### 2. Deploy

```bash
toss deploy --backend vercel
```

Auto-provisions:
- Vercel project
- Neon Postgres database
- Vercel Blob store

### 3. Add a custom domain (optional)

```bash
# In Vercel dashboard: Project → Settings → Domains
# Then update toss config:
toss endpoint https://share.yourdomain.com
```

---

## Sharing

### Basic share

```bash
toss share ./report.html --expires 24h
```

### Password-protected

```bash
toss share ./report.html --expires 7d --password
# Secure interactive prompt (hidden input)
```

### Folder share

```bash
toss share ./my-site --expires 7d
```

Uploads all files recursively. First `index.html` (or first `.html`) becomes the entry point. All other files are served as static assets with proper MIME types and cookie-based auth.

### Options

| Flag | Description |
|------|-------------|
| `--expires 1h\|24h\|7d\|30d` | Link lifetime (required) |
| `--password` | Password-protect (secure prompt) |
| `--password <value>` | Password via CLI (visible in history) |
| `--clipboard` | Copy link to clipboard |
| `--json` | Output JSON |
| `--profile <name>` | Use a specific profile |

---

## Management Commands

```bash
toss list                    # Show all shared artifacts
toss revoke <slug>           # Delete an artifact
toss info                    # Show endpoint, count, backend
toss destroy                 # Tear down everything
toss doctor                  # Check prerequisites
```

---

## Profiles

Manage multiple deployments (personal, work, client, tenant).

```bash
toss profile list                        # List all profiles
toss profile switch work                 # Switch active profile
toss profile default work                # Set active profile
toss share ./file.html --profile work    # One-off profile use
```

**Storage:**
- `~/.toss/config.json` — default profile
- `~/.toss/profiles.json` — named profiles + active marker

---

## Multi-Tenant Team Mode

Enable during `toss deploy` by selecting "Multi-tenant team".

**Admin commands:**
```bash
toss token create --label "alice"        # Create a tenant token
toss token list                          # List all tokens
toss token revoke <hash>                 # Revoke a token
toss token rotate                        # Regenerate admin token
```

**Tenant onboarding:**
```bash
# Admin creates token, sends to teammate
toss token create --label "alice"

# Teammate joins
toss join https://your-domain.com --token <their-token> --profile alice

# Or manually create a profile:
toss profile switch alice
toss endpoint https://your-domain.com
toss token <their-token>
```

**Tenant isolation:**
- Tenants can only see/upload/revoke their own artifacts
- Admins see all artifacts across all tenants
- Each artifact is tagged with the uploader's token hash

---

## How It Works

### Cloudflare

| Component | Purpose |
|-----------|---------|
| **Worker** | Edge compute — upload, serve, list, delete |
| **D1** | SQLite metadata (id, slug, name, size, expiry) |
| **KV** | File storage (25MB/value limit) |

### Vercel

| Component | Purpose |
|-----------|---------|
| **Edge Function** | Edge compute — upload, serve, list, delete |
| **Neon** | Postgres metadata (id, slug, name, size, expiry) |
| **Blob** | File storage via REST API |

### Auth Model

- **Upload** — hex owner token (stored in `~/.toss/config.json`, chmod 600)
- **Share links** — Short slug URLs (`/s/:slug`) with optional password
- **Legacy links** — HS256 JWT with `sub` (artifact ID) and `exp` (expiry)
- **Passwords** — SHA-256 hashed with artifact ID as salt
- **Folder sub-files** — HttpOnly cookie scoped to `/s/:slug`

### Security Headers

- `Content-Security-Policy` — strict CSP for React apps
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: private, no-store` (HTML never cached)

Static assets get `Cache-Control: public, max-age=86400, immutable`.

---

## Configuration

Stored in `~/.toss/config.json`:

```json
{
  "endpoint": "https://your-domain.com",
  "ownerToken": "...",
  "subdomain": "you",
  "backend": "vercel",
  "vercelProjectId": "..."
}
```

---

## Limitations

- **25MB total per upload** (Cloudflare KV / Vercel Blob limit)
- **Max expiry 30d**
- **No background cleanup** — expired artifacts stay in storage until revoked or destroyed
- Cloudflare KV has eventual consistency (1–60s delay in some regions)

---

## Development

```bash
git clone https://github.com/piyush0609/toss.git
cd toss
npm install
npm run build
npm test
```

Build standalone binaries:
```bash
npm run build:bin   # or ./build.sh
```

## License

MIT
