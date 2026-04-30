import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/templates/worker/src/index.js';
import { MockKV, MockD1, SECRET, OWNER, createEnv } from './helpers.js';

describe('Worker Routes', () => {
  let kv: MockKV;
  let db: MockD1;

  beforeEach(() => {
    kv = new MockKV();
    db = new MockD1();
  });

  describe('POST /artifacts', () => {
    it('should reject without owner token', async () => {
      const req = new Request('http://localhost/artifacts?expires=3600&name=test.html', {
        method: 'POST',
        body: '<html>test</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(401);
    });

    it('should accept missing expires param as permanent (200 + slug returned)', async () => {
      const req = new Request('http://localhost/artifacts?name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>test</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      const body = await res.json() as { id: string; slug: string; url: string };
      expect(body.slug).toMatch(/^[a-z0-9]{12}$/);
      expect(body.url).toContain(`/s/${body.slug}`);
    });

    it('should reject invalid expires', async () => {
      const req = new Request('http://localhost/artifacts?expires=-1&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>test</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(400);
    });

    it('should reject expiry over 90 days', async () => {
      const req = new Request(`http://localhost/artifacts?expires=${91 * 24 * 60 * 60}&name=test.html`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>test</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(400);
    });

    it('should upload and return share URL', async () => {
      const req = new Request('http://localhost/artifacts?expires=3600&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>test</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.url).toMatch(/^http:\/\/localhost\/s\/[a-z0-9-]+/);
      expect(body.legacyUrl).toMatch(/^http:\/\/localhost\/a\/[a-f0-9-]+\?t=eyJ/);
      expect(body.slug).toBeDefined();

      const stored = await kv.get(`artifacts/${body.id}/files/index.html`);
      expect(stored).toBe('<html>test</html>');
    });
  });

  describe('GET /artifacts', () => {
    it('should reject without owner token', async () => {
      const req = new Request('http://localhost/artifacts');
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(401);
    });

    it('should list artifacts', async () => {
      db.setRows([
        { id: 'abc123', name: 'test.html', size_bytes: 100, created_at: 1700000000, expires_at: 1700003600 },
      ]);

      const req = new Request('http://localhost/artifacts', {
        headers: { Authorization: `Bearer ${OWNER}` },
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('abc123');
    });
  });

  describe('DELETE /artifacts/:id', () => {
    it('should delete artifact', async () => {
      await kv.put('artifacts/abc123/files/index.html', '<html>gone</html>');

      const req = new Request('http://localhost/artifacts/abc123', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${OWNER}` },
      });
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);

      const stored = await kv.get('artifacts/abc123/files/index.html');
      expect(stored).toBeNull();
    });
  });

  describe('GET /a/:id', () => {
    it('should reject missing token', async () => {
      const req = new Request('http://localhost/a/abc123/');
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(401);
    });

    it('should reject invalid token', async () => {
      const req = new Request('http://localhost/a/abc123/?t=bad.token.here');
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(401);
    });

    it('should reject expired token', async () => {
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const past = Math.floor(Date.now() / 1000) - 3600;
      const token = await signJWT({ sub: 'abc123', iat: past - 3600, exp: past }, SECRET);

      const req = new Request(`http://localhost/a/abc123/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(410);
    });

    it('should reject token for wrong artifact', async () => {
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'wrong-id', iat: now, exp: now + 3600 }, SECRET);

      const req = new Request(`http://localhost/a/abc123/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(403);
    });

    it('should serve HTML with valid token', async () => {
      await kv.put('artifacts/abc123/files/index.html', '<html>secret</html>');

      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'abc123', iat: now, exp: now + 3600 }, SECRET);

      const req = new Request(`http://localhost/a/abc123/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html');
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");

      const body = await res.text();
      expect(body).toBe('<html>secret</html>');
    });

    it('should return 404 for missing artifact', async () => {
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const token = await signJWT({ sub: 'missing', iat: now, exp: now + 3600 }, SECRET);

      const req = new Request(`http://localhost/a/missing/?t=${token}`);
      const res = await worker.fetch(req, createEnv(kv, db));
      expect(res.status).toBe(404);
    });
  });
});
