import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Live end-to-end test of the comment feature against a deployed toss-test (Vercel).
// Gated like tests/e2e/live.test.ts — skipped under `npm test`; run explicitly with:
//   TOSS_E2E_COMMENTS=1 npx vitest run tests/e2e/comments.test.ts
// Uses the `test` profile's owner token from ~/.toss/config.json and the stable alias.
const RUN = process.env.TOSS_E2E_COMMENTS === '1';
const BASE = process.env.TOSS_E2E_BASE || 'https://toss-test-jade.vercel.app';

function testToken(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.toss', 'config.json'), 'utf-8'));
    return cfg.profiles?.test?.token || '';
  } catch {
    return '';
  }
}

describe.skipIf(!RUN)('comments e2e (live toss-test)', () => {
  const TOKEN = testToken();
  const SLUG = 'e2e-' + Math.random().toString(36).slice(2, 8);
  const PW = 'e2epw-' + Math.random().toString(36).slice(2, 6);
  const V1 = '<!doctype html><html><body><h1>E2E v1</h1><p>alpha</p></body></html>';
  const V2 = '<!doctype html><html><body><h1>E2E v2</h1><p>beta changed</p></body></html>';
  let ID = '';

  const upload = async (html: string, force = false) => {
    const u = new URL(BASE + '/artifacts');
    u.searchParams.set('name', 'e2e.html');
    u.searchParams.set('comments', '1');
    u.searchParams.set('id', SLUG);
    u.searchParams.set('password', PW);
    if (force) u.searchParams.set('force', '1');
    const res = await fetch(u, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/html' },
      body: html,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  const read = async (auth: { token?: string; password?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    if (auth.password) headers['X-Toss-Password'] = auth.password;
    const res = await fetch(`${BASE}/artifacts/${ID}/comment-threads?pagePath=index.html`, { headers });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  const post = async (body: string, auth: { token?: string; password?: string }) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Toss-Comment': '1', Origin: BASE };
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    if (auth.password) headers['X-Toss-Password'] = auth.password;
    const res = await fetch(`${BASE}/artifacts/${ID}/comment-threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'E2E', body, pagePath: 'index.html', scopeType: 'artifact' }),
    });
    return res.status;
  };

  beforeAll(async () => {
    expect(TOKEN, 'test profile token in ~/.toss/config.json').toBeTruthy();
    const c = await upload(V1);
    expect(c.status, 'create share').toBe(200);
    ID = c.json?.id;
  });

  afterAll(async () => {
    if (ID) await fetch(`${BASE}/artifacts/${ID}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } }).catch(() => {});
  });

  it('creates a password-protected, comments-enabled share', () => {
    expect(ID).toBeTruthy();
  });

  it('read access matrix: owner ✓, correct pw ✓, wrong pw ✗, no creds ✗', async () => {
    expect((await read({ token: TOKEN })).status, 'owner token').toBe(200);
    expect((await read({ password: PW })).status, 'correct password').toBe(200);
    expect((await read({ password: 'wrong-pw' })).status, 'wrong password').toBe(401);
    expect((await read()).status, 'no credentials').toBe(401);
  });

  it('accepts comments via owner token and via document password', async () => {
    expect(await post('owner comment', { token: TOKEN }), 'owner write').toBe(201);
    expect(await post('viewer comment via password', { password: PW }), 'password write').toBe(201);
  });

  it('lists both comments on the latest version', async () => {
    const r = await read({ token: TOKEN });
    expect(r.json.threads.length).toBe(2);
  });

  it('versioning: guard blocks no-op, force hides, content-change hides, latest-only', async () => {
    // identical content while comments exist → blocked
    expect((await upload(V1)).status, 'identical re-share guard').toBe(409);
    // force → new version; prior comments hidden
    expect((await upload(V1, true)).status, 'force re-share').toBe(200);
    expect((await read({ token: TOKEN })).json.threads.length, 'comments hidden after force').toBe(0);
    // comment on the new version → visible
    expect(await post('comment on the new version', { token: TOKEN })).toBe(201);
    expect((await read({ token: TOKEN })).json.threads.length, 'new-version comment visible').toBe(1);
    // changed content → new version (no force, no 409); prior comment hidden
    expect((await upload(V2)).status, 'changed-content re-share').toBe(200);
    expect((await read({ token: TOKEN })).json.threads.length, 'comments hidden after content change').toBe(0);
  }, 30000); // ~7 live round-trips (uploads mint versions); default 5s is too tight
});
