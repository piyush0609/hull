import { afterEach, describe, expect, it, vi } from 'vitest';

// JWT_SECRET is captured at module import time, so we must set it BEFORE importing
// the backend and re-import per secret variant. A strong 64-hex secret (32 bytes).
const STRONG_SECRET = 'a3f7c9e1d2b4a6085c7e9f1023456789abcdef0123456789abcdef0123456789';

async function loadBackend(env: { jwtSecret?: string; owner?: string; multiTenant?: boolean }, sql: any) {
  vi.resetModules();
  if (env.jwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = env.jwtSecret;
  if (env.owner === undefined) delete process.env.OWNER_TOKEN;
  else process.env.OWNER_TOKEN = env.owner;
  process.env.MULTI_TENANT = env.multiTenant ? 'true' : 'false';
  process.env.DATABASE_URL = 'postgres://example.invalid/toss';
  const backend = await import('../../src/templates/vercel/api/index.ts');
  backend.setVercelSqlForTests(sql);
  return backend;
}

function taggedSql(handler: (text: string, values: unknown[]) => any) {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => handler(strings.join('?'), values);
  return sql;
}

// --- Local HS256 signer (lets us forge alg-lie headers the backend must reject) ---
function b64url(bytes: Uint8Array | string): string {
  const str = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function signWith(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${b}`));
  return `${h}.${b}.${b64url(new Uint8Array(sig))}`;
}
async function sign(payload: Record<string, unknown>, secret: string): Promise<string> {
  return signWith({ alg: 'HS256', typ: 'JWT' }, payload, secret);
}
function nowSec(): number { return Math.floor(Date.now() / 1000); }

// A minimal stateful sql stub for the /s/:slug serve path.
function serveSql(artifact: { id: string; expires_at: number; password_hash: string | null; password_epoch: number; comments_enabled?: number }) {
  return taggedSql((text) => {
    if (text.includes('SELECT id, expires_at, password_hash, password_epoch FROM artifacts WHERE slug =')) {
      return [{ id: artifact.id, expires_at: artifact.expires_at, password_hash: artifact.password_hash, password_epoch: artifact.password_epoch }];
    }
    if (text.includes('SELECT current_version_id FROM artifacts WHERE id =')) {
      return [{ current_version_id: null }];
    }
    if (text.includes('SELECT comments_enabled, password_epoch FROM artifacts WHERE id =')) {
      return [{ comments_enabled: artifact.comments_enabled ?? 0, password_epoch: artifact.password_epoch }];
    }
    return [];
  });
}

// Stub the Blob fetch so successful HTML/asset serving returns content instead of 404.
function stubBlob(bodyByPath: (path: string) => string | null) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.includes('blob.vercel-storage.com')) {
      const path = new URL(urlStr).pathname.replace(/^\//, '');
      const body = bodyByPath(path);
      if (body == null) return new Response('Not found', { status: 404 });
      return new Response(body, { status: 200 });
    }
    return original(input, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.JWT_SECRET;
  delete process.env.OWNER_TOKEN;
  delete process.env.MULTI_TENANT;
  delete process.env.DATABASE_URL;
});

describe('Vercel signed password sessions', () => {
  const id = 'abc12345-1234-1234-1234-123456789abc';
  const otherId = 'othr1234-1234-1234-1234-123456789abc';
  const slug = 'signed-share';

  async function pwdHash(pw: string): Promise<string> {
    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(pw + id));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function sessionPayload(overrides: Record<string, unknown> = {}, subject = id, epoch = 0) {
    const iat = nowSec();
    return { sub: subject, aud: 'password-session', pwd_epoch: epoch, iat, exp: iat + 3600, ...overrides };
  }

  // Invalid cookies (forged `=1`, unsigned garbage, tampered signature) must be
  // rejected on BOTH the HTML entry (/s/<slug>/) AND sub-assets
  // (/s/<slug>/config.js): the asset request must show the password gate and
  // must NEVER leak the protected asset body.
  it.each([`/s/${slug}/`, `/s/${slug}/config.js`])('rejects a forged toss_pwd_<slug>=1 cookie on %s (shows the gate, no asset leak)', async (path) => {
    const restore = stubBlob((p) => (p.endsWith('files/config.js') ? 'console.log(1)' : null));
    try {
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const res = await backend.default(new Request(`https://toss.test${path}`, { headers: { Cookie: `toss_pwd_${slug}=1` } }));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Password Required');
      expect(body).not.toContain('console.log(1)');
    } finally {
      restore();
    }
  });

  it.each([`/s/${slug}/`, `/s/${slug}/config.js`])('rejects an unsigned/garbage cookie on %s (shows the gate, no asset leak)', async (path) => {
    const restore = stubBlob((p) => (p.endsWith('files/config.js') ? 'console.log(1)' : null));
    try {
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const res = await backend.default(new Request(`https://toss.test${path}`, { headers: { Cookie: `toss_pwd_${slug}=not-a-jwt` } }));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Password Required');
      expect(body).not.toContain('console.log(1)');
    } finally {
      restore();
    }
  });

  it.each([`/s/${slug}/`, `/s/${slug}/config.js`])('rejects a tampered signature on %s (shows the gate, no asset leak)', async (path) => {
    const restore = stubBlob((p) => (p.endsWith('files/config.js') ? 'console.log(1)' : null));
    try {
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const good = await sign(sessionPayload(), STRONG_SECRET);
      const tampered = good.slice(0, -3) + (good.slice(-3) === 'AAA' ? 'BBB' : 'AAA');
      const res = await backend.default(new Request(`https://toss.test${path}`, { headers: { Cookie: `toss_pwd_${slug}=${tampered}` } }));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Password Required');
      expect(body).not.toContain('console.log(1)');
    } finally {
      restore();
    }
  });

  it('correct password POST returns 302 + signed cookie (not =1)', async () => {
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
    const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'pw' }),
    }));
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('Set-Cookie') || '';
    expect(setCookie).toContain(`toss_pwd_${slug}=`);
    const value = setCookie.slice(setCookie.indexOf('=') + 1).split(';')[0];
    expect(value.split('.').length).toBe(3);
    expect(value).not.toBe('1');
  });

  it('a valid signed cookie permits the HTML entry and a sub-asset', async () => {
    const restore = stubBlob((path) => {
      if (path.endsWith('files/index.html')) return '<html>secret</html>';
      if (path.endsWith('files/config.js')) return 'console.log(1)';
      return null;
    });
    try {
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const token = await sign(sessionPayload(), STRONG_SECRET);
      const htmlRes = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `toss_pwd_${slug}=${token}` } }));
      expect(htmlRes.status).toBe(200);
      expect(await htmlRes.text()).toContain('<html>secret</html>');

      const assetRes = await backend.default(new Request(`https://toss.test/s/${slug}/config.js`, { headers: { Cookie: `toss_pwd_${slug}=${token}` } }));
      expect(assetRes.status).toBe(200);
      expect(await assetRes.text()).toContain('console.log(1)');
    } finally {
      restore();
    }
  });

  it('rejects other-artifact / expired / stale-epoch / missing-iat tokens', async () => {
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 1 }));

    const other = await sign(sessionPayload({}, otherId, 1), STRONG_SECRET);
    const expired = await sign(sessionPayload({ exp: nowSec() - 10 }, id, 1), STRONG_SECRET);
    const stale = await sign(sessionPayload({}, id, 0), STRONG_SECRET);
    const missingIat = await sign(sessionPayload({ iat: undefined }, id, 1), STRONG_SECRET);

    for (const bad of [other, expired, stale, missingIat]) {
      const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `toss_pwd_${slug}=${bad}` } }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Password Required');
    }
  });

  it('rejects exp === now (boundary) under frozen time (distinguishes <= from <)', async () => {
    vi.useFakeTimers();
    try {
      const fixed = 1_800_000_000;
      vi.setSystemTime(fixed * 1000);
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: fixed + 3600, password_hash: await pwdHash('pw'), password_epoch: 1 }));
      // exp exactly equals the frozen now — a `<` check would wrongly accept it,
      // only `exp <= now` rejects. Frozen time keeps exp === now (no second tick).
      const expNow = await sign(sessionPayload({ iat: fixed - 10, exp: fixed }, id, 1), STRONG_SECRET);
      const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `toss_pwd_${slug}=${expNow}` } }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Password Required');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a token whose pwd_epoch is malformed (missing / empty-string / false / non-integer)', async () => {
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
    for (const bad of [{ pwd_epoch: undefined }, { pwd_epoch: '' }, { pwd_epoch: false }, { pwd_epoch: 1.5 }]) {
      const token = await sign(sessionPayload(bad as Record<string, unknown>), STRONG_SECRET);
      const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `toss_pwd_${slug}=${token}` } }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Password Required');
    }
  });

  it('caps a permanent-share session cookie to 24h (Max-Age=86400)', async () => {
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: 0, password_hash: await pwdHash('pw'), password_epoch: 0 }));
    const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'pw' }),
    }));
    expect(res.status).toBe(302);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=86400');
  });

  it('caps a temporary-share session to remaining time with token exp <= expiry (one now)', async () => {
    vi.useFakeTimers();
    try {
      const fixed = 1_800_000_000;
      vi.setSystemTime(fixed * 1000);
      const expiresAt = fixed + 3600;
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: expiresAt, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'pw' }),
      }));
      expect(res.status).toBe(302);
      const setCookie = res.headers.get('Set-Cookie') || '';
      expect(setCookie).toContain('Max-Age=3600');
      const value = setCookie.slice(`toss_pwd_${slug}=`.length).split(';')[0];
      const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      expect(payload.exp).toBe(expiresAt);
      expect(payload.exp - payload.iat).toBe(3600);
    } finally {
      vi.useRealTimers();
    }
  });

  it('parses the cookie by exact name and tolerates whitespace/no-space segments', async () => {
    const restore = stubBlob((path) => (path.endsWith('files/index.html') ? '<html>secret</html>' : null));
    try {
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const token = await sign(sessionPayload(), STRONG_SECRET);

      // Superstring name must NOT match.
      const superstring = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `nottoss_pwd_${slug}=${token}` } }));
      expect(superstring.status).toBe(200);
      expect(await superstring.text()).toContain('Password Required');

      // No-space header succeeds.
      const noSpace = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `other=1;toss_pwd_${slug}=${token}` } }));
      expect(noSpace.status).toBe(200);
      expect(await noSpace.text()).toContain('<html>secret</html>');

      // Multiple spaces/tabs succeed.
      const spaced = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `a=1; \t  b=2;   toss_pwd_${slug}=${token}` } }));
      expect(spaced.status).toBe(200);
      expect(await spaced.text()).toContain('<html>secret</html>');
    } finally {
      restore();
    }
  });

  it('fails closed with 500 (no cookie) for a weak secret, but serves an unprotected share', async () => {
    const backendWeak = await loadBackend({ jwtSecret: 'short' }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
    const res = await backendWeak.default(new Request(`https://toss.test/s/${slug}/`));
    expect(res.status).toBe(500);
    expect(res.headers.get('Set-Cookie')).toBeNull();

    const restore = stubBlob((path) => (path.endsWith('files/index.html') ? '<html>open</html>' : null));
    try {
      const backendOpen = await loadBackend({ jwtSecret: 'short' }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: null, password_epoch: 0 }));
      const openRes = await backendOpen.default(new Request(`https://toss.test/s/${slug}/`));
      expect(openRes.status).toBe(200);
      expect(await openRes.text()).toContain('<html>open</html>');
    } finally {
      restore();
    }
  });

  it('rejects an empty/missing secret the same way (500, no cookie)', async () => {
    const backend = await loadBackend({ jwtSecret: '' }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
    const res = await backend.default(new Request(`https://toss.test/s/${slug}/`));
    expect(res.status).toBe(500);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  describe('alg pinning', () => {
    it('rejects a token whose header declares "none" but carries a valid HS256 HMAC', async () => {
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const token = await signWith({ alg: 'none', typ: 'JWT' }, sessionPayload(), STRONG_SECRET);
      const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `toss_pwd_${slug}=${token}` } }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Password Required');
    });

    it('rejects a token whose header declares "HS512" over a valid HS256 signing input', async () => {
      const backend = await loadBackend({ jwtSecret: STRONG_SECRET }, serveSql({ id, expires_at: nowSec() + 3600, password_hash: await pwdHash('pw'), password_epoch: 0 }));
      const token = await signWith({ alg: 'HS512', typ: 'JWT' }, sessionPayload(), STRONG_SECRET);
      const res = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `toss_pwd_${slug}=${token}` } }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Password Required');
    });
  });
});

describe('Vercel race-safe password_epoch bump on re-share', () => {
  const OWNER = 'owner-token';
  const slug = 'epoch-share';
  const html = '<html>same-content</html>';

  async function hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // A tiny stateful Postgres-like harness modeling one artifact. Both the
  // metadata-only re-share UPDATE (same content, no comments) and the
  // content-changing mintVersion transaction run the same `password_epoch +
  // CASE WHEN password_hash IS DISTINCT FROM ?` fragment, so the epoch bump is
  // decided against the stored password_hash *at apply time* — mirroring how
  // Postgres evaluates the SET clause against the pre-update row. Real DB-level
  // concurrency is exercised by the gated Postgres suite
  // (tests/integration/vercel-comment-labels-postgres.test.ts); here we model
  // apply-time evaluation so interleaved re-shares each bump exactly once.
  function makeHarness(artifact: { id: string; token_hash: string; password_hash: string | null; password_epoch: number; comments_enabled: number; expires_at: number; content_hash: string; ownerHash: string }) {
    const handler = (text: string, values: unknown[]) => {
      if (text.includes('SELECT COUNT(*)::int as c FROM users')) return [{ c: 1 }];
      if (text.includes('SELECT is_admin, label FROM users WHERE token_hash =')) {
        return values[0] === artifact.ownerHash ? [{ is_admin: 1, label: 'admin' }] : [];
      }
      if (text.includes('SELECT id, token_hash FROM artifacts WHERE slug =')) {
        return [{ id: artifact.id, token_hash: artifact.token_hash }];
      }
      if (text.includes('SELECT id, expires_at, password_hash, password_epoch FROM artifacts WHERE slug =')) {
        return [{ id: artifact.id, expires_at: artifact.expires_at, password_hash: artifact.password_hash, password_epoch: artifact.password_epoch }];
      }
      if (text.includes('SELECT id FROM artifacts WHERE id =') && text.includes('FOR UPDATE')) {
        return [{ id: artifact.id }];
      }
      if (text.includes('SELECT current_version_id FROM artifacts WHERE id =')) {
        return [{ current_version_id: null }];
      }
      if (text.includes('SELECT av.content_hash AS chash')) {
        return [{ chash: artifact.content_hash }];
      }
      if (text.includes('SELECT COUNT(*)::int AS n FROM comment_threads')) {
        return [{ n: 0 }];
      }
      // The mintVersion WITH ... RETURNING statement — must return a row so the
      // transaction's publish check (results[1]?.[0]) passes.
      if (text.includes('INSERT INTO artifact_versions') && text.includes('FROM inserted_version')) {
        return [{ id: 'version-id', seq: 1, copied_thread_count: 0, copied_message_count: 0, grandfathered_thread_count: 0 }];
      }
      // Both the metadata-only UPDATE and the mintVersion transaction UPDATE
      // share this prefix. values: [name, sizeBytes, newExpiresAt, compareHash,
      // assignHash, ...]. The CASE compares against the stored hash at apply
      // time, then the assignment overwrites it.
      if (text.includes('UPDATE artifacts SET name = ?, size_bytes = ?, expires_at = ?, password_epoch = password_epoch + CASE WHEN password_hash IS DISTINCT FROM ?')) {
        const compareHash = values[3] == null ? null : String(values[3]);
        const assignHash = values[4] == null ? null : String(values[4]);
        if ((artifact.password_hash ?? null) !== compareHash) {
          artifact.password_epoch += 1;
        }
        artifact.expires_at = Number(values[2]);
        artifact.password_hash = assignHash;
        return [{ id: artifact.id }];
      }
      // requireCommentAccess row.
      if (text.includes('SELECT comments_enabled, expires_at, password_epoch, token_hash, password_hash FROM artifacts WHERE id =')) {
        return [{ comments_enabled: artifact.comments_enabled, expires_at: artifact.expires_at, password_epoch: artifact.password_epoch, token_hash: artifact.token_hash, password_hash: artifact.password_hash }];
      }
      return [];
    };
    const sql = taggedSql(handler);
    // Neon HTTP transactions execute their predefined statements sequentially;
    // model that by evaluating each tagged statement through the same handler.
    sql.transaction = (build: (tx: any) => any[]) => {
      const tx = taggedSql(handler);
      return Promise.resolve(build(tx));
    };
    return { sql, artifact };
  }

  // Blob stub: staging PUTs succeed (return JSON), reads 404 (no serve here).
  function stubBlobOk() {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const urlStr = typeof input === 'string' ? input : input.url;
      if (urlStr.includes('blob.vercel-storage.com')) return new Response('{}', { status: 200 });
      return original(input, init);
    }) as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  async function reshare(backend: any, opts: { password?: string; body?: string } = {}) {
    const params = new URLSearchParams({ name: 'v.html', id: slug, expires: '3600' });
    if (opts.password !== undefined) params.set('password', opts.password);
    return backend.default(new Request(`https://toss.test/artifacts?${params.toString()}`, {
      method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: opts.body ?? html,
    }));
  }

  it('does NOT bump when the same password is re-shared (same hash)', async () => {
    const id = 'aaa11111-1111-1111-1111-111111111111';
    const ownerHash = await hex(OWNER);
    const pwHash = await hex('pw' + id);
    const { sql, artifact } = makeHarness({ id, token_hash: ownerHash, password_hash: pwHash, password_epoch: 0, comments_enabled: 0, expires_at: nowSec() + 3600, content_hash: await hex(html), ownerHash });
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET, owner: OWNER, multiTenant: true }, sql);
    const res = await reshare(backend, { password: 'pw' });
    expect(res.status).toBe(200);
    expect(artifact.password_epoch).toBe(0);
  });

  it('bumps on null -> hash and hash -> different; old session fails serve gate and old grant fails', async () => {
    const id = 'bbb22222-2222-2222-2222-222222222222';
    const ownerHash = await hex(OWNER);
    const state = { id, token_hash: ownerHash, password_hash: null as string | null, password_epoch: 0, comments_enabled: 1, expires_at: nowSec() + 3600, content_hash: await hex(html), ownerHash };
    const { sql, artifact } = makeHarness(state);
    let backend = await loadBackend({ jwtSecret: STRONG_SECRET, owner: OWNER, multiTenant: true }, sql);

    const oldGrant = await sign({ sub: id, aud: 'comment', pwd_epoch: 0, iat: nowSec(), exp: nowSec() + 3600 }, STRONG_SECRET);
    const oldSession = await sign({ sub: id, aud: 'password-session', pwd_epoch: 0, iat: nowSec(), exp: nowSec() + 3600 }, STRONG_SECRET);

    // null -> hash: epoch 1.
    await reshare(backend, { password: 'pw1' });
    expect(artifact.password_epoch).toBe(1);

    // Serve gate: the old session (epoch 0) is now stale against epoch 1.
    const gate = await backend.default(new Request(`https://toss.test/s/${slug}/`, { headers: { Cookie: `toss_pwd_${slug}=${oldSession}` } }));
    expect(gate.status).toBe(200);
    expect(await gate.text()).toContain('Password Required');

    // Old comment grant (epoch 0) rejected against epoch 1.
    const comment = await backend.default(new Request(`https://toss.test/artifacts/${id}/comment-threads?pagePath=index.html`, { headers: { 'X-Toss-Viewer': oldGrant } }));
    expect(comment.status).toBe(401);

    // hash -> different: epoch 2.
    await reshare(backend, { password: 'pw2' });
    expect(artifact.password_epoch).toBe(2);
  });

  it('bumps on hash -> null; old grant fails and helper verifies old session false', async () => {
    const id = 'ccc33333-3333-3333-3333-333333333333';
    const ownerHash = await hex(OWNER);
    const state = { id, token_hash: ownerHash, password_hash: await hex('pw' + id), password_epoch: 0, comments_enabled: 1, expires_at: nowSec() + 3600, content_hash: await hex(html), ownerHash };
    const { sql, artifact } = makeHarness(state);
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET, owner: OWNER, multiTenant: true }, sql);

    const oldGrant = await sign({ sub: id, aud: 'comment', pwd_epoch: 0, iat: nowSec(), exp: nowSec() + 3600 }, STRONG_SECRET);
    const oldSession = await sign({ sub: id, aud: 'password-session', pwd_epoch: 0, iat: nowSec(), exp: nowSec() + 3600 }, STRONG_SECRET);

    // hash -> null: epoch 1.
    await reshare(backend, {});
    expect(artifact.password_epoch).toBe(1);

    // Old comment grant rejected.
    const comment = await backend.default(new Request(`https://toss.test/artifacts/${id}/comment-threads?pagePath=index.html`, { headers: { 'X-Toss-Viewer': oldGrant } }));
    expect(comment.status).toBe(401);

    // Share is now unprotected: verify the old session directly (helper-level).
    expect(await backend.verifyPasswordSessionForTests(oldSession, id, 1, STRONG_SECRET)).toBe(false);

    // Optional second bump: set a password again -> epoch 2; older token still invalid.
    await reshare(backend, { password: 'again' });
    expect(artifact.password_epoch).toBe(2);
    expect(await backend.verifyPasswordSessionForTests(oldSession, id, 2, STRONG_SECRET)).toBe(false);
  });

  it('bumps exactly once per committed transition under two concurrent different-password re-shares (Promise.all)', async () => {
    const id = 'ddd44444-4444-4444-4444-444444444444';
    const ownerHash = await hex(OWNER);
    const state = { id, token_hash: ownerHash, password_hash: null as string | null, password_epoch: 0, comments_enabled: 0, expires_at: nowSec() + 3600, content_hash: await hex(html), ownerHash };
    const { sql, artifact } = makeHarness(state);
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET, owner: OWNER, multiTenant: true }, sql);

    // Two DIFFERENT passwords launched together. The in-SQL CASE compares each
    // against the stored hash when its UPDATE applies, so each distinct
    // transition (null->pwA, pwA->pwB) bumps exactly once — epoch settles at 2.
    // (Real DB concurrency is covered by the gated Postgres suite; this asserts
    // apply-time evaluation, not driver-level interleaving.)
    const [resA, resB] = await Promise.all([
      reshare(backend, { password: 'pwA' }),
      reshare(backend, { password: 'pwB' }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(artifact.password_epoch).toBe(2);

    // A same-hash (no-op) transition against the current password does NOT bump.
    const currentPw = artifact.password_hash === (await hex('pwA' + id)) ? 'pwA' : 'pwB';
    await reshare(backend, { password: currentPw });
    expect(artifact.password_epoch).toBe(2);
  });

  it('bumps the epoch on the content-changing mintVersion transaction path too', async () => {
    const id = 'eee55555-5555-5555-5555-555555555555';
    const ownerHash = await hex(OWNER);
    // content_hash differs from hex(newBody) below, so contentChanged is true and
    // the publish routes through mintVersion (not the metadata-only UPDATE).
    const state = { id, token_hash: ownerHash, password_hash: null as string | null, password_epoch: 0, comments_enabled: 0, expires_at: nowSec() + 3600, content_hash: await hex('<html>old</html>'), ownerHash };
    const { sql, artifact } = makeHarness(state);
    const backend = await loadBackend({ jwtSecret: STRONG_SECRET, owner: OWNER, multiTenant: true }, sql);

    const restore = stubBlobOk();
    try {
      // null -> hash via mintVersion (new content): epoch 1.
      const res = await reshare(backend, { password: 'pw1', body: '<html>new-v1</html>' });
      expect(res.status).toBe(200);
      expect(artifact.password_epoch).toBe(1);

      // hash -> different via mintVersion (new content again): epoch 2.
      const res2 = await reshare(backend, { password: 'pw2', body: '<html>new-v2</html>' });
      expect(res2.status).toBe(200);
      expect(artifact.password_epoch).toBe(2);

      // Same password with new content: content bumps a version but the CASE
      // sees an identical hash, so the epoch does NOT bump.
      const res3 = await reshare(backend, { password: 'pw2', body: '<html>new-v3</html>' });
      expect(res3.status).toBe(200);
      expect(artifact.password_epoch).toBe(2);
    } finally {
      restore();
    }
  });
});
