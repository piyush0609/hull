import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Live e2e of folder `--id` + re-share sub-file reconciliation + trailing-slash render,
// against a deployed toss-test (Vercel). Gated like the other e2e tests — skipped under
// `npm test`; run explicitly:
//   TOSS_E2E_FOLDER=1 npx vitest run tests/e2e/folder-id.test.ts
// Uses the `test` profile's owner token from ~/.toss/config.json and the stable alias.
const RUN = process.env.TOSS_E2E_FOLDER === '1';
const BASE = process.env.TOSS_E2E_BASE || 'https://toss-test-jade.vercel.app';

function testToken(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.toss', 'config.json'), 'utf-8'));
    return cfg.profiles?.test?.token || '';
  } catch {
    return '';
  }
}

describe.skipIf(!RUN)('folder --id e2e (live toss-test)', () => {
  const TOKEN = testToken();
  const SLUG = 'e2efolder-' + Math.random().toString(36).slice(2, 8);
  const ENTRY = '<!doctype html><html><head><link rel="stylesheet" href="./s.css"></head><body><a href="./p.html">p</a></body></html>';
  const authH = { Authorization: `Bearer ${TOKEN}` };
  let ID = '';

  const uploadEntry = async () => {
    const u = new URL(BASE + '/artifacts');
    u.searchParams.set('name', 'folder');
    u.searchParams.set('id', SLUG);
    const res = await fetch(u, { method: 'POST', headers: { ...authH, 'Content-Type': 'text/html' }, body: ENTRY });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  const uploadFile = async (path: string, body: string) => {
    const u = new URL(`${BASE}/artifacts/${ID}/files`);
    u.searchParams.set('path', path);
    const res = await fetch(u, { method: 'POST', headers: { ...authH, 'Content-Type': 'application/octet-stream' }, body });
    return res.status;
  };

  const serve = (path: string) => fetch(`${BASE}${path}`, { redirect: 'manual' });

  afterAll(async () => {
    if (ID) await fetch(`${BASE}/artifacts/${ID}`, { method: 'DELETE', headers: authH }).catch(() => {});
  });

  it('accepts --id for a folder and serves multipage assets', async () => {
    expect(TOKEN).toBeTruthy();
    const up = await uploadEntry();
    expect(up.status).toBe(200);
    expect(up.json?.slug).toBe(SLUG);
    ID = up.json.id;
    expect(await uploadFile('p.html', '<!doctype html><body>page</body>')).toBe(200);
    expect(await uploadFile('s.css', 'body{color:red}')).toBe(200);
    const page = await serve(`/s/${SLUG}/p.html`);
    expect(page.status).toBe(200);
    const css = await serve(`/s/${SLUG}/s.css`);
    expect(css.status).toBe(200);

    // Text assets must declare charset=utf-8. Without it the browser applies a locale
    // default (windows-1252 for en) and decodes UTF-8 bytes as mojibake — and a UTF-8
    // <script src>/<link> inherits the referencing document's encoding, so assets break
    // under a charset-less page too.
    const entry = await serve(`/s/${SLUG}/`);
    expect(entry.headers.get('content-type'), 'entry html charset').toMatch(/text\/html;\s*charset=utf-8/i);
    expect(page.headers.get('content-type'), 'sub-page html charset').toMatch(/text\/html;\s*charset=utf-8/i);
    expect(css.headers.get('content-type'), 'css charset').toMatch(/text\/css;\s*charset=utf-8/i);
  }, 30000);

  it('redirects the bare slug to the trailing-slash form', async () => {
    const r = await serve(`/s/${SLUG}`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(new RegExp(`/s/${SLUG}/$`));
  }, 30000);

  it('reconciles sub-files on re-share (a removed file 404s, no orphan)', async () => {
    expect((await serve(`/s/${SLUG}/p.html`)).status).toBe(200); // present before re-share
    const re = await uploadEntry(); // replace-in-place, WITHOUT re-uploading p.html
    expect(re.status).toBe(200);
    expect(re.json?.updated).toBe(true);
    expect((await serve(`/s/${SLUG}/p.html`)).status).toBe(404); // cleared, not re-uploaded
  }, 30000);
});
