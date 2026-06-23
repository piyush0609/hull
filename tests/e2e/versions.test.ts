import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Live e2e of previous-version comment retrieval (versions list + ?version=<seq>),
// against a deployed toss-test (Vercel). Gated like the other e2e tests — skipped
// under `npm test`; run explicitly AFTER deploying the updated template to test:
//   TOSS_E2E_VERSIONS=1 npx vitest run tests/e2e/versions.test.ts
// Uses the `test` profile's owner token from ~/.toss/config.json.
const RUN = process.env.TOSS_E2E_VERSIONS === '1';
const BASE = process.env.TOSS_E2E_BASE || 'https://toss-test-jade.vercel.app';

function testToken(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.toss', 'config.json'), 'utf-8'));
    return cfg.profiles?.test?.token || '';
  } catch {
    return '';
  }
}

describe.skipIf(!RUN)('previous-version comments e2e (live toss-test)', () => {
  const TOKEN = testToken();
  const SLUG = 'e2ever-' + Math.random().toString(36).slice(2, 8);
  const authH = { Authorization: `Bearer ${TOKEN}` };
  let ID = '';

  // POST /artifacts with the same id re-shares in place (mints a new version when
  // the entry content changes).
  const share = async (html: string) => {
    const u = new URL(BASE + '/artifacts');
    u.searchParams.set('name', 'vtest');
    u.searchParams.set('id', SLUG);
    u.searchParams.set('comments', '1');
    const res = await fetch(u, { method: 'POST', headers: { ...authH, 'Content-Type': 'text/html' }, body: html });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const postComment = async (body: string) => {
    const res = await fetch(`${BASE}/artifacts/${ID}/comment-threads`, {
      method: 'POST',
      headers: { ...authH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tester', body, scopeType: 'artifact', pagePath: 'index.html' }),
    });
    return res.status;
  };
  const getVersions = async () => {
    const res = await fetch(`${BASE}/artifacts/${ID}/versions`, { headers: authH });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const getThreads = async (version?: number) => {
    const u = new URL(`${BASE}/artifacts/${ID}/comment-threads`);
    u.searchParams.set('includeActivity', '1');
    if (version != null) u.searchParams.set('version', String(version));
    const res = await fetch(u, { headers: authH });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  const bodiesOf = (threads: any[]): string[] =>
    (threads || []).flatMap((t) => (t.messages || []).map((m: any) => m.body));

  afterAll(async () => {
    if (ID) await fetch(`${BASE}/artifacts/${ID}`, { method: 'DELETE', headers: authH }).catch(() => {});
  });

  it('lists versions and retrieves a previous version\'s comments', async () => {
    expect(TOKEN).toBeTruthy();

    // v1 + a comment, then a content change (mints v2) + a comment.
    const c1 = await share('<!doctype html><body>v1</body>');
    expect(c1.status).toBe(200);
    ID = c1.json.id;
    expect(await postComment('comment on v1')).toBe(201);

    const c2 = await share('<!doctype html><body>v2 changed</body>');
    expect(c2.status).toBe(200);
    expect(c2.json.updated).toBe(true);
    expect(await postComment('comment on v2')).toBe(201);

    // versions: two of them, current = seq 2, one comment each.
    const vs = await getVersions();
    expect(vs.status).toBe(200);
    const list = vs.json.versions as any[];
    expect(list.length).toBe(2);
    expect(list[0].seq).toBe(2);
    expect(list[0].is_current).toBe(true);
    expect(list.find((v) => v.seq === 1).comment_count).toBe(1);
    expect(list.find((v) => v.seq === 2).comment_count).toBe(1);

    // default read = latest (v2) only.
    const def = await getThreads();
    const defBodies = bodiesOf(def.json.activityThreads);
    expect(defBodies).toContain('comment on v2');
    expect(defBodies).not.toContain('comment on v1');

    // ?version=1 surfaces the previous version's comment (and not v2's).
    const v1 = await getThreads(1);
    expect(v1.status).toBe(200);
    const v1Bodies = bodiesOf(v1.json.threads);
    expect(v1Bodies).toContain('comment on v1');
    expect(v1Bodies).not.toContain('comment on v2');

    // unknown seq => 404.
    expect((await getThreads(9)).status).toBe(404);
  }, 30000);
});
