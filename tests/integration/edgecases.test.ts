import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/templates/worker/src/index.js';
import { signJWT } from '../../src/templates/worker/src/jwt.js';
import { MockKV, MockD1, SECRET, OWNER, createEnv } from './helpers.js';

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('Worker Edge Cases', () => {
  let kv: MockKV;
  let db: MockD1;

  beforeEach(() => {
    kv = new MockKV();
    db = new MockD1();
  });

  describe('Upload', () => {
    it('should default name to untitled.html when missing', async () => {
      const req = new Request('http://localhost/artifacts?expires=3600', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBeDefined();
    });

    it('should treat expires=0 as permanent (200 + slug returned)', async () => {
      const req = new Request('http://localhost/artifacts?expires=0&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string; slug: string };
      expect(body.slug).toMatch(/^[a-z0-9]{12}$/);
    });

    it('should reject expires > 90 days', async () => {
      const req = new Request(`http://localhost/artifacts?expires=${91 * 24 * 60 * 60}&name=test.html`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(400);
    });

    it('should handle HTML with Unicode characters', async () => {
      const html = '<html><body>日本語 🎉</body></html>';
      const req = new Request('http://localhost/artifacts?expires=3600&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: html,
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      const body = await res.json();

      const versionKeys = await kv.list({ prefix: `artifacts/${body.id}/versions/` });
      expect(versionKeys.keys).toHaveLength(1);
      const stored = await kv.get(versionKeys.keys[0].name);
      expect(stored).toBe(html);
    });

    it('should reject path traversal in file upload', async () => {
      const createReq = new Request('http://localhost/artifacts?expires=3600&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const createRes = await worker.fetch(createReq, createEnv(kv, db));
      expect(createRes.status).toBe(200);
      const { id } = await createRes.json();

      const req = new Request(`http://localhost/artifacts/${id}/files?path=../../../etc/passwd`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: 'secret',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(400);
    });

    it('should normalize paths with dots and slashes', async () => {
      const createReq = new Request('http://localhost/artifacts?expires=3600&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const createRes = await worker.fetch(createReq, createEnv(kv, db));
      expect(createRes.status).toBe(200);
      const { id } = await createRes.json();

      const req = new Request(`http://localhost/artifacts/${id}/files?path=./css//style.css`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: 'body{}',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);

      const stored = await kv.get(`artifacts/${id}/files/css/style.css`);
      expect(stored).toBe('body{}');
    });
  });

  describe('Serve', () => {
    it('should reject token at exact expiry boundary', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'abc123', iat: now - 3600, exp: now - 1 }, SECRET);

      const req = new Request(`http://localhost/a/abc123/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(410);
    });

    it('should accept token 1 second before expiry', async () => {
      await kv.put('artifacts/abc123/files/index.html', '<html>ok</html>');

      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'abc123', iat: now - 3600, exp: now + 1 }, SECRET);

      const req = new Request(`http://localhost/a/abc123/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
    });

    it('should return 404 for missing artifact even with valid token', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'missing', iat: now, exp: now + 3600 }, SECRET);

      const req = new Request(`http://localhost/a/missing/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(404);
    });

    it('should set security headers on served HTML', async () => {
      await kv.put('artifacts/abc123/files/index.html', '<html></html>');

      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'abc123', iat: now, exp: now + 3600 }, SECRET);

      const req = new Request(`http://localhost/a/abc123/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));

      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    });

    it('should serve non-HTML assets as revalidatable, not immutable', async () => {
      // A slug share is mutable (`toss share --id` re-publishes the same filenames),
      // so assets must revalidate — `immutable` froze stale bytes for up to 24h.
      await kv.put('artifacts/abc123/files/app.js', 'console.log(1)');

      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'abc123', iat: now, exp: now + 3600 }, SECRET);

      const req = new Request(`http://localhost/a/abc123/app.js?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
      expect(res.headers.get('Cache-Control')).not.toContain('immutable');
    });

    it('should keep serving stable non-HTML assets when an artifact has a current version', async () => {
      const statefulDb = new MockD1();
      const artifactId = 'abc12345-1234-1234-1234-123456789abc';
      statefulDb.setRows([{ id: artifactId, current_version_id: 'version-1' }]);
      await kv.put(`artifacts/${artifactId}/files/app.js`, 'console.log("stable asset")');

      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: artifactId, iat: now, exp: now + 3600 }, SECRET);
      const res = await worker.fetch(
        new Request(`http://localhost/a/${artifactId}/app.js?t=${token}`),
        createEnv(kv, statefulDb),
      );

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('console.log("stable asset")');
    });
  });

  describe('Delete', () => {
    it('should not crash when deleting non-existent artifact', async () => {
      const req = new Request('http://localhost/artifacts/abc12345-1234-1234-1234-123456789abc', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${OWNER}` },
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
    });
  });

  describe('Password Protection', () => {
    it('should require password for protected shares', async () => {
      const id = 'abc12345-1234-1234-1234-123456789abc';
      const slug = 'secret-ABCD';
      const now = Math.floor(Date.now() / 1000);
      const enc = new TextEncoder();
      const digest = await crypto.subtle.digest('SHA-256', enc.encode('mypassword' + id));
      const passwordHash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // Seed artifact in mock DB
      db.setRows([{
        id,
        slug,
        name: 'secret.html',
        size_bytes: 100,
        created_at: now,
        expires_at: now + 3600,
        token_hash: 'any',
        password_hash: passwordHash,
      }]);
      await kv.put(`artifacts/${id}/files/index.html`, '<html>secret</html>');

      // GET without password should show form
      const getReq = new Request(`http://localhost/s/${slug}/`);
      const getRes = await worker.fetch(getReq, createEnv(kv, db));
      expect(getRes.status).toBe(200);
      const body = await getRes.text();
      expect(body).toContain('Password Required');

      // POST with wrong password should show error
      const wrongReq = new Request(`http://localhost/s/${slug}/`, {
        method: 'POST',
        body: new URLSearchParams({ password: 'wrong' }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const wrongRes = await worker.fetch(wrongReq, createEnv(kv, db));
      expect(wrongRes.status).toBe(401);

      // POST with correct password should redirect with cookie
      const correctReq = new Request(`http://localhost/s/${slug}/`, {
        method: 'POST',
        body: new URLSearchParams({ password: 'mypassword' }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const correctRes = await worker.fetch(correctReq, createEnv(kv, db));
      expect(correctRes.status).toBe(302);
      expect(correctRes.headers.get('Set-Cookie')).toContain(`toss_pwd_${slug}=1`);
    });

    it('should mark the password gate no-store so it cannot be cached against asset URLs', async () => {
      // Regression: the gate is returned for ANY unauthenticated path under a
      // protected slug, including sub-resource assets. Assets are otherwise
      // `public, max-age=0, must-revalidate`, so without `no-store` a shared
      // cache could store this 200 gate HTML keyed to /s/<slug>/config.js and
      // replay it after auth — the browser then runs HTML as JS and the page
      // breaks (e.g. "config.js missing or stale").
      const id = 'bbb12345-1234-1234-1234-123456789abc';
      const slug = 'gated-assets';
      const now = Math.floor(Date.now() / 1000);
      const passwordHash = await sha256Hex('pw' + id);
      db.setRows([{ id, slug, expires_at: now + 3600, password_hash: passwordHash }]);

      // The HTML entry, with no session cookie.
      const pageRes = await worker.fetch(new Request(`http://localhost/s/${slug}/`), createEnv(kv, db));
      expect(pageRes.status).toBe(200);
      expect(await pageRes.text()).toContain('Password Required');
      expect(pageRes.headers.get('Cache-Control')).toBe('no-store');
      expect(pageRes.headers.get('Vary')).toBe('Cookie');

      // A sub-resource asset request, still unauthenticated, must also be no-store —
      // this is the URL that would otherwise get poisoned in a shared cache.
      const assetRes = await worker.fetch(new Request(`http://localhost/s/${slug}/config.js`), createEnv(kv, db));
      expect(assetRes.headers.get('Cache-Control')).toBe('no-store');

      // Wrong password (401) is non-cacheable too.
      const wrongRes = await worker.fetch(new Request(`http://localhost/s/${slug}/`, {
        method: 'POST',
        body: new URLSearchParams({ password: 'nope' }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }), createEnv(kv, db));
      expect(wrongRes.status).toBe(401);
      expect(wrongRes.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  describe('Stable slug (--id)', () => {
    it('should create new artifact with caller-supplied slug', async () => {
      const req = new Request('http://localhost/artifacts?expires=3600&name=test.html&id=my-stable-slug', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>hello</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      const body = await res.json() as { slug: string; updated?: boolean };
      expect(body.slug).toBe('my-stable-slug');
      expect(body.updated).toBeUndefined();
    });

    it('should replace-in-place when owner re-shares same slug', async () => {
      const ownerHash = await sha256Hex(OWNER);
      db.setRows([{
        id: 'abc12345-1234-1234-1234-123456789abc',
        slug: 'my-stable-slug',
        token_hash: ownerHash,
      }]);
      const req = new Request('http://localhost/artifacts?expires=3600&name=updated.html&id=my-stable-slug', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>updated</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      const body = await res.json() as { slug: string; updated?: boolean };
      expect(body.slug).toBe('my-stable-slug');
      expect(body.updated).toBe(true);
    });

    it('should reject replace by a different tenant (409)', async () => {
      db.setRows([{
        id: 'abc12345-1234-1234-1234-123456789abc',
        slug: 'my-stable-slug',
        token_hash: 'a-different-tenants-hash',
      }]);
      const req = new Request('http://localhost/artifacts?expires=3600&name=hijack.html&id=my-stable-slug', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>hijack</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(409);
    });

    for (const reserved of ['s', 'a', 'tokens', 'artifacts', 'health', 'api', 'status']) {
      it(`should reject reserved slug "${reserved}"`, async () => {
        const req = new Request(`http://localhost/artifacts?expires=3600&name=test.html&id=${reserved}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${OWNER}` },
          body: '<html></html>',
        });
        const res = await worker.fetch(req, createEnv(kv, db));
        expect(res.status).toBe(400);
      });
    }

    it('should reject slug shorter than 3 chars', async () => {
      const req = new Request('http://localhost/artifacts?expires=3600&name=test.html&id=ab', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(400);
    });

    it('should reject slug with uppercase or invalid chars', async () => {
      const req = new Request('http://localhost/artifacts?expires=3600&name=test.html&id=Bad_Slug', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(400);
    });
  });

  describe('Permanent shares', () => {
    it('should serve 200 for slug with expires_at=0 (no 410)', async () => {
      const id = 'abc12345-1234-1234-1234-123456789abc';
      const slug = 'permanent-test';
      db.setRows([{ id, slug, expires_at: 0, password_hash: null }]);
      await kv.put(`artifacts/${id}/files/index.html`, '<html>perm</html>');

      const req = new Request(`http://localhost/s/${slug}/`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<html>perm</html>');
    });

    it('should set 30d cookie on permanent password-protected share', async () => {
      const id = 'abc12345-1234-1234-1234-123456789abc';
      const slug = 'perm-pwd';
      const passwordHash = await sha256Hex('pwd' + id);
      db.setRows([{ id, slug, expires_at: 0, password_hash: passwordHash }]);
      await kv.put(`artifacts/${id}/files/index.html`, '<html>perm pwd</html>');

      const req = new Request(`http://localhost/s/${slug}/`, {
        method: 'POST',
        body: new URLSearchParams({ password: 'pwd' }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(302);
      // 30 days = 2592000s, not 100y.
      expect(res.headers.get('Set-Cookie')).toContain('Max-Age=2592000');
    });

    it('should serve permanent JWT (permanent:true payload) without 410', async () => {
      const id = 'abc12345-1234-1234-1234-123456789abc';
      db.setRows([{ id, slug: 'p', expires_at: 0 }]);
      await kv.put(`artifacts/${id}/files/index.html`, '<html>perm jwt</html>');

      const now = Math.floor(Date.now() / 1000);
      // exp is intentionally far past — permanent:true must override the expiry check.
      const token = await signJWT(
        { sub: id, iat: now, exp: now - 100, permanent: true },
        SECRET
      );

      const req = new Request(`http://localhost/a/${id}/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      // Single-user mode short-circuits before setting Set-Cookie (per PR #3 — the
      // toss_tok cookie + comments wrapper only ship in multi-tenant mode).
      // Cookie maxAge correctness for permanent shares is covered by the
      // "should set 30d cookie on permanent password-protected share" test above.
    });

    it('should still reject expired non-permanent JWT', async () => {
      const id = 'abc12345-1234-1234-1234-123456789abc';
      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: id, iat: now, exp: now - 100 }, SECRET);

      const req = new Request(`http://localhost/a/${id}/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(410);
    });

    // Locks in the contract for the permanent-share viewer JWT (refactor target).
    // Pre-refactor: requireViewerForArtifact rejects any JWT whose exp is in the
    // past, ignoring the `permanent: true` flag — so server-issued viewer tokens
    // for permanent artifacts 410 the entire comments API.
    // Post-refactor: readArtifactJWT honors `permanent: true` and short-circuits
    // the exp check, matching the legacy /a/:id JWT semantics.
    it('viewer JWT with permanent:true must NOT 410 even when exp is in the past', async () => {
      const id = 'abc12345-1234-1234-1234-123456789abc';
      const now = Math.floor(Date.now() / 1000);
      // Shape this exactly like the post-refactor issueArtifactJWT() will emit
      // for permanent shares: permanent flag + a real exp value (which may be
      // anywhere). The exp being in the past is the key — only the `permanent`
      // flag should be honored.
      const viewerToken = await signJWT(
        { sub: id, iat: now, permanent: true, exp: now - 100 },
        SECRET
      );

      // The comments API is gated to multi-tenant mode, so flip it on.
      const env = { ...createEnv(kv, db), MULTI_TENANT: 'true' };
      const req = new Request(`http://localhost/artifacts/${id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).not.toBe(410);
    });
  });
});
