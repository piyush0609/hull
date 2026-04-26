import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/templates/worker/src/index.js';
import { signJWT } from '../../src/templates/worker/src/jwt.js';
import { MockKV, MockD1, SECRET, OWNER, createEnv } from './helpers.js';

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

    it('should reject expires=0', async () => {
      const req = new Request('http://localhost/artifacts?expires=0&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html></html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(400);
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

      const stored = await kv.get(`artifacts/${body.id}/files/index.html`);
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
  });
});
