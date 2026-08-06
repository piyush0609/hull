import { describe, expect, it, vi } from 'vitest';

// The comment API answers a stale grant with a JSON body so the message reaches
// ALREADY-OPEN tabs: the widget renders `data.error` and falls back to the
// useless "Request failed: 401" only when the body will not parse. These tests
// pin which 401s carry that message and, just as importantly, which do NOT —
// `!token` is reachable by a CLI call with a bad owner token, where "reload the
// page" would be nonsense.

const STRONG_SECRET = 'a3f7c9e1d2b4a6085c7e9f1023456789abcdef0123456789abcdef0123456789';
const OWNER = 'owner-token';
const ID = 'aaaa1111-2222-3333-4444-555555555555';
const URL_ = `https://toss.test/artifacts/${ID}/comment-threads?pagePath=index.html`;
const RELOAD = /reload the page/i;

function nowSec(): number { return Math.floor(Date.now() / 1000); }

function taggedSql(handler: (text: string, values: unknown[]) => any) {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => handler(strings.join('?'), values);
  sql.transaction = (build: (tx: any) => any[]) => Promise.resolve(build(taggedSql(handler)));
  return sql;
}

async function loadBackend(sql: any) {
  vi.resetModules();
  process.env.JWT_SECRET = STRONG_SECRET;
  process.env.OWNER_TOKEN = OWNER;
  process.env.MULTI_TENANT = 'false';
  process.env.DATABASE_URL = 'postgres://example.invalid/toss';
  const backend = await import('../../src/templates/vercel/api/index.ts');
  backend.setVercelSqlForTests(sql);
  return backend;
}

async function hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One artifact: comments on, live, password-protected, epoch 1 (post-rollout).
function harness(over: Record<string, unknown> = {}) {
  const row = {
    comments_enabled: 1,
    expires_at: nowSec() + 3600,
    password_epoch: 1,
    token_hash: 'a-different-owners-hash',
    password_hash: 'stored-password-hash',
    ...over,
  };
  return taggedSql((text: string) => {
    if (text.includes('SELECT comments_enabled, expires_at, password_epoch, token_hash, password_hash FROM artifacts WHERE id =')) return [row];
    // Only the owner test gets past requireCommentAccess; give the snapshot read
    // a well-formed empty result so that path ends in 200 instead of a 500.
    if (text.includes('comment_labels') || text.includes('threads')) {
      return [{ found: true, revision: 1, comment_labels: [], threads: [], activity_threads: [], max_version: 0, version_id: null }];
    }
    return [];
  });
}

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function sign(payload: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(STRONG_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${h}.${b}`));
  const s = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${h}.${b}.${s}`;
}

const get = (backend: any, headers: Record<string, string> = {}) => backend.default(new Request(URL_, { headers }));

describe('stale comment grant → actionable JSON 401', () => {
  it('epoch mismatch (password change / 0012 rollout) returns JSON telling the viewer to reload', async () => {
    const backend = await loadBackend(harness({ password_epoch: 1 }));
    const grant = await sign({ sub: ID, aud: 'comment', pwd_epoch: 0, iat: nowSec(), exp: nowSec() + 3600 });
    const res = await get(backend, { 'X-Toss-Viewer': grant });

    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const body = await res.json();
    expect(body.error).toMatch(RELOAD);
    // The widget surfaces `data.error`; anything unparseable degrades to "Request failed: 401".
    expect(typeof body.error).toBe('string');
  });

  it('time-expired grant returns the same JSON message', async () => {
    const backend = await loadBackend(harness());
    const grant = await sign({ sub: ID, aud: 'comment', pwd_epoch: 1, iat: nowSec() - 7200, exp: nowSec() - 60 });
    const res = await get(backend, { 'X-Toss-Viewer': grant });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(RELOAD);
  });

  it('unverifiable grant (garbage / bad signature) returns the same JSON message', async () => {
    const backend = await loadBackend(harness());
    for (const bad of ['not-a-jwt', 'a.b.c', `${b64url('{"alg":"HS256"}')}.${b64url('{"sub":"x"}')}.wrongsig`]) {
      const res = await get(backend, { 'X-Toss-Viewer': bad });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toMatch(RELOAD);
    }
  });

  it('the message never promises whether the password will be asked for again', async () => {
    // The password cookie is Path=/s/<slug> and is never sent to the comment API,
    // so the server cannot know if the password session survived. The copy must
    // stay true whether the reload is seamless or lands on the password form.
    const backend = await loadBackend(harness());
    const grant = await sign({ sub: ID, aud: 'comment', pwd_epoch: 0, iat: nowSec(), exp: nowSec() + 3600 });
    const { error } = await (await get(backend, { 'X-Toss-Viewer': grant })).json();

    expect(error).not.toMatch(/enter .*password|re-?enter|type .*password/i);
    expect(error).not.toMatch(/password is (still )?(valid|correct|fine)/i);
    expect(error).not.toMatch(/log ?in again/i);
  });
});

describe('401s that must NOT get the reload message', () => {
  it('missing grant stays plain text — a CLI with a bad owner token lands here', async () => {
    const backend = await loadBackend(harness());
    const res = await get(backend); // no X-Toss-Viewer, no Authorization

    expect(res.status).toBe(401);
    expect(res.headers.get('Content-Type') || '').not.toContain('application/json');
    const text = await res.text();
    expect(text).toBe('Missing comment grant');
    expect(text).not.toMatch(RELOAD);
  });

  it('a wrong owner token also lands on the plain-text missing-grant 401, not the reload message', async () => {
    const backend = await loadBackend(harness());
    const res = await get(backend, { Authorization: 'Bearer not-the-owner-token' });

    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(RELOAD);
  });
});

describe('states a reload cannot fix are not 401s at all', () => {
  it('comments disabled → 404, never the reload message', async () => {
    const backend = await loadBackend(harness({ comments_enabled: 0 }));
    const grant = await sign({ sub: ID, aud: 'comment', pwd_epoch: 1, iat: nowSec(), exp: nowSec() + 3600 });
    const res = await get(backend, { 'X-Toss-Viewer': grant });

    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(RELOAD);
  });

  it('expired artifact → 410, never the reload message', async () => {
    const backend = await loadBackend(harness({ expires_at: nowSec() - 60 }));
    const grant = await sign({ sub: ID, aud: 'comment', pwd_epoch: 1, iat: nowSec(), exp: nowSec() + 3600 });
    const res = await get(backend, { 'X-Toss-Viewer': grant });

    expect(res.status).toBe(410);
    expect(await res.text()).not.toMatch(RELOAD);
  });

  it('grant for a different artifact → 403, never the reload message', async () => {
    const backend = await loadBackend(harness());
    const grant = await sign({ sub: 'bbbb2222-3333-4444-5555-666666666666', aud: 'comment', pwd_epoch: 1, iat: nowSec(), exp: nowSec() + 3600 });
    const res = await get(backend, { 'X-Toss-Viewer': grant });

    expect(res.status).toBe(403);
    expect(await res.text()).not.toMatch(RELOAD);
  });
});

describe('owner access is unaffected by the stale-grant path', () => {
  it('the artifact owner never reaches a grant 401', async () => {
    const ownerHash = await hex(OWNER);
    const backend = await loadBackend(harness({ token_hash: ownerHash }));
    const res = await get(backend, { Authorization: `Bearer ${OWNER}` });

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
  });
});
