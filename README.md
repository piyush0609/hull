# toss

Publish HTML files and folders with a simple share link.

```bash
toss ./report.html
# → https://your-toss-domain/s/report-AbC1
```

From the repo during development, use:

```bash
npm run build
./toss ./report.html
```

`toss` has two separate modes:

- Owner setup: you deploy and manage the shared toss service
- Everyday usage: you connect to an existing toss service and publish files

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/piyush0609/toss/main/install.sh | sh
```

If you are testing locally from source instead of installing globally, use `./toss ...` after `npm run build`.

## How To Think About It

There are two roles in toss.

### 1. Owner / Deployer

This is the person who:

- chooses Cloudflare or Vercel
- runs `toss admin setup`
- runs `toss admin deploy`
- creates member tokens
- manages cleanup and revoke policies

This person needs the Cloudflare or Vercel account.

### 2. User / Member

This is the person who:

- gets an endpoint
- gets a token
- runs `toss login`
- publishes files

This person does not need Cloudflare or Vercel access.

## Usage

If someone has already deployed toss for you, all you need is the endpoint and your token:

```bash
toss login https://share.example.com --token <your-token>
toss ./report.html
toss ./site --expires 7d
toss list
toss revoke <slug-or-id>
toss whoami
```

### Default publish behavior

```bash
toss
```

Running `toss` with no subcommand publishes the current directory, similar to `surge`.

### Common usage commands

```bash
toss ./report.html --expires 24h
toss ./site --password
toss ./site --clipboard
toss publish ./dist --json
```

Available flags:

- `--expires 1h|24h|7d|30d` defaults to `24h`
- `--password` prompts securely
- `--password <value>` passes the password directly
- `--clipboard` copies the URL
- `--json` prints machine-readable output
- `--profile <name>` uses a specific saved profile

### Useful usage commands

```bash
toss list
toss revoke <id-or-slug>
toss info
toss whoami
toss profile list
toss profile show
```

## Setup

If you are the owner, setup is a two-step flow:

1. `toss admin setup`
2. `toss admin deploy`

- `toss admin setup` prepares auth and verifies prerequisites
- `toss admin deploy` creates or updates the actual toss service

## Setup From Source

If you are running from the repo instead of an installed binary:

```bash
npm run build
./toss admin setup
./toss admin deploy
```

## Owner Setup Flow

Recommended owner flow:

```bash
toss admin setup
toss admin deploy --multi-tenant
toss admin token create --label alice
```

Then a teammate joins with:

```bash
toss login https://share.example.com --token <alice-token>
```

## Cloudflare Setup

When you run `toss admin setup` interactively, you'll be asked which backend
to use (Cloudflare or Vercel). Pick Cloudflare here. In non-interactive
contexts (`--yes`, CI), Cloudflare is used by default. To skip the prompt,
pass `--backend cloudflare` explicitly.

### Happy path

```bash
toss admin setup --backend cloudflare
toss admin deploy --multi-tenant
```

### What `toss admin setup` does on Cloudflare

It checks or prepares:

- Node.js
- Wrangler CLI
- Cloudflare authentication
- account verification
- `workers.dev` availability
- deployment suffix/profile wiring

### If you already have Cloudflare ready

If you already have:

- `wrangler` installed
- `wrangler login` done
- `workers.dev` activated

then `toss admin setup` should be mostly quick verification.

### If you do not have Cloudflare ready

`toss admin setup` will guide you through:

- installing Wrangler if missing
- logging into Cloudflare
- verifying the account
- checking `workers.dev`

If your Cloudflare account is new, you may also need to open the Workers dashboard once:

- [Cloudflare Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages)

### If Cloudflare auth is missing

Run:

```bash
toss admin setup
```

If needed, toss will tell you to:

```bash
wrangler login
```

### If `workers.dev` is not set up

You may see a message telling you no `workers.dev` subdomain exists. In that case:

1. Open the Workers & Pages dashboard
2. Finish onboarding
3. Re-run:

```bash
toss admin setup
toss admin deploy
```

### Cloudflare owner commands

```bash
toss admin setup
toss admin deploy
toss admin deploy --multi-tenant
toss admin destroy
toss admin members
toss admin cleanup
toss admin token create --label alice
toss admin token list
```

## Vercel Setup

Use Vercel when you want toss deployed on Vercel instead of Cloudflare.

### Happy path

```bash
toss admin setup --backend vercel
toss admin deploy --backend vercel --multi-tenant
```

### What `toss admin setup --backend vercel` does

It checks or prepares:

- Node.js
- Vercel CLI
- Vercel login
- profile/backend selection

### What `toss admin deploy --backend vercel` does

It sets up or reuses:

- Vercel project
- owner token and JWT secret
- Postgres wiring
- Blob storage wiring
- deployed endpoint

### If you already have Vercel ready

If you already have:

- Vercel CLI installed
- `vercel login` done

then setup is mostly verification and profile save.

### If you do not have Vercel ready

Run:

```bash
toss admin setup --backend vercel
```

It will guide you through login and prerequisites.

### Vercel integrations you should expect

Vercel deployments can require:

- Postgres / Neon
- Vercel Blob

The deploy flow can provision or reuse these, but if your Vercel account has limits or existing resources, toss may ask you to finish part of the setup in the Vercel dashboard.

### If Postgres is already linked

That is fine. Toss can reuse existing Vercel Postgres env if it is already wired.

### If Blob store is missing

Toss will try to provision or detect it. If your Vercel account has Blob limits, you may need to reuse an existing Blob store or remove old ones.

### Vercel owner commands

```bash
toss admin setup --backend vercel
toss admin deploy --backend vercel
toss admin deploy --backend vercel --multi-tenant
toss admin destroy --backend vercel
toss admin members --profile owner
toss admin cleanup --profile owner
```

## Multi-tenant Team Setup

For a shared team deployment:

```bash
toss admin setup
toss admin deploy --multi-tenant
toss admin token create --label alice
toss admin token create --label bob
```

Then teammates do:

```bash
toss login https://share.example.com --token <alice-token>
toss ./report.html
```

Owner can inspect team state with:

```bash
toss admin members
toss admin token list
toss list
```

## Profiles

Profiles let one machine talk to multiple toss services or multiple roles.

```bash
toss profile list
toss profile switch work
toss profile show
toss ./report.html --profile work
```

Examples:

- owner profile: `owner`
- another company: `company-a`
- member profile: `alice`

Owner deployments also use the profile name as the stable service name by default:

- `owner` or no profile -> `toss`
- `company-a` -> `toss-company-a`
- `acme_team` -> `toss-acme-team`

## Setup Point Of View

If you are the person setting toss up, think in this order:

1. Choose a backend: Cloudflare or Vercel
2. Run `toss admin setup`
3. Run `toss admin deploy`
4. Create tokens for members
5. Share only endpoint + token with users

Recommended examples:

### Cloudflare setup point of view

```bash
toss admin setup --profile owner
toss admin deploy --profile owner --multi-tenant
toss admin token create --profile owner --label alice
```

### Vercel setup point of view

```bash
toss admin setup --backend vercel --profile owner
toss admin deploy --backend vercel --profile owner --multi-tenant
toss admin token create --profile owner --label alice
```

## Usage Point Of View

If you are just using toss and not deploying it, your flow is much simpler:

1. Get endpoint
2. Get token
3. Run `toss login`
4. Publish files

Example:

```bash
toss login https://share.example.com --token <your-token>
toss ./slides.html
toss list
toss revoke <id>
```

## Other Commands

```bash
toss info
toss whoami
toss doctor
toss skill install
```

## Configuration

Toss stores connection details in `~/.toss/`.

- `config.json` stores the default profile
- `profiles.json` stores named profiles and the active profile marker

Example config:

```json
{
  "endpoint": "https://share.example.com",
  "token": "your-upload-token",
  "subdomain": "team",
  "role": "member"
}
```

Owner profiles can also include backend-specific metadata like:

- backend
- account ID
- API token
- project ID
- KV / Blob / deploy metadata

## Notes

- Cloudflare is the default backend.
- Vercel is fully supported through explicit backend selection.
- Regular users should not need to care whether the service is running on Cloudflare or Vercel.
- Legacy commands like `toss share`, `toss deploy`, and `toss join` still work for compatibility.
- For local repo testing, prefer `./toss ...` over `node dist/index.js ...`.
