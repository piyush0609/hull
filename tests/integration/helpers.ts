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
    private parentRows: Array<Record<string, unknown>> = []
  ) {}

  bind(...values: unknown[]) {
    return new MockD1Statement(this.query, values, this.parentRows);
  }

  async run() {
    return { success: true };
  }

  async all() {
    return { results: this.parentRows };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.parentRows[0] as T | null) ?? null;
  }
}

export class MockD1 {
  private rows: Array<Record<string, unknown>> = [];

  prepare(query: string) {
    return new MockD1Statement(query, [], this.rows);
  }

  setRows(rows: Array<Record<string, unknown>>) {
    this.rows = rows;
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
