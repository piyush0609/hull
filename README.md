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

`toss` now has two clearly separate modes:

- Everyday usage: `toss`, `toss publish`, `toss list`, `toss revoke`, `toss login`
- Owner setup: `toss admin setup`, `toss admin deploy`, `toss admin token ...`

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/piyush0609/toss/main/install.sh | sh
```

The installer downloads the CLI and installs the `toss` binary. If compatible AI tool skill folders exist, it can also install `SKILL.md` guidance there.

If you are testing locally from source instead of installing globally, use `./toss ...` after `npm run build`.

## Simple Usage

If someone has already deployed toss for you, all you need is the endpoint and your upload token:

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

Running `toss` with no subcommand publishes the current directory. That makes the common flow work more like `surge`.

### Publish options

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

## Profiles

Profiles let one machine talk to multiple toss services.

```bash
toss profile list
toss profile switch work
toss profile show
toss ./report.html --profile work
```

Owner deployments also use the profile name as the stable service name by default:

- `owner` or no profile -> `toss`
- `company-a` -> `toss-company-a`
- `acme_team` -> `toss-acme-team`

## Owner Setup

Use these commands only if you are the person deploying and managing the toss service.

If you are running from source locally, the same commands become:

```bash
./toss admin setup
./toss admin deploy
```

### Cloudflare

```bash
toss admin setup
toss admin deploy
```

### Vercel

```bash
toss admin setup --backend vercel
toss admin deploy --backend vercel
```

For multiple separate deployments, use different owner profiles instead of passing extra naming flags:

```bash
toss admin deploy --backend vercel --profile owner
toss admin deploy --backend vercel --profile company-a
toss admin deploy --backend vercel --profile company-b
```

Backend choice is now an owner concern. Regular users should not need to know whether the service is running on Cloudflare or Vercel.

## Team Tokens

Owners can create upload tokens for teammates:

```bash
toss admin token create --label alice
toss admin token list
toss admin token revoke <hash>
toss admin members
toss admin cleanup
```

Teammates then connect with:

```bash
toss login https://share.example.com --token <their-token>
```

## Other Commands

```bash
toss info
toss whoami
toss doctor
toss skill install
toss admin destroy
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

Owner profiles may also include backend-specific deployment metadata.

## Notes

- Cloudflare remains the default backend.
- Vercel owner deployments can provision Neon and Blob resources.
- Legacy commands like `toss share`, `toss deploy`, and `toss join` still work for compatibility, but the preferred interface is the simplified one above.
- For local repo testing, prefer `./toss ...` over `node dist/index.js ...`.
