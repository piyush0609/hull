import { describe, it, expect, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import worker, { serializeInlineScriptValue } from '../../src/templates/worker/src/index.js';
import { MockKV, MockD1, SECRET, OWNER, createEnv } from './helpers.js';

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function embeddedWorkerFunction(name: string, dependencies: string[], values: unknown[]) {
  const source = await readFile('src/templates/worker/src/index.ts', 'utf8');
  const declaration = source.match(new RegExp(`  const ${name} = (?:async )?\\([\\s\\S]*?\\n  };`))?.[0];
  expect(declaration).toBeTruthy();
  return new Function(...dependencies, `${declaration}; return ${name};`)(...values);
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

  isVersionPublish() {
    return this.query.includes('INSERT INTO artifact_versions') && this.query.includes('SELECT ?, a.id');
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
    password_epoch: number;
    current_version_id?: string | null;
  }> = [];
  artifactVersions: Array<{ id: string; artifact_id: string; seq: number; content_hash: string; created_at: number }> = [];
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
    version_id?: string | null;
  }> = [];
  commentMessages: Array<{
    id: string;
    thread_id: string;
    author_token_hash: string;
    author_label: string;
    body: string;
    kind: string;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
    deleted_by_token_hash: string | null;
  }> = [];
  failNextStagedMessageInsert = false;
  beforeVersionPublishBatch: (() => Promise<void>) | null = null;
  private batchTail: Promise<void> = Promise.resolve();

  prepare(query: string) {
    return new StatefulD1Statement(this, query);
  }

  async batch(statements: StatefulD1Statement[]) {
    if (statements.some((statement) => statement.isVersionPublish())) {
      await this.beforeVersionPublishBatch?.();
    }
    const previous = this.batchTail;
    let release!: () => void;
    this.batchTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = structuredClone({
      artifacts: this.artifacts,
      artifactVersions: this.artifactVersions,
      commentThreads: this.commentThreads,
      commentMessages: this.commentMessages,
    });
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      this.artifacts = snapshot.artifacts;
      this.artifactVersions = snapshot.artifactVersions;
      this.commentThreads = snapshot.commentThreads;
      this.commentMessages = snapshot.commentMessages;
      throw error;
    } finally {
      release();
    }
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
        password_epoch: 0,
        current_version_id: null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes('INSERT INTO artifact_versions') && query.includes('SELECT ?, a.id')) {
      const artifact = this.artifacts.find((item) => item.id === String(values[4]));
      const expectedCurrent = values[5] == null ? null : String(values[5]);
      const expectedCurrentAgain = values[6] == null ? null : String(values[6]);
      const current = artifact?.current_version_id || null;
      const currentVersion = this.artifactVersions.find((item) => item.id === current);
      const seq = Number(values[1]);
      const canInsert = !!artifact
        && current === expectedCurrent
        && current === expectedCurrentAgain
        && seq === Number(currentVersion?.seq || 0) + 1
        && !this.artifactVersions.some((item) => item.artifact_id === artifact.id && item.seq === seq);
      if (canInsert) {
        this.artifactVersions.push({
          id: String(values[0]), artifact_id: artifact.id, seq,
          content_hash: String(values[2]), created_at: Number(values[3]),
        });
      }
      return { success: true, meta: { changes: canInsert ? 1 : 0 } };
    }

    if (query.includes('INSERT INTO artifact_versions')) {
      this.artifactVersions.push({
        id: String(values[0]), artifact_id: String(values[1]), seq: Number(values[2]),
        content_hash: String(values[3]), created_at: Number(values[4]),
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes('UPDATE artifacts SET current_version_id = ?, name = ?, size_bytes = ?, expires_at = ?, password_epoch = password_epoch + CASE WHEN password_hash IS ?') && query.includes('EXISTS (SELECT 1 FROM artifact_versions')) {
      const artifact = this.artifacts.find((item) => item.id === String(values[6]));
      const expectedCurrent = values[7] == null ? null : String(values[7]);
      const expectedCurrentAgain = values[8] == null ? null : String(values[8]);
      const version = this.artifactVersions.find((item) => item.id === String(values[9]) && item.artifact_id === String(values[10]) && item.seq === Number(values[11]));
      const canPublish = !!artifact && !!version && (artifact.current_version_id || null) === expectedCurrent && (artifact.current_version_id || null) === expectedCurrentAgain;
      if (canPublish) {
        const compareHash = values[4] == null ? null : String(values[4]);   // 4: CASE comparison hash
        const assignHash = values[5] == null ? null : String(values[5]);    // 5: assignment hash
        // Increment based on the OLD stored hash, null-safe, BEFORE assigning values[5].
        if ((artifact.password_hash ?? null) !== compareHash) {
          artifact.password_epoch = (artifact.password_epoch ?? 0) + 1;
        }
        artifact.current_version_id = String(values[0]);
        artifact.name = String(values[1]);
        artifact.size_bytes = Number(values[2]);
        artifact.expires_at = Number(values[3]);
        artifact.password_hash = assignHash;
      }
      return { success: true, meta: { changes: canPublish ? 1 : 0 } };
    }

    if (query.includes('UPDATE comment_threads SET version_id = ? WHERE artifact_id = ? AND version_id IS NULL')) {
      const requiredVersion = query.includes('EXISTS (SELECT 1 FROM artifact_versions')
        ? this.artifactVersions.find((item) => item.id === String(values[2]) && item.artifact_id === String(values[3]) && item.seq === Number(values[4]))
        : true;
      let changes = 0;
      for (const thread of requiredVersion ? this.commentThreads : []) {
        if (thread.artifact_id === String(values[1]) && thread.version_id == null) {
          thread.version_id = String(values[0]);
          changes++;
        }
      }
      return { success: true, meta: { changes } };
    }

    if (query.includes('INSERT INTO comment_threads')) {
      const carried = query.includes('resolved_by_token_hash');
      const versioned = query.includes('version_id');
      this.commentThreads.push({
        id: String(values[0]),
        artifact_id: String(values[1]),
        version_id: versioned ? (values[2] == null ? null : String(values[2])) : null,
        page_path: String(values[versioned ? 3 : 2]),
        created_by_token_hash: String(values[versioned ? 4 : 3]),
        created_by_label: String(values[versioned ? 5 : 4]),
        scope_type: String(values[versioned ? 6 : 5]),
        anchor_json: values[versioned ? 7 : 6] == null ? null : String(values[versioned ? 7 : 6]),
        status: String(values[versioned ? 8 : 7]),
        resolved_by_token_hash: carried && values[9] != null ? String(values[9]) : null,
        resolved_by_label: carried && values[10] != null ? String(values[10]) : null,
        resolved_at: carried && values[11] != null ? Number(values[11]) : null,
        deleted_at: null,
        deleted_by_token_hash: null,
        created_at: Number(values[carried ? 12 : (versioned ? 9 : 8)]),
        updated_at: Number(values[carried ? 13 : (versioned ? 10 : 9)]),
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes('INSERT INTO comment_messages') && query.includes('SELECT ?, id')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[6]) && item.status === 'open' && item.deleted_at == null);
      if (!thread) return { success: true, meta: { changes: 0 } };
      this.commentMessages.push({
        id: String(values[0]), thread_id: thread.id, author_token_hash: String(values[1]),
        author_label: String(values[2]), body: String(values[3]), kind: 'resolution',
        created_at: Number(values[4]), updated_at: Number(values[5]), deleted_at: null,
        deleted_by_token_hash: null,
      });
      return { success: true, meta: { changes: 1 } };
    }

    if (query.includes('INSERT INTO comment_messages')) {
      const stagedThread = this.commentThreads.find((item) => item.id === String(values[1]));
      if (this.failNextStagedMessageInsert && stagedThread?.version_id && !this.artifactVersions.some((item) => item.id === stagedThread.version_id)) {
        this.failNextStagedMessageInsert = false;
        throw new Error('Injected staged message copy failure');
      }
      this.commentMessages.push({
        id: String(values[0]),
        thread_id: String(values[1]),
        author_token_hash: String(values[2]),
        author_label: String(values[3]),
        body: String(values[4]),
        kind: String(values[5] ?? 'note'),
        created_at: Number(values[6]),
        updated_at: Number(values[7]),
        deleted_at: null,
        deleted_by_token_hash: null,
      });
      return { success: true, meta: { changes: 1 } };
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

    if (query.includes('UPDATE artifacts SET name = ?, size_bytes = ?, expires_at = ?, password_hash = ? WHERE id = ?')) {
      const artifact = this.artifacts.find((item) => item.id === String(values[4]));
      if (artifact) {
        artifact.name = String(values[0]);
        artifact.size_bytes = Number(values[1]);
        artifact.expires_at = Number(values[2]);
        artifact.password_hash = values[3] == null ? null : String(values[3]);
      }
      return { success: true, meta: { changes: artifact ? 1 : 0 } };
    }

    if (query.includes('DELETE FROM comment_messages WHERE thread_id IN (SELECT id FROM comment_threads WHERE artifact_id = ?)')) {
      const artifactId = String(values[0]);
      const threadIds = new Set(
        this.commentThreads.filter((t) => t.artifact_id === artifactId).map((t) => t.id),
      );
      this.commentMessages = this.commentMessages.filter((m) => !threadIds.has(m.thread_id));
      return { success: true };
    }

    if (query.includes('DELETE FROM comment_messages WHERE thread_id IN (SELECT id FROM comment_threads WHERE artifact_id = ? AND version_id = ?)')) {
      const threadIds = new Set(this.commentThreads.filter((thread) => thread.artifact_id === String(values[0]) && thread.version_id === String(values[1])).map((thread) => thread.id));
      const before = this.commentMessages.length;
      this.commentMessages = this.commentMessages.filter((message) => !threadIds.has(message.thread_id));
      return { success: true, meta: { changes: before - this.commentMessages.length } };
    }

    if (query.includes('DELETE FROM comment_threads WHERE artifact_id = ? AND version_id = ?')) {
      const before = this.commentThreads.length;
      this.commentThreads = this.commentThreads.filter((thread) => !(thread.artifact_id === String(values[0]) && thread.version_id === String(values[1])));
      return { success: true, meta: { changes: before - this.commentThreads.length } };
    }

    if (query.includes('DELETE FROM artifact_versions WHERE id = ? AND artifact_id = ?')) {
      const artifact = this.artifacts.find((item) => item.id === String(values[2]));
      const canDelete = artifact?.current_version_id !== String(values[3]);
      const before = this.artifactVersions.length;
      if (canDelete) this.artifactVersions = this.artifactVersions.filter((version) => !(version.id === String(values[0]) && version.artifact_id === String(values[1])));
      return { success: true, meta: { changes: before - this.artifactVersions.length } };
    }

    if (query.trim() === 'DELETE FROM comment_threads WHERE artifact_id = ?') {
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

    if (query.includes("UPDATE comment_threads SET status = 'resolved'")) {
      const thread = this.commentThreads.find((item) => item.id === String(values[4]) && item.status === 'open' && item.deleted_at == null);
      if (thread) {
        thread.status = 'resolved';
        thread.resolved_by_token_hash = String(values[0]);
        thread.resolved_by_label = String(values[1]);
        thread.resolved_at = Number(values[2]);
        thread.updated_at = Number(values[3]);
      }
      return { success: true, meta: { changes: thread ? 1 : 0 } };
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
    if (query.includes('SELECT av.seq, av.content_hash, av.created_at')) {
      const artifactId = String(values[0]);
      const artifact = this.artifacts.find((item) => item.id === artifactId);
      return {
        results: this.artifactVersions
          .filter((version) => version.artifact_id === artifactId)
          .sort((a, b) => b.seq - a.seq)
          .map((version) => ({
            ...version,
            comment_count: this.commentThreads.filter((thread) => thread.version_id === version.id && thread.deleted_at == null).length,
            is_current: version.id === artifact?.current_version_id ? 1 : 0,
          })),
      };
    }

    if (query.includes('FROM comment_threads WHERE artifact_id = ? AND version_id = ? AND deleted_at IS NULL') && !query.includes('ORDER BY created_at DESC')) {
      return {
        results: this.commentThreads.filter((thread) => thread.artifact_id === String(values[0]) && thread.version_id === String(values[1]) && thread.deleted_at == null),
      };
    }

    if (query.includes('FROM comment_messages WHERE thread_id = ? AND deleted_at IS NULL')) {
      return {
        results: this.commentMessages.filter((message) => message.thread_id === String(values[0]) && message.deleted_at == null).sort((a, b) => a.created_at - b.created_at),
      };
    }

    if (query.includes('FROM comment_threads WHERE artifact_id = ? AND version_id = ? AND deleted_at IS NULL ORDER BY created_at DESC')) {
      return {
        results: this.commentThreads.filter((thread) => thread.artifact_id === String(values[0]) && thread.version_id === String(values[1]) && thread.deleted_at == null).sort((a, b) => b.created_at - a.created_at),
      };
    }

    if (query.includes('t.version_id = ?') && query.includes('FROM comment_messages')) {
      const artifactId = String(values[0]);
      const rawVersionId = values[values.length - 1];
      const versionId = rawVersionId == null ? null : String(rawVersionId);
      const pagePath = query.includes('t.page_path = ?') ? String(values[1]) : null;
      const validThreads = new Map(this.commentThreads
        .filter((thread) => thread.artifact_id === artifactId && (versionId == null || thread.version_id === versionId) && thread.deleted_at == null && (!pagePath || thread.page_path === pagePath))
        .map((thread) => [thread.id, thread]));
      return { results: this.commentMessages.filter((message) => validThreads.has(message.thread_id)).map((message) => ({ ...message, thread_status: validThreads.get(message.thread_id)?.status || 'open' })).sort((a, b) => a.created_at - b.created_at) };
    }

    if (query.includes('version_id = ?') && query.includes('FROM comment_threads')) {
      const artifactId = String(values[0]);
      const pagePath = query.includes('page_path = ?') ? String(values[1]) : null;
      const rawVersionId = values[values.length - 1];
      const versionId = rawVersionId == null ? null : String(rawVersionId);
      return { results: this.commentThreads.filter((thread) => thread.artifact_id === artifactId && (versionId == null || thread.version_id === versionId) && thread.deleted_at == null && (!pagePath || thread.page_path === pagePath)).sort((a, b) => b.created_at - a.created_at) };
    }

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
    if (query.includes('SELECT a.current_version_id AS id, COALESCE(av.seq, 0) AS seq')) {
      const artifact = this.artifacts.find((item) => item.id === String(values[0]));
      if (!artifact) return null;
      const version = this.artifactVersions.find((item) => item.id === artifact.current_version_id);
      return ({ id: artifact.current_version_id || null, seq: version?.seq || 0 }) as T;
    }
    if (query.includes('SELECT id, seq FROM artifact_versions WHERE artifact_id = ?')) {
      const version = this.artifactVersions.filter((item) => item.artifact_id === String(values[0])).sort((a, b) => b.seq - a.seq)[0];
      return (version ? { id: version.id, seq: version.seq } : null) as T | null;
    }

    if (query.includes('SELECT av.content_hash AS chash')) {
      const artifact = this.artifacts.find((item) => item.id === String(values[0]));
      const version = this.artifactVersions.find((item) => item.id === artifact?.current_version_id);
      return ({ chash: version?.content_hash || null }) as T;
    }

    if (query.includes('SELECT COUNT(*) AS n FROM comment_threads')) {
      return ({ n: this.commentThreads.filter((thread) => thread.artifact_id === String(values[0]) && thread.deleted_at == null).length }) as T;
    }

    if (query.includes('SELECT current_version_id AS vid FROM artifacts WHERE id = ?')) {
      const artifact = this.artifacts.find((item) => item.id === String(values[0]));
      return (artifact ? { vid: artifact.current_version_id || null } : null) as T | null;
    }

    if (query.includes('SELECT id FROM artifact_versions WHERE artifact_id = ? AND seq = ?')) {
      const version = this.artifactVersions.find((item) => item.artifact_id === String(values[0]) && item.seq === Number(values[1]));
      return (version ? { id: version.id } : null) as T | null;
    }

    if (query.includes('SELECT MAX(seq) AS max FROM artifact_versions')) {
      const versions = this.artifactVersions.filter((item) => item.artifact_id === String(values[0]));
      return ({ max: versions.length ? Math.max(...versions.map((item) => item.seq)) : null }) as T;
    }
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
      return (a ? { comments_enabled: a.comments_enabled, expires_at: a.expires_at, password_epoch: a.password_epoch ?? 0 } : null) as T | null;
    }

    if (query.includes('SELECT comments_enabled, password_epoch FROM artifacts WHERE id = ?')) {
      const a = this.artifacts.find((x) => x.id === String(values[0]));
      return (a ? { comments_enabled: a.comments_enabled, password_epoch: a.password_epoch ?? 0 } : null) as T | null;
    }

    if (query.includes('SELECT comments_enabled FROM artifacts WHERE id = ?')) {
      const id = String(values[0]);
      const artifact = this.artifacts.find((a) => a.id === id);
      return (artifact ? { comments_enabled: artifact.comments_enabled } : null) as T | null;
    }

    if (query.includes('SELECT id, expires_at, password_hash, current_version_id, password_epoch FROM artifacts WHERE slug = ?')) {
      const slug = String(values[0]);
      const artifact = this.artifacts.find((a) => a.slug === slug);
      return (
        artifact
          ? { id: artifact.id, expires_at: artifact.expires_at, password_hash: artifact.password_hash, current_version_id: artifact.current_version_id || null, password_epoch: artifact.password_epoch ?? 0 }
          : null
      ) as T | null;
    }

    if (query.includes('SELECT id, token_hash FROM artifacts WHERE slug = ?')) {
      const artifact = this.artifacts.find((item) => item.slug === String(values[0]));
      return (artifact ? { id: artifact.id, token_hash: artifact.token_hash } : null) as T | null;
    }

    if (query.includes('SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[0]));
      return (thread ? { artifact_id: thread.artifact_id, deleted_at: thread.deleted_at } : null) as T | null;
    }

    if (query.includes('SELECT artifact_id, status, deleted_at FROM comment_threads WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[0]));
      return (thread ? { artifact_id: thread.artifact_id, status: thread.status, deleted_at: thread.deleted_at } : null) as T | null;
    }

    if (query.includes('SELECT artifact_id, created_by_token_hash, deleted_at FROM comment_threads WHERE id = ?')) {
      const thread = this.commentThreads.find((item) => item.id === String(values[0]));
      return (
        thread
          ? { artifact_id: thread.artifact_id, created_by_token_hash: thread.created_by_token_hash, deleted_at: thread.deleted_at }
          : null
      ) as T | null;
    }

    if (query.includes('SELECT m.thread_id, m.author_token_hash, m.kind, m.deleted_at, t.artifact_id')) {
      const message = this.commentMessages.find((item) => item.id === String(values[0]));
      if (!message) return null;
      const thread = this.commentThreads.find((item) => item.id === message.thread_id && item.deleted_at == null);
      if (!thread) return null;
      return ({
        thread_id: message.thread_id,
        author_token_hash: message.author_token_hash,
        kind: message.kind,
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

  it('defines the Worker message-kind migration with a note default and constrained values', async () => {
    const migration = await readFile('src/templates/worker/migrations/0011_comment_message_kind.sql', 'utf8');
    expect(migration).toContain("ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'");
    expect(migration).toContain("CHECK (kind IN ('note', 'blocker', 'concern', 'question', 'action', 'nit', 'resolution'))");
  });

  it('escapes paths before serializing them into an inline script context', () => {
    const path = 'docs/</script><script>alert(1)</script>\u2028line\u2029end.html';
    const payload = serializeInlineScriptValue({ currentPagePath: path });
    expect(payload).not.toContain('</script>');
    expect(payload).toContain('\\u003c/script>');
    expect(payload).toContain('\\u2028');
    expect(payload).toContain('\\u2029');
    expect(new Function(`return ${payload}`)()).toEqual({ currentPagePath: path });
  });

  it('propagates Worker reply identity without overwriting divergent editor text or draft work', async () => {
    const state = {
      currentLabel: 'Old Name',
      replyDrafts: {
        a: { name: 'Old Name', body: 'body a', kind: 'blocker', identityEditing: false, identityEditorValue: 'Old Name', priorIdentity: 'Old Name', extra: 'a' },
        b: { name: 'Old Name', body: 'body b', kind: 'question', identityEditing: true, identityEditorValue: 'Unconfirmed B', priorIdentity: 'Old Name', extra: 'b' },
        c: { name: 'Different', body: 'body c', kind: 'nit', identityEditing: false, identityEditorValue: 'Different', priorIdentity: 'Different' },
      },
    };
    const nameInput = { value: '' };
    const storage = new Map<string, string>();
    const commit = await embeddedWorkerFunction(
      'commitGlobalIdentity',
      ['state', 'nameInput', 'localStorage', 'nameStorageKey', 'updateComposerReadiness'],
      [state, nameInput, { setItem: (key: string, value: string) => storage.set(key, value) }, 'toss-comment-name:artifact', () => undefined],
    );

    expect(commit(' Old Name ', ' New Name ')).toBe(true);

    expect(state.currentLabel).toBe('New Name');
    expect(nameInput.value).toBe('New Name');
    expect(storage.get('toss-comment-name:artifact')).toBe('New Name');
    expect(state.replyDrafts.a).toMatchObject({ name: 'New Name', body: 'body a', kind: 'blocker', identityEditorValue: 'New Name', priorIdentity: 'New Name', extra: 'a' });
    expect(state.replyDrafts.b).toMatchObject({ name: 'New Name', body: 'body b', kind: 'question', identityEditing: true, identityEditorValue: 'Unconfirmed B', priorIdentity: 'New Name', extra: 'b' });
    expect(state.replyDrafts.c).toMatchObject({ name: 'Different', body: 'body c', kind: 'nit', priorIdentity: 'Different' });
  });

  it('propagates an initially empty Worker identity to every empty seeded draft', async () => {
    const state = {
      currentLabel: '',
      replyDrafts: {
        a: { name: '', body: 'a', kind: 'note', identityEditing: true, identityEditorValue: 'Reviewer A', priorIdentity: '' },
        b: { name: '', body: 'b', kind: 'action', identityEditing: true, identityEditorValue: '', priorIdentity: '' },
      },
    };
    const commit = await embeddedWorkerFunction(
      'commitGlobalIdentity',
      ['state', 'nameInput', 'localStorage', 'nameStorageKey', 'updateComposerReadiness'],
      [state, { value: '' }, { setItem: () => undefined }, 'toss-comment-name:artifact', () => undefined],
    );

    commit('', 'Saved Reviewer');

    expect(state.replyDrafts.a).toMatchObject({ name: 'Saved Reviewer', body: 'a', kind: 'note', identityEditorValue: 'Reviewer A', priorIdentity: 'Saved Reviewer' });
    expect(state.replyDrafts.b).toMatchObject({ name: 'Saved Reviewer', body: 'b', kind: 'action', identityEditorValue: 'Saved Reviewer', priorIdentity: 'Saved Reviewer' });
  });

  it('cancels Worker identity editing to the latest propagated fallback and keeps missing identity required', async () => {
    const drafts = {
      saved: { name: 'Latest Name', body: 'saved body', kind: 'question', identityEditing: true, identityEditorValue: 'Unconfirmed', priorIdentity: 'Old Name' },
      missing: { name: '', body: 'missing body', kind: 'nit', identityEditing: true, identityEditorValue: 'Unconfirmed', priorIdentity: '' },
    };
    const state = { currentLabel: 'Latest Name' };
    const focused: string[] = [];
    const cancel = await embeddedWorkerFunction(
      'cancelIdentityEdit',
      ['state', 'ensureReplyDraft', 'render', 'focusReplyControl'],
      [state, (threadId: keyof typeof drafts) => drafts[threadId], () => undefined, (_threadId: string, selector: string) => focused.push(selector)],
    );

    cancel('saved', true);
    expect(drafts.saved).toMatchObject({ name: 'Latest Name', body: 'saved body', kind: 'question', identityEditing: false, identityEditorValue: 'Latest Name', priorIdentity: 'Latest Name' });
    expect(focused.at(-1)).toBe('.toss-comments-identity-change');

    state.currentLabel = '';
    cancel('missing', true);
    expect(drafts.missing).toMatchObject({ name: '', body: 'missing body', kind: 'nit', identityEditing: true, identityEditorValue: '', priorIdentity: '' });
    expect(focused.at(-1)).toBe('.toss-comments-reply-name');
  });

  it('preserves filtered Worker drafts while discarding confirmed missing and resolved drafts', async () => {
    const state = {
      replyDrafts: { open: { body: 'keep' }, filtered: { body: 'also keep' }, resolved: { body: 'drop' }, missing: { body: 'drop' } },
      replyThreadId: 'filtered',
      replyOriginThreadId: '',
      replyFocusAfterRender: '',
    };
    const reconcile = await embeddedWorkerFunction(
      'reconcileReplyDrafts',
      ['state', 'visibleThread'],
      [state, (thread: { id: string }) => thread.id !== 'filtered'],
    );

    reconcile([
      { id: 'open', status: 'open', deleted_at: null },
      { id: 'filtered', status: 'open', deleted_at: null },
      { id: 'resolved', status: 'resolved', deleted_at: null },
    ], true);

    expect(state.replyDrafts).toEqual({ open: { body: 'keep' }, filtered: { body: 'also keep' } });
    expect(state.replyThreadId).toBe('');
    expect(state.replyOriginThreadId).toBe('filtered');
    expect(state.replyFocusAfterRender).toBe('filtered');
  });

  it('invalidates older Worker thread loads so only the newest generation can apply', async () => {
    const state = { threadLoadGeneration: 0, loading: false };
    const begin = await embeddedWorkerFunction('beginThreadLoad', ['state'], [state]);
    const invalidate = await embeddedWorkerFunction('invalidateThreadLoads', ['state'], [state]);
    const isCurrent = await embeddedWorkerFunction('isCurrentThreadLoad', ['state'], [state]);

    const first = begin();
    const second = begin();
    expect(isCurrent(first)).toBe(false);
    expect(isCurrent(second)).toBe(true);

    invalidate();
    expect(isCurrent(second)).toBe(false);
    expect(state.loading).toBe(false);
  });

  it('prevents a paused pre-commit GET from applying after a newer mutation result', async () => {
    const state = { threadLoadGeneration: 0, loading: false, mutationsInFlight: 0, authoritative: 'initial' };
    const beginLoad = await embeddedWorkerFunction('beginThreadLoad', ['state'], [state]);
    const invalidate = await embeddedWorkerFunction('invalidateThreadLoads', ['state'], [state]);
    const isCurrent = await embeddedWorkerFunction('isCurrentThreadLoad', ['state'], [state]);
    const beginMutation = await embeddedWorkerFunction('beginMutation', ['state', 'invalidateThreadLoads'], [state, invalidate]);
    const endMutation = await embeddedWorkerFunction('endMutation', ['state', 'invalidateThreadLoads'], [state, invalidate]);
    const runMutation = await embeddedWorkerFunction('runMutation', ['beginMutation', 'invalidateThreadLoads', 'endMutation'], [beginMutation, invalidate, endMutation]);
    let releaseGet!: (value: string) => void;
    let releaseMutation!: (value: string) => void;
    const getResponse = new Promise<string>((resolve) => { releaseGet = resolve; });
    const mutationResponse = new Promise<string>((resolve) => { releaseMutation = resolve; });

    const staleGeneration = beginLoad();
    const staleGet = getResponse.then((value) => {
      if (isCurrent(staleGeneration)) state.authoritative = value;
    });
    const mutation = runMutation(() => mutationResponse);

    expect(state.mutationsInFlight).toBe(1);
    expect(isCurrent(staleGeneration)).toBe(false);

    releaseMutation('mutated');
    state.authoritative = await mutation;
    expect(state.authoritative).toBe('mutated');
    expect(state.mutationsInFlight).toBe(0);

    releaseGet('stale pre-commit');
    await staleGet;
    expect(state.authoritative).toBe('mutated');
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
      const statefulDb = new StatefulMockD1();
      const req = new Request('http://localhost/artifacts?name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>test</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, statefulDb as unknown as MockD1));
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
      const statefulDb = new StatefulMockD1();
      const req = new Request('http://localhost/artifacts?expires=3600&name=test.html', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html>test</html>',
      });
      const res = await worker.fetch(req, createEnv(kv, statefulDb as unknown as MockD1));
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.id).toBeDefined();
      expect(body.url).toMatch(/^http:\/\/localhost\/s\/[a-z0-9-]+/);
      expect(body.legacyUrl).toMatch(/^http:\/\/localhost\/a\/[a-f0-9-]+\?t=eyJ/);
      expect(body.slug).toBeDefined();

      const versionKeys = await kv.list({ prefix: `artifacts/${body.id}/versions/` });
      expect(versionKeys.keys).toHaveLength(1);
      const stored = await kv.get(versionKeys.keys[0].name);
      expect(stored).toBe('<html>test</html>');
    });

    it('serves additional HTML files from stable keys after publishing the versioned entry page', async () => {
      const statefulDb = new StatefulMockD1();
      const env = createEnv(kv, statefulDb as unknown as MockD1);
      const create = await worker.fetch(new Request('http://localhost/artifacts?expires=3600&name=site/index.html&id=versioned-multipage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html><body>Entry page</body></html>',
      }), env);
      expect(create.status).toBe(200);
      const artifact = await create.json() as { id: string; slug: string };
      expect(statefulDb.artifacts.find((item) => item.id === artifact.id)?.current_version_id).toBeTruthy();

      const uploadPage = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/files?path=p.html`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OWNER}` },
        body: '<html><body>Additional page</body></html>',
      }), env);
      expect(uploadPage.status).toBe(200);

      const servedPage = await worker.fetch(new Request(`http://localhost/s/${artifact.slug}/p.html`), env);
      expect(servedPage.status).toBe(200);
      expect(servedPage.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(await servedPage.text()).toBe('<html><body>Additional page</body></html>');

      const servedEntry = await worker.fetch(new Request(`http://localhost/s/${artifact.slug}/`), env);
      expect(servedEntry.status).toBe(200);
      expect(await servedEntry.text()).toBe('<html><body>Entry page</body></html>');
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
          kind: 'blocker',
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
        thread: { id: string; messages: Array<{ id: string; body: string; kind: string }>; scope_type: string };
      };
      expect(createdThread.thread.scope_type).toBe('element');
      expect(createdThread.thread.messages[0].id).toBe(createdThread.messageId);
      expect(createdThread.thread.messages[0].body).toBe('Hero heading should feel bolder.');
      expect(createdThread.thread.messages[0].kind).toBe('blocker');

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
      const selectionThreadBody = await selectionThread.json() as { thread: { messages: Array<{ kind: string }> } };
      expect(selectionThreadBody.thread.messages[0].kind).toBe('note');

      const invalidKindThread = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Reviewer A', body: 'Unknown kind.', kind: 'urgent', pagePath: 'index.html', scopeType: 'artifact' }),
      }), env);
      expect(invalidKindThread.status).toBe(400);

      const reply = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberBToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Reviewer B', body: 'Agree, and maybe tighten the line height too.', kind: 'question' }),
      }), env);
      expect(reply.status).toBe(201);
      const replyBody = await reply.json() as { id: string; message: { body: string; kind: string }; threadUpdatedAt: number };
      expect(replyBody.message.body).toBe('Agree, and maybe tighten the line height too.');
      expect(replyBody.message.kind).toBe('question');
      expect(replyBody.threadUpdatedAt).toBeGreaterThan(0);

      const invalidKindReply = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/messages`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Reviewer B', body: 'Not a valid typed reply.', kind: 'resolution' }),
      }), env);
      expect(invalidKindReply.status).toBe(400);

      const missingReplyName = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/messages`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Missing attribution.', kind: 'nit' }),
      }), env);
      expect(missingReplyName.status).toBe(400);

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

      const resolveWithoutNote = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/resolve`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Reviewer C' }),
      }), env);
      expect(resolveWithoutNote.status).toBe(400);

      const resolveWithoutName = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/resolve`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'This note has no attribution.' }),
      }), env);
      expect(resolveWithoutName.status).toBe(400);

      const ownerResolve = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/resolve`, {
        method: 'POST',
        headers: {
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Reviewer C', body: 'Updated the heading weight and verified the final contrast.' }),
      }), env);
      expect(ownerResolve.status).toBe(200);
      const ownerResolveBody = await ownerResolve.json() as {
        status: string;
        resolvedByLabel: string;
        updatedAt: number;
        message: {
          id: string;
          thread_id: string;
          author_label: string;
          body: string;
          kind: string;
          can_edit: boolean;
          can_delete: boolean;
        };
      };
      expect(ownerResolveBody.status).toBe('resolved');
      expect(ownerResolveBody.resolvedByLabel).toBe('Reviewer C');
      expect(ownerResolveBody.updatedAt).toBeGreaterThan(0);
      expect(ownerResolveBody.message).toMatchObject({
        thread_id: createdThread.id,
        author_label: 'Reviewer C',
        body: 'Updated the heading weight and verified the final contrast.',
        kind: 'resolution',
        can_edit: false,
        can_delete: false,
      });
      expect(ownerResolveBody.message.id).toBeTruthy();
      expect(statefulDb.commentMessages.at(-1)).toMatchObject({
        author_label: 'Reviewer C',
        body: 'Updated the heading weight and verified the final contrast.',
        kind: 'resolution',
      });

      const duplicateResolve = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/resolve`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Reviewer D', body: 'Duplicate resolution must not be recorded.' }),
      }), env);
      expect(duplicateResolve.status).toBe(409);
      expect(statefulDb.commentMessages.filter((message) => message.thread_id === createdThread.id && message.kind === 'resolution')).toHaveLength(1);

      const deleteResolution = await worker.fetch(new Request(`http://localhost/comment-messages/${ownerResolveBody.message.id}`, {
        method: 'DELETE',
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      expect(deleteResolution.status).toBe(409);
      expect(statefulDb.commentMessages.find((message) => message.id === ownerResolveBody.message.id)?.deleted_at).toBeNull();

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

      const anonymousReopen = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/reopen`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }), env);
      expect(anonymousReopen.status).toBe(400);

      const reopenThread = await worker.fetch(new Request(`http://localhost/comment-threads/${createdThread.id}/reopen`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${memberAToken}`,
          'X-Toss-Viewer': viewerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Reviewer A' }),
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
          messages: Array<{ body: string; kind: string; deleted_at: number | null; can_edit: boolean; can_delete: boolean }>;
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
      expect(reopenedThread?.messages.some((message) => message.kind === 'resolution')).toBe(true);
      expect(reopenedThread?.messages.some((message) => message.kind === 'blocker')).toBe(true);
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

    it('carries typed resolved threads and publishes versions atomically under failure and contention', async () => {
      const statefulDb = new StatefulMockD1();
      const env = { ...createEnv(kv, statefulDb as unknown as MockD1), MULTI_TENANT: 'true' };
      const create = await worker.fetch(new Request('http://localhost/artifacts?id=version-review&expires=3600&name=review.html&comments=1', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>Version one</body></html>',
      }), env);
      expect(create.status).toBe(200);
      const artifact = await create.json() as { id: string };
      const firstVersion = statefulDb.artifactVersions[0];
      expect(firstVersion.seq).toBe(1);

      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      const viewerToken = await signJWT({ sub: artifact.id, aud: 'comment', pwd_epoch: 0, iat: now, exp: now + 3600 }, SECRET);
      const createThread = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads`, {
        method: 'POST',
        headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Ari', body: 'This blocks launch.', kind: 'blocker', pagePath: 'index.html', scopeType: 'artifact' }),
      }), env);
      const firstThread = await createThread.json() as { id: string };
      expect(statefulDb.commentThreads.find((thread) => thread.id === firstThread.id)?.version_id).toBe(firstVersion.id);

      const noteReply = await worker.fetch(new Request(`http://localhost/comment-threads/${firstThread.id}/messages`, {
        method: 'POST', headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bo', body: 'Fix is ready for review.' }),
      }), env);
      expect(noteReply.status).toBe(201);
      const resolve = await worker.fetch(new Request(`http://localhost/comment-threads/${firstThread.id}/resolve`, {
        method: 'POST', headers: { 'X-Toss-Viewer': viewerToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Casey', body: 'Verified the fix in the updated layout.' }),
      }), env);
      expect(resolve.status).toBe(200);
      const original = statefulDb.commentThreads.find((thread) => thread.id === firstThread.id)!;

      const noOpReshare = await worker.fetch(new Request('http://localhost/artifacts?id=version-review&expires=3600&name=review.html', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>Version one</body></html>',
      }), env);
      expect(noOpReshare.status).toBe(409);

      const reshare = await worker.fetch(new Request('http://localhost/artifacts?id=version-review&expires=3600&name=review.html', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>Version two</body></html>',
      }), env);
      expect(reshare.status).toBe(200);
      expect(statefulDb.artifactVersions.map((version) => version.seq)).toEqual([1, 2]);
      const secondVersion = statefulDb.artifactVersions[1];
      const copied = statefulDb.commentThreads.find((thread) => thread.version_id === secondVersion.id)!;
      expect(copied.id).not.toBe(original.id);
      expect(copied).toMatchObject({
        status: 'resolved',
        resolved_by_label: original.resolved_by_label,
        resolved_at: original.resolved_at,
      });
      expect(statefulDb.commentMessages.filter((message) => message.thread_id === copied.id).map((message) => message.kind)).toEqual(['blocker', 'note', 'resolution']);

      const latest = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      const latestBody = await latest.json() as { threads: Array<{ id: string; status: string; resolved_by_label: string; messages: Array<{ kind: string; can_delete: boolean }> }> };
      expect(latestBody.threads.map((thread) => thread.id)).toEqual([copied.id]);
      expect(latestBody.threads[0].messages.find((message) => message.kind === 'resolution')?.can_delete).toBe(false);

      const versionOne = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?version=1`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      const versionOneBody = await versionOne.json() as { version: number; threads: Array<{ id: string }> };
      expect(versionOneBody.version).toBe(1);
      expect(versionOneBody.threads.map((thread) => thread.id)).toEqual([original.id]);

      const versionTwo = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?version=2`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      const versionTwoBody = await versionTwo.json() as { version: number; threads: Array<{ id: string }> };
      expect(versionTwoBody.threads.map((thread) => thread.id)).toEqual([copied.id]);

      const versions = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/versions`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      const versionsBody = await versions.json() as { versions: Array<{ seq: number; comment_count: number; is_current: boolean }> };
      expect(versionsBody.versions).toEqual([
        expect.objectContaining({ seq: 2, comment_count: 1, is_current: true }),
        expect.objectContaining({ seq: 1, comment_count: 1, is_current: false }),
      ]);

      const missingVersion = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?version=3`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      expect(missingVersion.status).toBe(404);
      expect(await missingVersion.json()).toMatchObject({ error: 'version_not_found', seq: 3, hint: 'this share has versions 1-2' });

      statefulDb.failNextStagedMessageInsert = true;
      const failedReshare = await worker.fetch(new Request('http://localhost/artifacts?id=version-review&expires=3600&name=review.html', {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>Failed version three</body></html>',
      }), env);
      expect(failedReshare.status).toBe(500);
      expect(statefulDb.artifacts.find((item) => item.id === artifact.id)?.current_version_id).toBe(secondVersion.id);
      expect((await kv.list({ prefix: `artifacts/${artifact.id}/versions/` })).keys).toHaveLength(2);
      expect(statefulDb.artifactVersions.map((version) => version.seq)).toEqual([1, 2]);
      expect(statefulDb.commentThreads.every((thread) => !thread.version_id || statefulDb.artifactVersions.some((version) => version.id === thread.version_id))).toBe(true);
      const latestAfterFailure = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      const latestAfterFailureBody = await latestAfterFailure.json() as { threads: Array<{ id: string; messages: Array<{ kind: string }> }> };
      expect(latestAfterFailureBody.threads).toHaveLength(1);
      expect(latestAfterFailureBody.threads[0].id).toBe(copied.id);
      expect(latestAfterFailureBody.threads[0].messages.map((message) => message.kind)).toEqual(['blocker', 'note', 'resolution']);

      let arrivals = 0;
      let releasePublish!: () => void;
      let reportBothStaged!: () => void;
      const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
      const bothStaged = new Promise<void>((resolve) => { reportBothStaged = resolve; });
      statefulDb.beforeVersionPublishBatch = async () => {
        arrivals++;
        if (arrivals === 2) reportBothStaged();
        await publishGate;
      };
      const competingRequests = [
        worker.fetch(new Request('http://localhost/artifacts?id=version-review&expires=3600&name=competing-a.html', {
          method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>Competing version A</body></html>',
        }), env),
        worker.fetch(new Request('http://localhost/artifacts?id=version-review&expires=7200&name=competing-b.html', {
          method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: '<html><body>Competing version B</body></html>',
        }), env),
      ];
      await bothStaged;
      expect(statefulDb.artifacts.find((item) => item.id === artifact.id)?.current_version_id).toBe(secondVersion.id);
      const visibleWhileStaged = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      const visibleWhileStagedBody = await visibleWhileStaged.json() as { threads: Array<{ id: string; messages: Array<{ kind: string }> }> };
      expect(visibleWhileStagedBody.threads.map((thread) => thread.id)).toEqual([copied.id]);
      expect(visibleWhileStagedBody.threads[0].messages.map((message) => message.kind)).toEqual(['blocker', 'note', 'resolution']);
      const pageWhileStaged = await worker.fetch(new Request('http://localhost/s/version-review/'), env);
      expect(await pageWhileStaged.text()).toContain('Version two');
      releasePublish();
      const competing = await Promise.all(competingRequests);
      statefulDb.beforeVersionPublishBatch = null;
      expect(competing.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(statefulDb.artifactVersions.map((version) => version.seq)).toEqual([1, 2, 3]);
      const publishedThird = statefulDb.artifactVersions[2];
      const publishedArtifact = statefulDb.artifacts.find((item) => item.id === artifact.id)!;
      expect(publishedArtifact.current_version_id).toBe(publishedThird.id);
      const winnerIndex = competing.findIndex((response) => response.status === 200);
      const winningHtml = winnerIndex === 0
        ? '<html><body>Competing version A</body></html>'
        : '<html><body>Competing version B</body></html>';
      expect(publishedArtifact.name).toBe(winnerIndex === 0 ? 'competing-a.html' : 'competing-b.html');
      expect(publishedArtifact.size_bytes).toBe(winningHtml.length);
      expect(publishedArtifact.expires_at).toBe(publishedThird.created_at + (winnerIndex === 0 ? 3600 : 7200));
      expect(publishedThird.content_hash).toBe(await sha256(winningHtml));
      const servedWinner = await worker.fetch(new Request('http://localhost/s/version-review/'), env);
      const servedWinnerBody = await servedWinner.text();
      expect(servedWinnerBody).toContain(winnerIndex === 0 ? 'Competing version A' : 'Competing version B');
      const currentStoredHtml = await kv.get(`artifacts/${artifact.id}/versions/${publishedThird.id}/files/index.html`);
      expect(currentStoredHtml).toBe(winningHtml);
      expect(await sha256(currentStoredHtml!)).toBe(publishedThird.content_hash);
      const versionKeysAfterRace = await kv.list({ prefix: `artifacts/${artifact.id}/versions/` });
      expect(versionKeysAfterRace.keys.map((key) => key.name).sort()).toEqual(
        statefulDb.artifactVersions.map((version) => `artifacts/${artifact.id}/versions/${version.id}/files/index.html`).sort(),
      );
      expect(statefulDb.commentThreads.every((thread) => !thread.version_id || statefulDb.artifactVersions.some((version) => version.id === thread.version_id))).toBe(true);
      const latestAfterRace = await worker.fetch(new Request(`http://localhost/artifacts/${artifact.id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': viewerToken },
      }), env);
      const latestAfterRaceBody = await latestAfterRace.json() as { threads: Array<{ version_id?: string; messages: Array<{ kind: string }> }> };
      expect(latestAfterRaceBody.threads).toHaveLength(1);
      expect(latestAfterRaceBody.threads[0].messages.map((message) => message.kind)).toEqual(['blocker', 'note', 'resolution']);
      const currentThreads = statefulDb.commentThreads.filter((thread) => thread.version_id === publishedThird.id);
      expect(currentThreads).toHaveLength(1);
      expect(statefulDb.commentMessages.filter((message) => message.thread_id === currentThreads[0].id).map((message) => message.kind)).toEqual(['blocker', 'note', 'resolution']);
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
        version_id: statefulDb.artifacts.find((item) => item.id === artifact.id)?.current_version_id,
        created_by_token_hash: 'd'.repeat(64), created_by_label: 'Legacy User',
        scope_type: 'artifact', anchor_json: null, status: 'open',
        resolved_by_token_hash: null, resolved_by_label: null, resolved_at: null,
        deleted_at: null, deleted_by_token_hash: null, created_at: now, updated_at: now,
      });
      statefulDb.commentMessages.push({
        id: 'legacy-msg', thread_id: 'legacy-thread',
        author_token_hash: 'd'.repeat(64), author_label: 'Legacy User',
        body: 'Comment from the old token model', kind: 'note', created_at: now, updated_at: now,
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
      const pageBody = await page.text();
      expect(pageBody).toContain('toss-comments-root');
      expect(pageBody).toContain('toss-comments-kind-chips');
      expect(pageBody).toContain('toss-comments-readiness');
      expect(pageBody).toContain('Review readiness');
      expect(pageBody.match(/toss-comments-readiness-card/g)?.length).toBeGreaterThanOrEqual(3);
      expect(pageBody).toContain('grid-template-columns:minmax(0,1fr) auto');
      expect(pageBody).toContain('toss-comments-message-time');
      expect(pageBody).toContain('toss-comments-resolved-badge');
      expect(pageBody).toContain('role="dialog" aria-modal="true" aria-labelledby="toss-resolve-title"');
      expect(pageBody).toContain('toss-comments-resolution-context');
      expect(pageBody).toContain('toss-comments-attribution-text');
      expect(pageBody).toContain('This resolution will be attributed to ');
      expect(pageBody).toContain('id="toss-resolution-name"');
      expect(pageBody).toContain('id="toss-resolution-body"');
      expect(pageBody).toContain('max-width:calc(100vw - 24px)');
      expect(pageBody).toContain('overflow-x:hidden');
      expect(pageBody).toContain("statusFilter: 'open'");
      expect(pageBody).toContain("replyDrafts: Object.create(null)");
      expect(pageBody).toContain("replyOriginThreadId: ''");
      expect(pageBody).toContain('const ensureReplyDraft = (threadId) =>');
      expect(pageBody).toContain('const commitGlobalIdentity = (oldName, newName) =>');
      expect(pageBody).toContain("const previous = String(oldName || '').trim();");
      expect(pageBody).toContain('if (draft.name !== previous) return;');
      expect(pageBody).toContain('if (!draft.identityEditing || draft.identityEditorValue === previous) draft.identityEditorValue = committed;');
      expect(pageBody).toContain('localStorage.setItem(nameStorageKey, committed);');
      expect(pageBody).toContain('const reconcileReplyDrafts = (threads, confirmed = true) =>');
      expect(pageBody).toContain("if (!thread || thread.deleted_at || thread.status !== 'open') delete state.replyDrafts[threadId]");
      expect(pageBody).toContain("replyBox.className = 'toss-comments-reply-composer'");
      expect(pageBody).toContain('replyBox.hidden = !expanded;');
      expect(pageBody).toContain('aria-controls="' + "' + composerId + '");
      expect(pageBody).toContain('aria-labelledby="' + "' + typeLabelId + '");
      expect(pageBody).toContain('class="toss-comments-identity-avatar" aria-hidden="true"');
      expect(pageBody).toContain('Replying as <strong>');
      expect(pageBody).toContain('data-action="change-reply-identity"');
      expect(pageBody).toContain('data-action="save-reply-identity"');
      expect(pageBody).toContain('data-action="cancel-reply-identity"');
      expect(pageBody).toContain('class="toss-comments-reply-chip"');
      expect(pageBody).toContain("event.key !== 'ArrowRight'");
      expect(pageBody).toContain('event.preventDefault();');
      expect(pageBody).toContain('const next = chips[(current + delta + chips.length) % chips.length];');
      expect(pageBody).toContain("focusReplyControl(threadId, draft.name && !draft.identityEditing ? '.toss-comments-reply-input' : '.toss-comments-reply-name')");
      expect(pageBody).toContain('const snapshot = {');
      expect(pageBody).toContain('state.replyDrafts[threadId] = { ...snapshot };');
      expect(pageBody).toContain('messages: (thread.messages || []).filter((message) => message.id !== optimisticMessageId)');
      expect(pageBody).toContain("focusReplyControl(threadId, snapshot.name ? '.toss-comments-reply-input' : '.toss-comments-reply-name')");
      expect(pageBody).toContain('threadLoadGeneration: 0');
      expect(pageBody).toContain('mutationsInFlight: 0');
      expect(pageBody).toContain('const generation = beginThreadLoad();');
      expect(pageBody).toContain('if (!isCurrentThreadLoad(generation)) return;');
      expect(pageBody).toContain('const runMutation = async (operation) =>');
      expect(pageBody).toContain('state.mutationsInFlight += 1;');
      expect(pageBody).toContain('state.mutationsInFlight = Math.max(0, state.mutationsInFlight - 1);');
      expect(pageBody).toContain("return method !== 'GET' && method !== 'HEAD' ? runMutation(request) : request();");
      expect(pageBody).toContain("if (document.visibilityState === 'hidden' || state.busy || state.loading || state.mutationsInFlight > 0) return;");
      expect(pageBody).toContain("if ((state.busy || state.mutationsInFlight > 0) && !target.classList.contains('toss-comments-toggle')) return;");
      expect(pageBody).toContain('const captureReplyFocus = () =>');
      expect(pageBody).toContain('selectionStart: null');
      expect(pageBody).toContain('const restoreReplyFocus = (snapshot) =>');
      expect(pageBody).toContain("control.focus({ preventScroll: true });");
      expect(pageBody).toContain("control.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection || 'none');");
      expect(pageBody).toContain('const replyFocus = captureReplyFocus();');
      expect(pageBody).toContain('render({ replyFocus });');
      expect(pageBody).toContain('data-reply-focus="identity-change"');
      expect(pageBody).toContain('data-reply-focus="reply-body"');
      expect(pageBody).toContain("data-reply-focus=\"reply-kind-' + kind + '\"");
      expect(pageBody).toContain("target.closest('.toss-comments-reply-composer,.toss-comments-thread-actions,button,textarea,input,select,label,[role=\"group\"]')");
      expect(pageBody).toContain("actions.className = 'toss-comments-actions toss-comments-thread-actions';");
      expect(pageBody).toContain("resolveOriginThreadId: ''");
      expect(pageBody).toContain('const closeResolutionDialog = (message) =>');
      expect(pageBody).toContain("const resolve = findThreadAction(threadId, 'resolve-thread');");
      expect(pageBody).toContain("closeResolutionDialog('Resolution cancelled.');");
      expect(pageBody).toContain('.toss-comments-panel{width:360px;max-width:360px');
      expect(pageBody).toContain('@media(max-width:430px){.toss-comments-shell{margin-top:0}.toss-comments-panel{width:100vw;max-width:100vw;border:0;box-shadow:none}');
      expect(pageBody).toContain('.toss-comments-filters{display:grid;grid-template-columns:1fr 1fr');
      expect(pageBody).toContain('.toss-comments-reply-input{height:64px;min-height:64px;resize:none');
      expect(pageBody).not.toContain('toss-comments-reply-kind');
      expect(pageBody).not.toContain("if (state.replyThreadId === thread.id) {");
      expect(pageBody).toContain('<option value="open">Open threads</option><option value="resolved">Resolved threads</option><option value="all">All threads</option>');
      expect(pageBody).toContain("return '<span class=\"toss-comments-type-badge ' + normalized + '\">' + esc(reviewTypes[normalized].label) + '</span>';");
      expect(pageBody).not.toContain("if (normalized === 'note') return '';");
      const widgetScript = pageBody.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(widgetScript).toBeTruthy();
      expect(() => new Function(widgetScript!)).not.toThrow();

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

  describe('Race-safe password_epoch bump on re-share', () => {
    async function makeEnv() {
      const statefulDb = new StatefulMockD1();
      statefulDb.users.push({ token_hash: await sha256(OWNER), label: 'admin', created_at: 1, is_admin: 1 });
      const localKv = new MockKV();
      const env = { ...createEnv(localKv, statefulDb as unknown as MockD1), MULTI_TENANT: 'true' };
      return { statefulDb, env };
    }

    async function reshare(env: any, slug: string, html: string, opts: { password?: string; comments?: boolean } = {}) {
      const params = new URLSearchParams({ name: 'v.html', id: slug, expires: '3600' });
      if (opts.password !== undefined) params.set('password', opts.password);
      if (opts.comments) params.set('comments', '1');
      return worker.fetch(new Request(`http://localhost/artifacts?${params.toString()}`, {
        method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: html,
      }), env);
    }

    async function session(id: string, epoch: number) {
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      return signJWT({ sub: id, aud: 'password-session', pwd_epoch: epoch, iat: now, exp: now + 3600 }, SECRET);
    }

    async function grant(id: string, epoch: number) {
      const { signJWT } = await import('../../src/templates/worker/src/jwt.js');
      const now = Math.floor(Date.now() / 1000);
      return signJWT({ sub: id, aud: 'comment', pwd_epoch: epoch, iat: now, exp: now + 3600 }, SECRET);
    }

    it('does NOT bump the epoch when the same password is re-shared', async () => {
      const { statefulDb, env } = await makeEnv();
      const first = await reshare(env, 'epoch-same', '<html>a</html>', { password: 'pw' });
      expect(first.status).toBe(200);
      const id = (await first.json() as { id: string }).id;

      await reshare(env, 'epoch-same', '<html>b</html>', { password: 'pw' });
      expect(statefulDb.artifacts.find((a) => a.id === id)?.password_epoch).toBe(0);

      // An epoch-0 session still authenticates.
      const res = await worker.fetch(new Request(`http://localhost/s/epoch-same/`, {
        headers: { Cookie: `toss_pwd_epoch-same=${await session(id, 0)}` },
      }), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<html>b</html>');
    });

    it('bumps the epoch on null -> hash and hash -> different (old session + grant fail)', async () => {
      const { statefulDb, env } = await makeEnv();
      const first = await reshare(env, 'epoch-set', '<html>a</html>', { comments: true });
      const id = (await first.json() as { id: string }).id;
      const oldGrant = await grant(id, 0);

      // null -> hash: epoch -> 1.
      await reshare(env, 'epoch-set', '<html>b</html>', { password: 'pw1', comments: true });
      expect(statefulDb.artifacts.find((a) => a.id === id)?.password_epoch).toBe(1);

      const gate1 = await worker.fetch(new Request(`http://localhost/s/epoch-set/`, {
        headers: { Cookie: `toss_pwd_epoch-set=${await session(id, 0)}` },
      }), env);
      expect(gate1.status).toBe(200);
      expect(await gate1.text()).toContain('Password Required');

      const comment1 = await worker.fetch(new Request(`http://localhost/artifacts/${id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': oldGrant },
      }), env);
      expect(comment1.status).toBe(401);

      // hash -> different: epoch -> 2.
      await reshare(env, 'epoch-set', '<html>c</html>', { password: 'pw2', comments: true });
      expect(statefulDb.artifacts.find((a) => a.id === id)?.password_epoch).toBe(2);

      const gate2 = await worker.fetch(new Request(`http://localhost/s/epoch-set/`, {
        headers: { Cookie: `toss_pwd_epoch-set=${await session(id, 1)}` },
      }), env);
      expect(gate2.status).toBe(200);
      expect(await gate2.text()).toContain('Password Required');
    });

    it('bumps on hash -> null (old grant fails; helper verifies old session false)', async () => {
      const { verifyPasswordSessionForTests } = await import('../../src/templates/worker/src/index.js');
      const { statefulDb, env } = await makeEnv();
      const first = await reshare(env, 'epoch-clear', '<html>a</html>', { password: 'pw', comments: true });
      const id = (await first.json() as { id: string }).id;
      const oldGrant = await grant(id, 0);
      const oldSession = await session(id, 0);

      // hash -> null: epoch -> 1.
      await reshare(env, 'epoch-clear', '<html>b</html>', { comments: true });
      expect(statefulDb.artifacts.find((a) => a.id === id)?.password_epoch).toBe(1);

      // Share is now unprotected: serve route does not inspect the cookie.
      const comment1 = await worker.fetch(new Request(`http://localhost/artifacts/${id}/comment-threads?pagePath=index.html`, {
        headers: { 'X-Toss-Viewer': oldGrant },
      }), env);
      expect(comment1.status).toBe(401);

      // Verify the old session token directly against the new epoch (helper-level).
      expect(await verifyPasswordSessionForTests(oldSession, id, 1, SECRET)).toBe(false);

      // Optional second bump: set a password again -> epoch 2; older token invalid.
      await reshare(env, 'epoch-clear', '<html>c</html>', { password: 'again', comments: true });
      expect(statefulDb.artifacts.find((a) => a.id === id)?.password_epoch).toBe(2);
      expect(await verifyPasswordSessionForTests(oldSession, id, 2, SECRET)).toBe(false);
    });
  });
});
