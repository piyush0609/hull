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

  it('versioning: guard blocks no-op, force carries forward, content-change carries forward, latest-only', async () => {
    // identical content while comments exist → blocked
    expect((await upload(V1)).status, 'identical re-share guard').toBe(409);
    // force → new version; 2 open comments from v1 carried forward to v2
    expect((await upload(V1, true)).status, 'force re-share').toBe(200);
    expect((await read({ token: TOKEN })).json.threads.length, 'open comments carried forward after force').toBe(2);
    // comment on the new version → visible alongside carried-forward threads
    expect(await post('comment on the new version', { token: TOKEN })).toBe(201);
    expect((await read({ token: TOKEN })).json.threads.length, 'new-version comment visible').toBe(3);
    // changed content → new version (no force, no 409); all 3 open comments from v2 carried to v3
    expect((await upload(V2)).status, 'changed-content re-share').toBe(200);
    expect((await read({ token: TOKEN })).json.threads.length, 'open comments carried forward after content change').toBe(3);
  }, 30000); // ~7 live round-trips (uploads mint versions); default 5s is too tight
});

describe.skipIf(!RUN)('carry-forward e2e (live toss-test)', () => {
  const TOKEN = testToken();
  const SLUG = 'e2ecf-' + Math.random().toString(36).slice(2, 8);
  let ID = '';
  let uploadId = 0;

  const read = async (auth: { token?: string; password?: string }) => {
    const headers: Record<string, string> = {};
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    if (auth.password) headers['X-Toss-Password'] = auth.password;
    const u = new URL(`${BASE}/artifacts/${ID}/comment-threads`);
    u.searchParams.set('includeActivity', '1');
    const res = await fetch(u, { headers });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  const upload = async (html: string, force?: boolean) => {
    const name = 'cf-test-' + (++uploadId);
    const u = new URL(`${BASE}/artifacts`);
    u.searchParams.set('name', name);
    u.searchParams.set('comments', '1');
    u.searchParams.set('id', SLUG);
    if (force) u.searchParams.set('force', '1');
    const res = await fetch(u, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/html' },
      body: html,
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  const postWithId = async (body: string, auth: { token?: string; password?: string }) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
    if (auth.password) headers['X-Toss-Password'] = auth.password;
    const res = await fetch(`${BASE}/artifacts/${ID}/comment-threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'E2E', body, pagePath: 'index.html', scopeType: 'artifact' }),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  const resolveThread = async (threadId: string, token: string) => {
    const res = await fetch(`${BASE}/comment-threads/${threadId}/resolve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E' }),
    });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  // Historical version read — note: the ?version=<seq> endpoint returns threads
  // across all pages for that version (no pagePath filter), which is fine since
  // all test threads are on index.html.
  const readVersion = async (version: number, token: string) => {
    const u = new URL(`${BASE}/artifacts/${ID}/comment-threads`);
    u.searchParams.set('version', String(version));
    const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, json: await res.json().catch(() => null) as any };
  };

  beforeAll(async () => {
    const V1 = '<!doctype html><h1>CF-V1</h1>';
    const r = await upload(V1);
    expect(r.status, 'upload v1').toBe(200);
    ID = r.json.id;
  });

  afterAll(async () => {
    if (ID) {
      await fetch(`${BASE}/artifacts/${ID}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
    }
  });

  it('carries forward open threads, excludes resolved threads', async () => {
    const V1 = '<!doctype html><h1>CF-V1</h1>';
    const V2 = '<!doctype html><h1>CF-V2</h1>';

    // 1. Post 3 comments: A, B, C
    const a = await postWithId('comment A', { token: TOKEN });
    const b = await postWithId('comment B', { token: TOKEN });
    const c = await postWithId('comment C', { token: TOKEN });
    expect(a.status, 'post A').toBe(201);
    expect(b.status, 'post B').toBe(201);
    expect(c.status, 'post C').toBe(201);
    const threadIdB = b.json.thread?.id || b.json.id;
    expect(threadIdB, 'thread B id').toBeTruthy();

    // 2. Resolve comment B
    const resolve = await resolveThread(threadIdB, TOKEN);
    expect(resolve.status, 'resolve B').toBe(200);

    // 3. Verify v1 has all 3 threads
    const v1 = await readVersion(1, TOKEN);
    expect(v1.status, 'read v1').toBe(200);
    expect(v1.json.threads.length, 'v1 thread count').toBe(3);

    // 4. Force re-share (new content) → mints v2
    const reup = await upload(V2, true);
    expect(reup.status, 'upload v2').toBe(200);

    // 5. Read latest → expect exactly 2 threads (A and C carried forward; B excluded)
    const latest = await read({ token: TOKEN });
    expect(latest.status, 'read latest').toBe(200);
    expect(latest.json.threads.length, 'latest thread count').toBe(2);

    const bodies = latest.json.threads.map((t: any) =>
      (t.messages && t.messages[0] && t.messages[0].body) || ''
    );
    expect(bodies).toContain('comment A');
    expect(bodies).toContain('comment C');
    expect(bodies).not.toContain('comment B');

    // 6. Read v1 again → still has all 3 original threads (A, B, C preserved)
    const v1again = await readVersion(1, TOKEN);
    expect(v1again.status, 'read v1 again').toBe(200);
    expect(v1again.json.threads.length, 'v1 still has 3').toBe(3);
  });
});
