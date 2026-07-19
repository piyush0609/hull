import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeCommentLabelApply, computeCommentLabelClear } from '../../src/templates/vercel/api/index.ts';

async function loadHandler(env: { owner?: string; multiTenant?: boolean }, sql: any) {
  vi.resetModules();
  if (env.owner === undefined) delete process.env.OWNER_TOKEN;
  else process.env.OWNER_TOKEN = env.owner;
  process.env.MULTI_TENANT = env.multiTenant ? 'true' : 'false';
  process.env.DATABASE_URL = 'postgres://example.invalid/toss';
  const backend = await import('../../src/templates/vercel/api/index.ts');
  backend.setVercelSqlForTests(sql);
  return backend.default;
}

function taggedSql(handler: (text: string, values: unknown[]) => any) {
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => handler(strings.join('?'), values);
  return sql;
}

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.OWNER_TOKEN;
  delete process.env.MULTI_TENANT;
  delete process.env.DATABASE_URL;
});

describe('Vercel executable comment-label owner routes', () => {
  const current = [
    { key: 'alpha', label: 'Alpha', description: 'A', color: '#111111', enabled: true, position: 1, usageCount: 0 },
    { key: 'beta', label: 'Beta', description: 'B', color: '#222222', enabled: true, position: 2, usageCount: 3 },
    { key: 'gamma', label: 'Gamma', description: 'G', color: '#333333', enabled: false, position: 3, usageCount: 2 },
  ];

  it('computes exact apply categories and validates positions against the merged final count', () => {
    const preview = computeCommentLabelApply(current, [
      { key: 'beta', label: 'Beta updated', description: 'B', color: '#222222', enabled: true, position: 1 },
      { key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: true, position: 3 },
    ]);
    expect(preview).toEqual({
      creates: ['delta'],
      updates: ['beta'],
      reorders: ['beta', 'alpha', 'gamma'],
      unchanged: [],
      result: [
        { ...current[1], label: 'Beta updated', position: 1 },
        { ...current[0], position: 2 },
        { key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: true, position: 3, usageCount: 0 },
        { ...current[2], position: 4 },
      ],
    });
    expect(computeCommentLabelApply(current, [{ key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: true, position: 99 }]).invalidPositionField).toBe('commentLabels[0].position');
  });

  it('computes exact clear deletes, disables, disabled survivors, and contiguous positions', () => {
    expect(computeCommentLabelClear(current)).toEqual({
      deletes: ['alpha'],
      disables: ['beta'],
      result: [
        { ...current[1], enabled: false, position: 1 },
        { ...current[2], enabled: false, position: 2 },
      ],
    });
  });

  it('fails closed for an empty owner secret and empty bearer with private JSON', async () => {
    const sql = taggedSql(() => { throw new Error('database must not be called'); });
    const handler = await loadHandler({ owner: '' }, sql);
    for (const authorization of [undefined, 'Bearer ']) {
      const response = await handler(new Request('https://toss.test/comment-labels', { headers: authorization ? { authorization } : {} }));
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({ error: 'unauthorized' });
    }
  });

  it('returns structured private JSON when an authenticated member is not an owner', async () => {
    const sql = taggedSql((text) => text.includes('FROM users') ? [{ is_admin: 0, label: 'member' }] : []);
    const handler = await loadHandler({ owner: 'owner-secret', multiTenant: true }, sql);
    const response = await handler(new Request('https://toss.test/comment-labels', { headers: { authorization: 'Bearer member-secret' } }));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    await expect(response.json()).resolves.toMatchObject({ error: 'forbidden' });
  });

  it('returns the exact create transaction snapshot and revision without a post-commit read', async () => {
    let directReads = 0;
    const sql = taggedSql((text) => {
      if (text.includes('FROM comment_label_registry_state state')) {
        directReads++;
        return [{ revision: 3, key: null }];
      }
      return [];
    });
    sql.transaction = async (builder: (tx: any) => any[]) => {
      const tx = taggedSql((text, values) => ({ text, values }));
      const queries = builder(tx);
      expect(queries).toHaveLength(3);
      return [
        [{ revision: 3 }],
        [{ exists: false, position_valid: true, key: 'review', revision: 4 }],
        [{ revision: 4, key: 'review', label: 'Review', description: 'Feedback', color: '#AABBCC', enabled: true, position: 1, usage_count: 0 }],
      ];
    };
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const response = await handler(new Request('https://toss.test/comment-labels', {
      method: 'POST',
      headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3, commentLabel: { key: 'review', label: 'Review', description: 'Feedback', color: '#aabbcc', enabled: true } }),
    }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ revision: 4, commentLabels: [{ key: 'review', label: 'Review', description: 'Feedback', color: '#AABBCC', enabled: true, position: 1, usageCount: 0 }] });
    expect(directReads).toBe(0);
  });

  it('rejects missing descriptions before registry SQL', async () => {
    const sql = taggedSql(() => { throw new Error('registry SQL must not run'); });
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const response = await handler(new Request('https://toss.test/comment-labels', {
      method: 'POST', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, commentLabel: { key: 'review', label: 'Review', color: '#AABBCC', enabled: true } }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'comment_label_invalid', field: 'commentLabel.description' });
  });

  it('returns an executable stale-revision conflict without retrying the mutation', async () => {
    const sql = taggedSql((text) => text.includes('FROM comment_label_registry_state state') ? [{ revision: 4, key: null }] : []);
    sql.transaction = async (builder: (tx: any) => any[]) => {
      const queries = builder(taggedSql((text, values) => ({ text, values })));
      expect(queries).toHaveLength(3);
      return [[{ revision: 4 }], [{ exists: false, position_valid: true }], [{ revision: 4, key: null }]];
    };
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const response = await handler(new Request('https://toss.test/comment-labels', {
      method: 'POST', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 3, commentLabel: { key: 'review', label: 'Review', description: 'Feedback', color: '#AABBCC', enabled: true } }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'stale_comment_label_registry', expectedRevision: 3, actualRevision: 4 });
  });

  async function staleMutation(path: string, method: string, body: unknown, queryCount = 3) {
    const sql = taggedSql(() => []);
    sql.transaction = async (builder: (tx: any) => any[]) => {
      const queries = builder(taggedSql((text, values) => ({ text, values })));
      expect(queries).toHaveLength(queryCount);
      return [[{ revision: 9 }], [], []];
    };
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    return handler(new Request(`https://toss.test${path}`, {
      method, headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
  }

  it('returns stale patch after deletion as 409 instead of 404', async () => {
    const response = await staleMutation('/comment-labels/deleted', 'PATCH', { expectedRevision: 8, changes: { label: 'Changed' } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'stale_comment_label_registry', actualRevision: 9 });
  });

  it('returns stale delete before not-found or usage classification', async () => {
    const sql = taggedSql(() => []);
    sql.transaction = async (builder: (tx: any) => any[]) => {
      expect(builder(taggedSql((text, values) => ({ text, values })))).toHaveLength(4);
      return [[{ revision: 9 }], [], [], []];
    };
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const response = await handler(new Request('https://toss.test/comment-labels/deleted', {
      method: 'DELETE', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 8 }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'stale_comment_label_registry', actualRevision: 9 });
  });

  it('returns stale reorder after an addition as 409 instead of 400', async () => {
    const response = await staleMutation('/comment-labels/order', 'PUT', { expectedRevision: 8, keys: ['old-only'] });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'stale_comment_label_registry', actualRevision: 9 });
  });

  it('returns stale create position after row changes as 409 before range validation', async () => {
    const response = await staleMutation('/comment-labels', 'POST', { expectedRevision: 8, commentLabel: { key: 'new', label: 'New', description: '', color: '#AABBCC', enabled: true, position: 99 } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'stale_comment_label_registry', actualRevision: 9 });
  });

  it('returns stale apply and clear as 409 before diff or current-state classification', async () => {
    const apply = await staleMutation('/comment-labels/apply', 'POST', { expectedRevision: 8, document: { $schema: 'toss/comment-labels@v1', version: 1, commentLabels: [{ key: 'new', label: 'New', description: '', color: '#AABBCC', enabled: true, position: 99 }] } });
    expect(apply.status).toBe(409);
    await expect(apply.json()).resolves.toMatchObject({ error: 'stale_comment_label_registry', actualRevision: 9 });
    const clear = await staleMutation('/comment-labels/clear', 'POST', { expectedRevision: 8 });
    expect(clear.status).toBe(409);
    await expect(clear.json()).resolves.toMatchObject({ error: 'stale_comment_label_registry', actualRevision: 9 });
  });

  it('returns exact apply and clear dry-run contracts without starting a transaction', async () => {
    const sql = taggedSql((text) => text.includes('FROM comment_label_registry_state state')
      ? current.map((label) => ({ revision: 4, ...label, usage_count: label.usageCount }))
      : []);
    sql.transaction = vi.fn(() => { throw new Error('dry-run must not start a transaction'); });
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const apply = await handler(new Request('https://toss.test/comment-labels/apply?dryRun=1', {
      method: 'POST', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ document: { $schema: 'toss/comment-labels@v1', version: 1, commentLabels: [{ key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: true, position: 2 }] } }),
    }));
    expect(apply.status).toBe(200);
    await expect(apply.json()).resolves.toEqual({
      revision: 4,
      creates: ['delta'],
      updates: [],
      reorders: ['beta', 'gamma'],
      unchanged: ['alpha'],
      result: [current[0], { key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: true, position: 2, usageCount: 0 }, { ...current[1], position: 3 }, { ...current[2], position: 4 }],
    });
    const clear = await handler(new Request('https://toss.test/comment-labels/clear?dryRun=1', { method: 'POST', headers: { authorization: 'Bearer owner-secret' } }));
    expect(clear.status).toBe(200);
    await expect(clear.json()).resolves.toEqual({ revision: 4, ...computeCommentLabelClear(current) });
    expect(sql.transaction).not.toHaveBeenCalled();
  });

  it('rejects position 99 identically for apply preview and current-revision apply', async () => {
    const sql = taggedSql((text) => text.includes('FROM comment_label_registry_state state')
      ? current.map((label) => ({ revision: 4, ...label, usage_count: label.usageCount }))
      : []);
    sql.transaction = async (builder: (tx: any) => any[]) => {
      expect(builder(taggedSql((text, values) => ({ text, values })))).toHaveLength(3);
      return [[{ revision: 4 }], [{ changed: false }], current.map((label) => ({ revision: 4, ...label, usage_count: label.usageCount }))];
    };
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const document = { $schema: 'toss/comment-labels@v1', version: 1, commentLabels: [{ key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: true, position: 99 }] };
    for (const suffix of ['?dryRun=1', '']) {
      const response = await handler(new Request(`https://toss.test/comment-labels/apply${suffix}`, {
        method: 'POST', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' },
        body: JSON.stringify(suffix ? { document } : { expectedRevision: 4, document }),
      }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'comment_label_document_invalid', field: 'commentLabels[0].position' });
    }
  });

  it('keeps apply preview result and actual apply result in parity', async () => {
    const included = [{ key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: true, position: 2 }];
    const computed = computeCommentLabelApply(current, included);
    const sourceRows = current.map((label) => ({ revision: 4, ...label, usage_count: label.usageCount }));
    const finalRows = computed.result.map((label) => ({ revision: 5, ...label, usage_count: label.usageCount }));
    const sql = taggedSql((text) => text.includes('FROM comment_label_registry_state state') ? sourceRows : []);
    sql.transaction = async (builder: (tx: any) => any[]) => {
      const queries = builder(taggedSql((text, values) => ({ text, values })));
      expect(queries).toHaveLength(3);
      expect(queries[1].values.some((value: unknown) => typeof value === 'string' && value.includes('"delta"'))).toBe(true);
      return [[{ revision: 4 }], [{ changed: true, revision: 5 }], finalRows];
    };
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const document = { $schema: 'toss/comment-labels@v1', version: 1, commentLabels: included };
    const previewResponse = await handler(new Request('https://toss.test/comment-labels/apply?dryRun=1', {
      method: 'POST', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' }, body: JSON.stringify({ document }),
    }));
    const preview = await previewResponse.json() as any;
    const actualResponse = await handler(new Request('https://toss.test/comment-labels/apply', {
      method: 'POST', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 4, document }),
    }));
    const actual = await actualResponse.json() as any;
    expect(actual.revision).toBe(5);
    expect(actual.commentLabels).toEqual(preview.result);
  });

  it('keeps clear preview result and actual clear result in parity', async () => {
    const computed = computeCommentLabelClear(current);
    const sourceRows = current.map((label) => ({ revision: 4, ...label, usage_count: label.usageCount }));
    const finalRows = computed.result.map((label) => ({ revision: 5, ...label, usage_count: label.usageCount }));
    const sql = taggedSql((text) => text.includes('FROM comment_label_registry_state state') ? sourceRows : []);
    sql.transaction = async (builder: (tx: any) => any[]) => {
      const queries = builder(taggedSql((text, values) => ({ text, values })));
      expect(queries).toHaveLength(3);
      expect(queries[1].text).toContain('usage AS MATERIALIZED');
      return [[{ revision: 4 }], [{ deletes: 1, changes: 2, revision: 5 }], finalRows];
    };
    const handler = await loadHandler({ owner: 'owner-secret' }, sql);
    const previewResponse = await handler(new Request('https://toss.test/comment-labels/clear?dryRun=1', { method: 'POST', headers: { authorization: 'Bearer owner-secret' } }));
    const preview = await previewResponse.json() as any;
    const actualResponse = await handler(new Request('https://toss.test/comment-labels/clear', {
      method: 'POST', headers: { authorization: 'Bearer owner-secret', 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 4 }),
    }));
    const actual = await actualResponse.json() as any;
    expect(actual.revision).toBe(5);
    expect(actual.commentLabels).toEqual(preview.result);
  });
});
