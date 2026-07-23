// Shared secret resolution for both deploy backends (Cloudflare + Vercel).
//
// Principle: the backend keeps env vars/secrets across deploys, so a redeploy
// must NEVER mint a new one — rotating JWT_SECRET invalidates every signed link
// and password session. And a sensitive secret can't be read back from the
// backend (Vercel sensitive vars / Cloudflare secrets are write-only), so the
// local ~/.toss/config.json is the durable source of truth + migration backup.
//
//   configValue        the value already saved in config (if any) — wins
//   existsOnBackend    whether the secret already exists on the backend (by name)
//   generate           mint a fresh secret (first deploy only)
//   opts.mustHaveValue caller needs a usable value even if that means rotating
//                      (OWNER_TOKEN: the CLI authenticates with it, so it can't
//                      be left unknown)
export interface ResolvedSecret {
  // The secret to use. Undefined only when it lives on the backend, we can't
  // read it, and we don't need it (JWT_SECRET on an already-deployed instance).
  value?: string;
  // Whether to push `value` to the backend.
  write: boolean;
  // Whether `value` is the real, current secret — i.e. safe to persist to config.
  known: boolean;
}

export function resolveSecret(
  configValue: string | undefined | null,
  existsOnBackend: boolean,
  generate: () => string,
  opts: { mustHaveValue?: boolean } = {}
): ResolvedSecret {
  if (configValue) {
    // Local source of truth wins. Push it only to seed a backend that lacks it
    // (fresh/recreated project/worker) — never overwrite an existing one.
    return { value: configValue, write: !existsOnBackend, known: true };
  }
  if (existsOnBackend && !opts.mustHaveValue) {
    // Backend has it, we can't read it, and we don't have a copy. Leave it be
    // (no rotation); we just can't create a local backup this time.
    return { value: undefined, write: false, known: false };
  }
  // True first deploy, or we must (re)establish a usable value we don't have.
  return { value: generate(), write: true, known: true };
}

// Fail closed on a weak/missing JWT_SECRET at deploy time. Signed password
// sessions depend on JWT_SECRET, so a secret shorter than 32 UTF-8 bytes must be
// rejected before it is used/written — bad config should fail the deploy, not
// live traffic. Measured in bytes (not UTF-16 code units) because that's the
// keying material's real entropy budget. `generateToken()` mints 32 random bytes
// → 64 hex chars, which passes.
export function assertStrongJwtSecret(value: string | undefined): void {
  const bytes = value ? new TextEncoder().encode(value).byteLength : 0;
  if (bytes < 32) {
    throw new Error('JWT_SECRET must be at least 32 bytes; refusing to deploy with a weak signing key.');
  }
}
