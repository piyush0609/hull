export class MockKV {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    this.store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts: { prefix: string; cursor?: string }) {
    const keys = Array.from(this.store.keys())
      .filter((k) => k.startsWith(opts.prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true, cursor: '' };
  }
}

class MockD1Statement {
  constructor(
    private query: string,
    private values: unknown[] = [],
    private parent: MockD1
  ) {}

  bind(...values: unknown[]) {
    return new MockD1Statement(this.query, values, this.parent);
  }

  async run() {
    return this.parent.run(this.query, this.values);
  }

  async all() {
    return { results: this.parent.rows };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return this.parent.first<T>(this.query, this.values);
  }
}

export class MockD1 {
  rows: Array<Record<string, unknown>> = [];
  private artifacts = new Map<string, { currentVersionId: string | null }>();

  prepare(query: string) {
    return new MockD1Statement(query, [], this);
  }

  async batch(statements: MockD1Statement[]) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async run(query: string, values: unknown[]) {
    if (query.includes('INSERT INTO artifacts')) {
      this.artifacts.set(String(values[0]), { currentVersionId: null });
    }
    if (query.includes('UPDATE artifacts SET current_version_id = ?')) {
      const artifact = this.artifacts.get(String(values[5]));
      if (artifact) artifact.currentVersionId = String(values[0]);
    }
    if (query.includes('DELETE FROM artifacts WHERE id = ?')) {
      this.artifacts.delete(String(values[0]));
    }
    return { success: true, meta: { changes: 1 } };
  }

  async first<T>(query: string, values: unknown[]): Promise<T | null> {
    if (query.includes('SELECT a.current_version_id AS id, COALESCE(av.seq, 0) AS seq')) {
      const artifact = this.artifacts.get(String(values[0]));
      return (artifact ? { id: artifact.currentVersionId, seq: artifact.currentVersionId ? 1 : 0 } : null) as T | null;
    }
    if (query.includes('SELECT current_version_id AS vid FROM artifacts WHERE id = ?')) {
      const artifact = this.artifacts.get(String(values[0]));
      return (artifact ? { vid: artifact.currentVersionId } : null) as T | null;
    }
    return (this.rows[0] as T | null) ?? null;
  }

  setRows(rows: Array<Record<string, unknown>>) {
    this.rows = rows;
    for (const row of rows) {
      if (row.id) {
        this.artifacts.set(String(row.id), {
          currentVersionId: row.current_version_id ? String(row.current_version_id) : null,
        });
      }
    }
  }
}

export const SECRET = 'a3f7c9e1d2b4a6085c7e9f1023456789abcdef0123456789abcdef0123456789';
export const OWNER = 'deadbeef0123456789abcdef01234567';

export function createEnv(kv: MockKV, db: MockD1) {
  return {
    TOSS_KV: kv as unknown as KVNamespace,
    TOSS_DB: db as unknown as D1Database,
    JWT_SECRET: SECRET,
    OWNER_TOKEN: OWNER,
  };
}
