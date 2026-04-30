import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../../src/templates/worker/src/index.js';
import { MockKV, MockD1, SECRET, OWNER, createEnv } from './helpers.js';

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

class StatefulD1Statement {
  constructor(
    private db: StatefulMockD1,
    private query: string,
    private values: unknown[] = []
  ) {}

  bind(...values: unknown[]) {
    return new StatefulD1Statement(this.db, this.query, values);
  }

  async run() {
    return this.db.run(this.query, this.values);
  }

  async all() {
    return this.db.all(this.query, this.values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.db.first<T>(this.query, this.values);
  }
}

class StatefulMockD1 {
  users: Array<{ token_hash: string; label: string; created_at: number; is_admin: number }> = [];
  artifacts: Array<{
    id: string;
    slug: string;
    name: string;
    size_bytes: number;
    created_at: number;
    expires_at: number;
    token_hash: string;
    password_hash: string | null;
  }> = [];

  prepare(query: string) {
    return new StatefulD1Statement(this, query);
  }

  async run(query: string, values: unknown[]) {
    if (query.includes('INSERT INTO users')) {
      this.users.push({
        token_hash: String(values[0]),
        label: String(values[1]),
        created_at: Number(values[2]),
        is_admin: Number(values[3]),
      });
      return { success: true };
    }

    if (query.includes('INSERT INTO artifacts')) {
      this.artifacts.push({
        id: String(values[0]),
        slug: String(values[1]),
        name: String(values[2]),
        size_bytes: Number(values[3]),
        created_at: Number(values[4]),
        expires_at: Number(values[5]),
        token_hash: String(values[6]),
        password_hash: values[7] == null ? null : String(values[7]),
      });
      return { success: true };
    }

    if (query.includes('DELETE FROM artifacts WHERE id = ?')) {
      const id = String(values[0]);
      this.artifacts = this.artifacts.filter((a) => a.id !== id);
      return { success: true };
    }

    if (query.includes('DELETE FROM users WHERE token_hash = ?')) {
      const tokenHash = String(values[0]);
      this.users = this.users.filter((u) => !(u.token_hash === tokenHash && u.is_admin === 0));
      return { success: true };
    }

    return { success: true };
  }

  async all(query: string, values: unknown[]) {
    if (query.includes('SELECT id, slug, name, size_bytes, created_at, expires_at FROM artifacts WHERE token_hash = ?')) {
      const tokenHash = String(values[0]);
      return {
        results: this.artifacts
          .filter((a) => a.token_hash === tokenHash)
          .sort((a, b) => b.created_at - a.created_at)
          .map(({ token_hash, password_hash, ...rest }) => rest),
      };
    }

    if (query.includes('SELECT id, slug, name, size_bytes, created_at, expires_at FROM artifacts ORDER BY created_at DESC')) {
      return {
        results: this.artifacts
          .slice()
          .sort((a, b) => b.created_at - a.created_at)
          .map(({ token_hash, password_hash, ...rest }) => rest),
      };
    }

    if (query.includes('SELECT token_hash, label, created_at, is_admin FROM users ORDER BY created_at DESC')) {
      return {
        results: this.users.slice().sort((a, b) => b.created_at - a.created_at),
      };
    }

    return { results: [] };
  }

  async first<T = Record<string, unknown>>(query: string, values: unknown[]): Promise<T | null> {
    if (query.includes('SELECT COUNT(*) as c FROM users')) {
      return { c: this.users.length } as T;
    }

    if (query.includes('SELECT is_admin FROM users WHERE token_hash = ?')) {
      const tokenHash = String(values[0]);
      const user = this.users.find((u) => u.token_hash === tokenHash);
      return (user ? { is_admin: user.is_admin } : null) as T | null;
    }

    if (query.includes('SELECT token_hash FROM artifacts WHERE id = ?')) {
      const id = String(values[0]);
      const artifact = this.artifacts.find((a) => a.id === id);
      return (artifact ? { token_hash: artifact.token_hash } : null) as T | null;
    }

    if (query.includes('SELECT id, expires_at, password_hash FROM artifacts WHERE slug = ?')) {
      const slug = String(values[0]);
      const artifact = this.artifacts.find((a) => a.slug === slug);
      return (
        artifact
          ? { id: artifact.id, expires_at: artifact.expires_at, password_hash: artifact.password_hash }
          : null
      ) as T | null;
    }

    return null;
  }
}

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

  describe('Multi-tenant isolation', () => {
    it('should isolate owner/member A/member B artifact listings and revoke permissions', async () => {
      const statefulDb = new StatefulMockD1();
      const memberAToken = 'member-a-token';
      const memberBToken = 'member-b-token';
      const memberAHash = await sha256(memberAToken);
      const memberBHash = await sha256(memberBToken);

      statefulDb.users.push(
        { token_hash: memberAHash, label: 'member-a', created_at: 1, is_admin: 0 },
        { token_hash: memberBHash, label: 'member-b', created_at: 2, is_admin: 0 }
      );

      const env = {
        ...createEnv(kv, statefulDb as unknown as MockD1),
        MULTI_TENANT: 'true',
      };

      const ownerCreate = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=owner.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>owner</html>',
      }), env);
      const ownerArtifact = await ownerCreate.json() as { id: string };

      const memberACreate = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=a.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberAToken}` },
        body: '<html>a</html>',
      }), env);
      const memberAArtifact = await memberACreate.json() as { id: string };

      const memberBCreate = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=b.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${memberBToken}` },
        body: '<html>b</html>',
      }), env);
      const memberBArtifact = await memberBCreate.json() as { id: string };

      const ownerListRes = await worker.fetch(new Request('http://localhost/artifacts', {
        headers: { Authorization: `Bearer ${OWNER}` },
      }), env);
      const ownerList = await ownerListRes.json() as Array<{ id: string }>;
      expect(ownerList.map((a) => a.id).sort()).toEqual(
        [ownerArtifact.id, memberAArtifact.id, memberBArtifact.id].sort()
      );

      const memberAListRes = await worker.fetch(new Request('http://localhost/artifacts', {
        headers: { Authorization: `Bearer ${memberAToken}` },
      }), env);
      const memberAList = await memberAListRes.json() as Array<{ id: string }>;
      expect(memberAList.map((a) => a.id)).toEqual([memberAArtifact.id]);

      const memberBListRes = await worker.fetch(new Request('http://localhost/artifacts', {
        headers: { Authorization: `Bearer ${memberBToken}` },
      }), env);
      const memberBList = await memberBListRes.json() as Array<{ id: string }>;
      expect(memberBList.map((a) => a.id)).toEqual([memberBArtifact.id]);

      const forbiddenRevoke = await worker.fetch(new Request(`http://localhost/artifacts/${memberAArtifact.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${memberBToken}` },
      }), env);
      expect(forbiddenRevoke.status).toBe(403);

      const ownRevoke = await worker.fetch(new Request(`http://localhost/artifacts/${memberBArtifact.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${memberBToken}` },
      }), env);
      expect(ownRevoke.status).toBe(200);
    });
  });
});
