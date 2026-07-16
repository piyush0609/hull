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
    comments_enabled: number;
  }> = [];
  commentThreads: Array<{
    id: string;
    artifact_id: string;
    page_path: string;
    created_by_token_hash: string;
    created_by_label: string;
    scope_type: string;
    anchor_json: string | null;
    status: string;
    resolved_by_token_hash: string | null;
    resolved_by_label: string | null;
    resolved_at: number | null;
    deleted_at: number | null;
    deleted_by_token_hash: string | null;
    created_at: number;
    updated_at: number;
  }> = [];
  commentMessages: Array<{
    id: string;
    thread_id: string;
    author_token_hash: string;
    author_label: string;
    body: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    deleted_by_token_hash: string | null;
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
        comments_enabled: values[8] == null ? 0 : Number(values[8]),
      });
      return { success: true };
    }

    if (query.includes('INSERT INTO comment_threads')) {
      this.commentThreads.push({
        id: String(values[0]),
        artifact_id: String(values[1]),
        page_path: String(values[2]),
        created_by_token_hash: String(values[3]),
        created_by_label: String(values[4]),
        scope_type: String(values[5]),
        anchor_json: values[6] == null ? null : String(values[6]),
        status: String(values[7]),
        resolved_by_token_hash: null,
        resolved_by_label: null,
        resolved_at: null,
        deleted_at: null,
        deleted_by_token_hash: null,
        created_at: Number(values[8]),
        updated_at: Number(values[9]),
      });
      return { success: true };
    }

    if (query.includes('INSERT INTO comment_messages')) {
      this.commentMessages.push({
        id: String(values[0]),
        thread_id: String(values[1]),
        author_token_hash: String(values[2]),
        author_label: String(values[3]),
        body: String(values[4]),
        created_at: Number(values[5]),
        updated_at: Number(values[6]),
        deleted_at: null,
        deleted_by_token_hash: null,
      });
      return { success: true };
    }

    if (query.includes('DELETE FROM artifacts WHERE id = ?')) {
      const id = String(values[0]);
      this.artifacts = this.artifacts.filter((a) => a.id !== id);
      return { success: true };
    }

    if (query.includes('UPDATE artifacts SET comments_enabled = ? WHERE id = ?')) {
      const artifact = this.artifacts.find((a) => a.id === String(values[1]));
      if (artifact) artifact.comments_enabled = Number(values[0]);
      return { success: true };
    }

    if (query.includes('DELETE FROM comment_messages WHERE thread_id IN (SELECT id FROM comment_threads WHERE artifact_id = ?)')) {
      const artifactId = String(values[0]);
      const threadIds = new Set(
        this.commentThreads.filter((t) => t.artifact_id === artifactId).map((t) => t.id),
      );
      this.commentMessages = this.commentMessages.filter((m) => !threadIds.has(m.thread_id));
      return { success: true };
    }

    if (query.includes('DELETE FROM comment_threads WHERE artifact_id = ?')) {
      const artifactId = String(values[0]);
      this.commentThreads = this.commentThreads.filter((t) => t.artifact_id !== artifactId);
      return { success: true };
    }

    if (query.includes('UPDATE comment_threads SET updated_at = ? WHERE id = ?')) {
      const updatedAt = Number(values[0]);
      const id = String(values[1]);
      const thread = this.commentThreads.find((item) => item.id === id);
      if (thread) thread.updated_at = updatedAt;
      return { success: true };
    }

    if (query.includes('UPDATE comment_threads SET status = ?, resolved_by_token_hash = ?, resolved_by_label = ?, resolved_at = ?, updated_at = ? WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[5]));
      if (thread) {
        thread.status = String(values[0]);
        thread.resolved_by_token_hash = String(values[1]);
        thread.resolved_by_label = String(values[2]);
        thread.resolved_at = Number(values[3]);
        thread.updated_at = Number(values[4]);
      }
      return { success: true };
    }

    if (query.includes('UPDATE comment_threads SET status = ?, resolved_by_token_hash = NULL, resolved_by_label = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[2]));
      if (thread) {
        thread.status = String(values[0]);
        thread.resolved_by_token_hash = null;
        thread.resolved_by_label = null;
        thread.resolved_at = null;
        thread.updated_at = Number(values[1]);
      }
      return { success: true };
    }

    if (query.includes('UPDATE comment_threads SET deleted_at = ?, deleted_by_token_hash = ?, updated_at = ? WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[3]));
      if (thread) {
        thread.deleted_at = Number(values[0]);
        thread.deleted_by_token_hash = String(values[1]);
        thread.updated_at = Number(values[2]);
      }
      return { success: true };
    }

    if (query.includes('UPDATE comment_messages SET body = ?, updated_at = ? WHERE id = ?')) {
      const message = this.commentMessages.find((item) => item.id === String(values[2]));
      if (message) {
        message.body = String(values[0]);
        message.updated_at = Number(values[1]);
      }
      return { success: true };
    }

    if (query.includes('UPDATE comment_messages SET deleted_at = ?, deleted_by_token_hash = ?, updated_at = ? WHERE id = ?')) {
      const message = this.commentMessages.find((item) => item.id === String(values[3]));
      if (message) {
        message.deleted_at = Number(values[0]);
        message.deleted_by_token_hash = String(values[1]);
        message.updated_at = Number(values[2]);
      }
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

    if (query.includes('FROM comment_threads WHERE artifact_id = ? AND page_path = ? AND deleted_at IS NULL ORDER BY created_at DESC')) {
      const artifactId = String(values[0]);
      const pagePath = String(values[1]);
      return {
        results: this.commentThreads
          .filter((thread) => thread.artifact_id === artifactId && thread.page_path === pagePath && thread.deleted_at == null)
          .slice()
          .sort((a, b) => b.created_at - a.created_at),
      };
    }

    if (query.includes('FROM comment_threads WHERE artifact_id = ? AND deleted_at IS NULL ORDER BY created_at DESC')) {
      const artifactId = String(values[0]);
      return {
        results: this.commentThreads
          .filter((thread) => thread.artifact_id === artifactId && thread.deleted_at == null)
          .slice()
          .sort((a, b) => b.created_at - a.created_at),
      };
    }

    if (query.includes('FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ? AND t.page_path = ? AND t.deleted_at IS NULL ORDER BY m.created_at ASC')) {
      const artifactId = String(values[0]);
      const pagePath = String(values[1]);
      const validThreads = new Map(
        this.commentThreads
          .filter((thread) => thread.artifact_id === artifactId && thread.page_path === pagePath && thread.deleted_at == null)
          .map((thread) => [thread.id, thread])
      );
      return {
        results: this.commentMessages
          .filter((message) => validThreads.has(message.thread_id))
          .map((message) => ({ ...message, thread_status: validThreads.get(message.thread_id)?.status || 'open' }))
          .sort((a, b) => a.created_at - b.created_at),
      };
    }

    if (query.includes('FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ? AND t.deleted_at IS NULL ORDER BY m.created_at ASC')) {
      const artifactId = String(values[0]);
      const validThreads = new Map(
        this.commentThreads
          .filter((thread) => thread.artifact_id === artifactId && thread.deleted_at == null)
          .map((thread) => [thread.id, thread])
      );
      return {
        results: this.commentMessages
          .filter((message) => validThreads.has(message.thread_id))
          .slice()
          .sort((a, b) => a.created_at - b.created_at)
          .map((message) => ({
            ...message,
            thread_status: validThreads.get(message.thread_id)?.status ?? 'open',
          })),
      };
    }

    return { results: [] };
  }

  async first<T = Record<string, unknown>>(query: string, values: unknown[]): Promise<T | null> {
    if (query.includes('SELECT COUNT(*) as c FROM users')) {
      return { c: this.users.length } as T;
    }

    if (query.includes('SELECT is_admin, label FROM users WHERE token_hash = ?')) {
      const tokenHash = String(values[0]);
      const user = this.users.find((u) => u.token_hash === tokenHash);
      return (user ? { is_admin: user.is_admin, label: user.label } : null) as T | null;
    }

    if (query.includes('SELECT token_hash FROM artifacts WHERE id = ?')) {
      const id = String(values[0]);
      const artifact = this.artifacts.find((a) => a.id === id);
      return (artifact ? { token_hash: artifact.token_hash } : null) as T | null;
    }

    if (query.includes('SELECT expires_at FROM artifacts WHERE id = ?')) {
      const id = String(values[0]);
      const artifact = this.artifacts.find((a) => a.id === id);
      return (artifact ? { expires_at: artifact.expires_at } : null) as T | null;
    }

    if (query.includes('SELECT comments_enabled, expires_at, password_epoch FROM artifacts WHERE id = ?')) {
      const a = this.artifacts.find((x) => x.id === String(values[0]));
      return (a ? { comments_enabled: a.comments_enabled, expires_at: a.expires_at, password_epoch: 0 } : null) as T | null;
    }

    if (query.includes('SELECT comments_enabled, password_epoch FROM artifacts WHERE id = ?')) {
      const a = this.artifacts.find((x) => x.id === String(values[0]));
      return (a ? { comments_enabled: a.comments_enabled, password_epoch: 0 } : null) as T | null;
    }

    if (query.includes('SELECT comments_enabled FROM artifacts WHERE id = ?')) {
      const id = String(values[0]);
      const artifact = this.artifacts.find((a) => a.id === id);
      return (artifact ? { comments_enabled: artifact.comments_enabled } : null) as T | null;
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

    if (query.includes('SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[0]));
      return (thread ? { artifact_id: thread.artifact_id, deleted_at: thread.deleted_at } : null) as T | null;
    }

    if (query.includes('SELECT artifact_id, created_by_token_hash, deleted_at FROM comment_threads WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[0]));
      return (
        thread
          ? { artifact_id: thread.artifact_id, created_by_token_hash: thread.created_by_token_hash, deleted_at: thread.deleted_at }
          : null
      ) as T | null;
    }

    if (query.includes('SELECT m.thread_id, m.author_token_hash, m.deleted_at, t.artifact_id')) {
      const message = this.commentMessages.find((item) => item.id === String(values[0]));
      if (!message) return null;
      const thread = this.commentThreads.find((item) => item.id === message.thread_id && item.deleted_at == null);
      if (!thread) return null;
      return ({
        thread_id: message.thread_id,
        author_token_hash: message.author_token_hash,
        deleted_at: message.deleted_at,
        artifact_id: thread.artifact_id,
        thread_status: thread.status,
      }) as T;
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
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");

      const body = await res.text();
      expect(body).toContain('<html>secret');
      expect(body).not.toContain('toss-comments-root');
      expect(body).not.toContain('X-Toss-Viewer');
      expect(body).not.toContain('Comment target');
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

    it('does not inject comments UI or expose comment APIs in single-user mode', async () => {
      const env = createEnv(kv, new StatefulMockD1() as unknown as MockD1);

      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=single.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html><body><h1>Single user share</h1></body></html>',
      }), env);
      const artifact = await create.json() as { id: string; slug: string };

      const htmlResponse = await worker.fetch(new Request(`http://localhost/s/${artifact.slug}/`), env);
      const htmlBody = await htmlResponse.text();
      expect(htmlResponse.status).toBe(200);
      expect(htmlBody).not.toContain('toss-comments-root');
      expect(htmlBody).not.toContain('Discuss this shared page');

      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const viewerToken = await signJWT({ sub: artifact.id, aud: 'comment', pwd_epoch: 0, iat: now, exp: now + 3600 }, SECRET);
      const commentsResponse = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewerToken, Authorization: `Bearer ${OWNER}` },
      }), env);
      expect(commentsResponse.status).toBe(404);
    });

    it('should support threaded comments with anchors, replies, resolve, edit, and delete permissions', async () => {
      const statefulDb = new StatefulMockD1();
      const memberAToken = 'member-a-token';
      const memberBToken = 'member-b-token';
      const outsiderToken = 'outsider-token';
      const memberAHash = await sha256(memberAToken);
      const memberBHash = await sha256(memberBToken);
      const outsiderHash = await sha256(outsiderToken);

      statefulDb.users.push(
        { token_hash: memberAHash, label: 'member-a', created_at: 1, is_admin: 0 },
        { token_hash: memberBHash, label: 'member-b', created_at: 2, is_admin: 0 },
        { token_hash: outsiderHash, label: 'outsider', created_at: 3, is_admin: 0 },
      );

      const env = {
        ...createEnv(kv, statefulDb as unknown as MockD1),
        MULTI_TENANT: 'true',
      };

      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=review.html&comments=1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html><body><main><h1 id="hero">Launch faster</h1><p>Faster builds for every branch with preview URLs.</p></main></body></html>',
      }), env);
      const artifact = await create.json() as { id: string };
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const viewerToken = await signJWT({ sub: artifact.id, aud: 'comment', pwd_epoch: 0, iat: now, exp: now + 3600 }, SECRET);

      const elementThread = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberAToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Reviewer A',
          body: 'Hero heading should feel bolder.',
          pagePath: 'index.html',
          scopeType: 'element',
          anchor: {
            selector: '#hero',
            textSnippet: 'Launch faster',
            rect: { x: 24, y: 48, width: 160, height: 40 },
          },
        }),
      }), env);
      expect(elementThread.status).toBe(201);
      const createdThread = await elementThread.json() as {
        id: string;
        messageId: string;
        thread: { id: string; messages: Array<{ id: string; body: string }>; scope_type: string };
      };
      expect(createdThread.thread.scope_type).toBe('element');
      expect(createdThread.thread.messages[0].id).toBe(createdThread.messageId);
      expect(createdThread.thread.messages[0].body).toBe('Hero heading should feel bolder.');

      const selectionThread = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberBToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Reviewer B',
          body: 'This sentence is the key message.',
          pagePath: 'index.html',
          scopeType: 'selection',
          anchor: {
            selector: 'main p',
            selectedText: 'Faster builds for every branch',
            textSnippet: 'Faster builds for every branch with preview URLs.',
            rect: { x: 24, y: 112, width: 240, height: 20 },
            startOffset: 0,
            endOffset: 30,
          },
        }),
      }), env);
      expect(selectionThread.status).toBe(201);

      const reply = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberBToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Reviewer B', body: 'Agree, and maybe tighten the line height too.' }),
      }), env);
      expect(reply.status).toBe(201);
      const replyBody = await reply.json() as { id: string; message: { body: string }; threadUpdatedAt: number };
      expect(replyBody.message.body).toBe('Agree, and maybe tighten the line height too.');
      expect(replyBody.threadUpdatedAt).toBeGreaterThan(0);

      const outsiderEdit = await worker.fetch(new Request(`http://localhost/comment-messages/${replyBody.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${outsiderToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'I should not be able to edit this.' }),
      }), env);
      expect(outsiderEdit.status).toBe(200); // anyone with the grant can edit (trust-based)

      const ownerResolve = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/resolve`, {
        method: 'POST',
        headers: {
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Reviewer C' }),
      }), env);
      expect(ownerResolve.status).toBe(200);
      const ownerResolveBody = await ownerResolve.json() as { status: string; resolvedByLabel: string; updatedAt: number };
      expect(ownerResolveBody.status).toBe('resolved');
      expect(ownerResolveBody.resolvedByLabel).toBe('Reviewer C');
      expect(ownerResolveBody.updatedAt).toBeGreaterThan(0);

      const editOwnReply = await worker.fetch(new Request(`http://localhost/comment-messages/${replyBody.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${memberBToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'Agree, and maybe tighten line height.' }),
      }), env);
      expect(editOwnReply.status).toBe(409);

      const reopenThread = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/reopen`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberAToken}`,
          'X-Toss-Viewer': viewerToken,
        },
      }), env);
      expect(reopenThread.status).toBe(200);

      const editOwnReplyAfterReopen = await worker.fetch(new Request(`http://localhost/comment-messages/${replyBody.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${memberBToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'Agree, and maybe tighten line height.' }),
      }), env);
      expect(editOwnReplyAfterReopen.status).toBe(200);
      const editOwnReplyBody = await editOwnReplyAfterReopen.json() as { body: string; threadUpdatedAt: number };
      expect(editOwnReplyBody.body).toBe('Agree, and maybe tighten line height.');
      expect(editOwnReplyBody.threadUpdatedAt).toBeGreaterThan(0);

      const deleteOwnReply = await worker.fetch(new Request(`http://localhost/comment-messages/${replyBody.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${memberBToken}`,
          'X-Toss-Viewer': viewerToken,
        },
      }), env);
      expect(deleteOwnReply.status).toBe(204);

      const threadList = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html&includeActivity=1`, {
        headers: { 'X-Toss-Viewer': viewerToken, Authorization: `Bearer ${memberAToken}` },
      }), env);
      expect(threadList.status).toBe(200);
      const threadData = await threadList.json() as {
        pagePath: string;
        viewer: { authenticated: boolean; label: string | null };
        activityThreads: Array<{ id: string; page_path: string }>;
        threads: Array<{
          id: string;
          page_path: string;
          scope_type: string;
          status: string;
          anchor: { selector?: string; selectedText?: string } | null;
          messages: Array<{ body: string; deleted_at: number | null; can_edit: boolean; can_delete: boolean }>;
        }>;
      };
      expect(threadData.pagePath).toBe('index.html');
      expect(threadData.viewer).toEqual({ authenticated: true, label: null });
      expect(threadData.threads).toHaveLength(2);
      expect(threadData.activityThreads).toHaveLength(2);
      expect(threadData.threads.every((thread) => thread.page_path === 'index.html')).toBe(true);
      expect(threadData.threads.some((thread) => thread.scope_type === 'element' && thread.anchor?.selector === '#hero')).toBe(true);
      expect(threadData.threads.some((thread) => thread.scope_type === 'selection' && thread.anchor?.selectedText === 'Faster builds for every branch')).toBe(true);
      const reopenedThread = threadData.threads.find((thread) => thread.id === createdThread.id);
      expect(reopenedThread?.status).toBe('open');
      expect(reopenedThread?.messages.some((message) => message.deleted_at !== null)).toBe(true);
      expect(reopenedThread?.messages.some((message) => message.body === 'Agree, and maybe tighten line height.' && message.can_edit)).toBe(false);

      const memberBThreadList = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html&includeActivity=1`, {
        headers: { 'X-Toss-Viewer': viewerToken, Authorization: `Bearer ${memberBToken}` },
      }), env);
      expect(memberBThreadList.status).toBe(200);
      const memberBThreadData = await memberBThreadList.json() as {
        threads: Array<{
          id: string;
          messages: Array<{ body: string; can_edit: boolean; deleted_at?: number | null }>;
        }>;
      };
      const memberBViewOfReopenedThread = memberBThreadData.threads.find((thread) => thread.id === createdThread.id);
      expect(memberBViewOfReopenedThread?.messages.some((message) => message.deleted_at != null)).toBe(true);

      const deleteThread = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${memberAToken}`,
          'X-Toss-Viewer': viewerToken,
        },
      }), env);
      expect(deleteThread.status).toBe(204);

      const anonymousCreate = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: {
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'Missing the name field', pagePath: 'index.html', scopeType: 'artifact' }),
      }), env);
      expect(anonymousCreate.status).toBe(400); // grant present but no name → rejected
    });

    it('revoking an artifact blocks comment API access and cascades to comment rows', async () => {
      // HIGH #2 from codex review: deleting an artifact left orphaned comment_threads
      // and comment_messages rows, and a still-valid viewer JWT (up to 30 days of life)
      // could keep reading and posting against the deleted artifact's comments.
      // Two contracts get locked here:
      //   1. Any comment-API hit for a missing artifact returns 404 — viewer-JWT
      //      scope is necessary but not sufficient.
      //   2. DELETE /artifacts/:id cascades to comment_threads + comment_messages.
      const statefulDb = new StatefulMockD1();
      const ownerHash = await sha256(OWNER);
      statefulDb.users.push({ token_hash: ownerHash, label: 'admin', created_at: 1, is_admin: 1 });

      const kv = new MockKV();
      const env = {
        ...createEnv(kv, statefulDb as unknown as MockD1),
        MULTI_TENANT: 'true',
      };

      // Create an artifact and post a thread on it.
      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=site.html&comments=1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html><body><h1>Live</h1></body></html>',
      }), env);
      const artifact = await create.json() as { id: string };

      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const viewerToken = await signJWT(
        { sub: artifact.id, aud: 'comment', pwd_epoch: 0, iat: now, exp: now + 3600 },
        SECRET,
      );

      const threadCreate = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OWNER}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Dana', body: 'first thought', pagePath: 'index.html', scopeType: 'artifact' }),
      }), env);
      expect(threadCreate.status).toBe(201);
      expect(statefulDb.commentThreads.filter((t) => t.artifact_id === artifact.id)).toHaveLength(1);
      expect(statefulDb.commentMessages).toHaveLength(1);

      // Revoke the artifact. The viewer JWT remains valid by signature/scope.
      const revoke = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${OWNER}` },
      }), env);
      expect(revoke.status).toBe(200);

      // Contract 1: comment-API hit for a now-missing artifact returns 404.
      const list = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewerToken, Authorization: `Bearer ${OWNER}` },
      }), env);
      expect(list.status).toBe(404);

      const postAttempt = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OWNER}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: 'should not land', pagePath: 'index.html', scopeType: 'artifact' }),
      }), env);
      expect(postAttempt.status).toBe(404);

      // Contract 2: comment rows for the revoked artifact are gone.
      expect(statefulDb.commentThreads.filter((t) => t.artifact_id === artifact.id)).toHaveLength(0);
      expect(statefulDb.commentMessages).toHaveLength(0);
    });

    it('isolates comment threads by page path while still exposing artifact-wide activity', async () => {
      const statefulDb = new StatefulMockD1();
      const ownerHash = await sha256(OWNER);
      const memberHash = await sha256('member-page-token');
      statefulDb.users.push({ token_hash: ownerHash, label: 'admin', created_at: 1, is_admin: 1 });
      statefulDb.users.push({ token_hash: memberHash, label: 'member-page', created_at: 2, is_admin: 0 });

      const kv = new MockKV();
      const env = {
        ...createEnv(kv, statefulDb as unknown as MockD1),
        MULTI_TENANT: 'true',
      };

      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=site/index.html&comments=1', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html><body><h1>Overview</h1></body></html>',
      }), env);
      const artifact = await create.json() as { id: string };
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const viewerToken = await signJWT({ sub: artifact.id, aud: 'comment', pwd_epoch: 0, iat: now, exp: now + 3600 }, SECRET);

      const createIndexThread = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer member-page-token',
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Eve',
          body: 'Index page comment',
          pagePath: 'index.html',
          scopeType: 'artifact',
        }),
      }), env);
      expect(createIndexThread.status).toBe(201);

      const createFeaturesThread = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer member-page-token',
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Eve',
          body: 'Features page comment',
          pagePath: 'features.html',
          scopeType: 'artifact',
        }),
      }), env);
      expect(createFeaturesThread.status).toBe(201);

      const indexThreads = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html&includeActivity=1`, {
        headers: {
          Authorization: 'Bearer member-page-token',
          'X-Toss-Viewer': viewerToken,
        },
      }), env);
      expect(indexThreads.status).toBe(200);
      const indexData = await indexThreads.json() as {
        pagePath: string;
        threads: Array<{ page_path: string; messages: Array<{ body: string }> }>;
        activityThreads: Array<{ page_path: string; messages: Array<{ body: string }> }>;
      };
      expect(indexData.pagePath).toBe('index.html');
      expect(indexData.threads).toHaveLength(1);
      expect(indexData.threads[0].page_path).toBe('index.html');
      expect(indexData.threads[0].messages[0].body).toBe('Index page comment');
      expect(indexData.activityThreads).toHaveLength(2);
      expect(indexData.activityThreads.map((thread) => thread.page_path).sort()).toEqual(['features.html', 'index.html']);

      const featureThreads = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=features.html&includeActivity=1`, {
        headers: {
          Authorization: 'Bearer member-page-token',
          'X-Toss-Viewer': viewerToken,
        },
      }), env);
      expect(featureThreads.status).toBe(200);
      const featureData = await featureThreads.json() as {
        pagePath: string;
        threads: Array<{ page_path: string; messages: Array<{ body: string }> }>;
      };
      expect(featureData.pagePath).toBe('features.html');
      expect(featureData.threads).toHaveLength(1);
      expect(featureData.threads[0].page_path).toBe('features.html');
      expect(featureData.threads[0].messages[0].body).toBe('Features page comment');
    });

    it('renders legacy token-based comment rows (backward compatible)', async () => {
      const statefulDb = new StatefulMockD1();
      statefulDb.users.push({ token_hash: await sha256(OWNER), label: 'admin', created_at: 1, is_admin: 1 });
      const env = { ...createEnv(kv, statefulDb as unknown as MockD1), MULTI_TENANT: 'true' };

      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=legacy.html&comments=1', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>hi</body></html>',
      }), env);
      const artifact = await create.json() as { id: string };

      // A row exactly as the OLD token model wrote it: real token_hash, no sentinel.
      const now = Math.floor(Date.now() / 1000);
      statefulDb.commentThreads.push({
        id: 'legacy-thread', artifact_id: artifact.id, page_path: 'index.html',
        created_by_token_hash: 'd'.repeat(64), created_by_label: 'Legacy User',
        scope_type: 'artifact', anchor_json: null, status: 'open',
        resolved_by_token_hash: null, resolved_by_label: null, resolved_at: null,
        deleted_at: null, deleted_by_token_hash: null, created_at: now, updated_at: now,
      });
      statefulDb.commentMessages.push({
        id: 'legacy-msg', thread_id: 'legacy-thread',
        author_token_hash: 'd'.repeat(64), author_label: 'Legacy User',
        body: 'Comment from the old token model', created_at: now, updated_at: now,
        deleted_at: null, deleted_by_token_hash: null,
      });

      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const grant = await signJWT({ sub: artifact.id, aud: 'comment', pwd_epoch: 0, iat: now, exp: now + 3600 }, SECRET);
      const list = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': grant },
      }), env);
      expect(list.status).toBe(200);
      const data = await list.json() as {
        threads: Array<{ created_by_label: string; messages: Array<{ author_label: string; body: string; can_edit: boolean; author_token_hash?: string }> }>;
      };
      const legacy = data.threads.find((t) => t.created_by_label === 'Legacy User');
      expect(legacy).toBeDefined();
      expect(legacy?.messages[0].body).toBe('Comment from the old token model');
      expect(legacy?.messages[0].author_label).toBe('Legacy User');
      expect(legacy?.messages[0].can_edit).toBe(true); // anyone with the grant
      expect(legacy?.messages[0].author_token_hash).toBeUndefined(); // not leaked
    });
  });

  describe('Comments opt-in (Story 1)', () => {
    async function makeAdminEnv() {
      const statefulDb = new StatefulMockD1();
      statefulDb.users.push({ token_hash: await sha256(OWNER), label: 'admin', created_at: 1, is_admin: 1 });
      const localKv = new MockKV();
      const env = { ...createEnv(localKv, statefulDb as unknown as MockD1), MULTI_TENANT: 'true' };
      return { statefulDb, env };
    }

    async function viewerFor(id: string) {
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      return signJWT({ sub: id, aud: 'comment', pwd_epoch: 0, iat: now, exp: now + 3600 }, SECRET);
    }

    it('comments are OFF by default even in multi-tenant mode (no UI, routes 404)', async () => {
      const { env } = await makeAdminEnv();
      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=x.html', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>hi</body></html>',
      }), env);
      const artifact = await create.json() as { id: string; slug: string };

      const page = await worker.fetch(new Request(`http://localhost/s/${artifact.slug}/`), env);
      expect(await page.text()).not.toContain('toss-comments-root');

      const viewer = await viewerFor(artifact.id);
      const list = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewer, Authorization: `Bearer ${OWNER}` },
      }), env);
      expect(list.status).toBe(404);
    });

    it('comments are ON when shared with ?comments=1 (UI injected, routes live)', async () => {
      const { env } = await makeAdminEnv();
      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=x.html&comments=1', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>hi</body></html>',
      }), env);
      const artifact = await create.json() as { id: string; slug: string };

      const page = await worker.fetch(new Request(`http://localhost/s/${artifact.slug}/`), env);
      expect(await page.text()).toContain('toss-comments-root');

      const viewer = await viewerFor(artifact.id);
      const list = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewer, Authorization: `Bearer ${OWNER}` },
      }), env);
      expect(list.status).toBe(200);
    });

    it('PATCH /artifacts/:id/comments toggles comments on and off; requires owner', async () => {
      const { env } = await makeAdminEnv();
      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=x.html', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>hi</body></html>',
      }), env);
      const artifact = await create.json() as { id: string; slug: string };

      const on = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comments`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }), env);
      expect(on.status).toBe(200);
      expect(await (await worker.fetch(new Request(`http://localhost/s/${artifact.slug}/`), env)).text()).toContain('toss-comments-root');

      const off = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comments`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${OWNER}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }), env);
      expect(off.status).toBe(200);
      expect(await (await worker.fetch(new Request(`http://localhost/s/${artifact.slug}/`), env)).text()).not.toContain('toss-comments-root');

      const noAuth = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comments`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      }), env);
      expect(noAuth.status).toBe(401);
    });

    it('rejects a plain viewer token on comment routes (distinct grant required)', async () => {
      const { env } = await makeAdminEnv();
      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=x.html&comments=1', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>hi</body></html>',
      }), env);
      const artifact = await create.json() as { id: string };
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      // A plain viewer token (no aud:"comment") must NOT work on comment routes.
      const plainViewer = await signJWT({ sub: artifact.id, exp: now + 3600, iat: now }, SECRET);
      const res = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': plainViewer },
      }), env);
      expect(res.status).toBe(403);
    });
  });
});
