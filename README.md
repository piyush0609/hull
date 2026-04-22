# hull

Share HTML artifacts with access-controlled links. Self-hosted on Cloudflare's free tier — no credit card required.

```
hull share ./report.html --expires 24h
# → https://hull-you.piyush-sinha.workers.dev/a/abc123?t=eyJ...
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/piyush0609/hull/main/install.sh | sh
```

The installer detects your OS/arch, downloads the latest binary from [GitHub Releases](https://github.com/piyush0609/hull/releases), and installs it to `/usr/local/bin` (or `~/.local/bin` with PATH auto-configured).

**Fallback:** If the binary download fails, it falls back to `npm install -g hull-cli`.

**Requirements for deploy:**
- Node.js 18+ (for Wrangler CLI)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (installed automatically by `hull setup`)
- A Cloudflare account with a [workers.dev subdomain](https://dash.cloudflare.com/workers/onboarding)

> **Note:** `hull deploy` calls Wrangler, which requires Node.js. The hull binary itself has no runtime dependencies.

## Before You Start

If you already have a Cloudflare account with a workers.dev subdomain, skip to [Quick Start](#quick-start).

**New to Cloudflare? Do this first (in a browser tab):**

1. **Sign up** at https://dash.cloudflare.com/sign-up
2. **Verify your email** (check inbox for confirmation)
3. **Complete onboarding** — accept terms of service in the dashboard
4. **Register a workers.dev subdomain** at https://dash.cloudflare.com/workers/onboarding

> ⚠️ `hull setup` will fail if you haven't completed Cloudflare onboarding. The OAuth flow requires an active, verified account.

## Quick Start

### 1. Set up prerequisites

```bash
hull setup
```

This interactive command:
- Checks Node.js version
- Installs Wrangler if missing
- Authenticates with Cloudflare (browser OAuth or API token)
- Verifies your workers.dev subdomain

**Multi-account users:** If you have multiple Cloudflare accounts, `hull setup` handles them automatically — it extracts the account ID and passes it to all Wrangler commands.

**Login options:**
- **Browser login** — Opens Cloudflare OAuth with minimal scopes. Use incognito/private mode to switch accounts.
- **API token** — Paste a token from https://dash.cloudflare.com/profile/api-tokens. Best for CI and account switching.

### 2. Deploy your hull

```bash
hull deploy
# Choose a subdomain, e.g. "you"
```

This creates:
- A Cloudflare Worker (`hull-you`)
- A D1 database (`hull-db-you`) for metadata
- A KV namespace (`hull-kv-you`) for file storage

### 3. Share a file

```bash
hull share ./index.html --expires 24h
```

Options:
- `--expires 1h|24h|7d|30d` — link lifetime (required)
- `--clipboard` — copy link to clipboard
- `--json` — output JSON

### 4. Share a folder

```bash
hull share ./my-site --expires 7d
```

Uploads all files recursively. The first `index.html` found (or first `.html`) becomes the entry point. All other files are served as static assets with proper MIME types and cookie-based auth.

### 5. Manage artifacts

```bash
hull list          # Show all shared artifacts
hull revoke <id>   # Delete an artifact
hull info          # Show endpoint, subdomain, artifact count
hull destroy       # Tear down everything
```

## How It Works

| Component | Purpose |
|-----------|---------|
| **Cloudflare Worker** | Edge compute — upload, serve, list, delete |
| **D1** | SQLite metadata (id, name, size, expiry) |
| **KV** | File storage (25MB/value limit) |
| **JWT** | Share links are self-contained signed tokens with expiry |

### Auth Model

- **Upload** — hex owner token (stored in `~/.hull/config.json`)
- **Share links** — HS256 JWT with `sub` (artifact ID) and `exp` (expiry)
- **Folder sub-files** — HttpOnly cookie scoped to `/a/{id}` set on first HTML load

### Security Headers

Served HTML includes:
- `Content-Security-Policy` — strict CSP for React apps
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: private, no-store` (HTML never cached)

Static assets get `Cache-Control: public, max-age=86400, immutable`.

## Commands

| Command | Description |
|---------|-------------|
| `hull setup` | One-time setup: install wrangler, login, verify subdomain |
| `hull deploy` | Deploy infrastructure to Cloudflare |
| `hull share <file> --expires <duration>` | Share an HTML file or folder |
| `hull list` | List all artifacts with expiry status |
| `hull revoke <id>` | Permanently delete an artifact |
| `hull info` | Show endpoint, subdomain, KV ID, artifact count |
| `hull destroy` | Delete worker, D1, KV, and local config |
| `hull doctor` | Check prerequisites (read-only diagnostic) |

## Configuration

Stored in `~/.hull/config.json`:

```json
{
  "endpoint": "https://hull-you.piyush-sinha.workers.dev",
  "ownerToken": "...",
  "subdomain": "you",
  "kvId": "..."
}
```

## Limitations

- **25MB total per upload** (Cloudflare KV limit)
- **KV eventual consistency** — newly shared links may 404 for 1–60 seconds in some regions
- **No background cleanup** — expired artifacts stay in KV/D1 until revoked or destroyed

## Development

```bash
git clone https://github.com/piyush0609/hull.git
cd hull
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
