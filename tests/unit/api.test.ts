import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TossAPI } from '../../src/lib/api.js';

const TEST_CONFIG = {
  endpoint: 'https://toss-test.workers.dev',
  token: 'deadbeef0123456789abcdef01234567',
  subdomain: 'test',
};

describe('TossAPI', () => {
  let api: TossAPI;

  beforeEach(() => {
    api = new TossAPI(TEST_CONFIG);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should upload HTML and return share data', async () => {
    const mockResponse = { id: 'abc123', url: 'https://toss-test.workers.dev/a/abc123?t=xyz' };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const html = Buffer.from('<html>test</html>');
    const result = await api.upload(html, 'test.html', 3600);

    expect(result).toEqual(mockResponse);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${TEST_CONFIG.token}`,
        }),
        body: expect.any(Uint8Array),
      })
    );
  });

  it('should throw on upload failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad Request',
    } as Response);

    const html = Buffer.from('<html>test</html>');
    await expect(api.upload(html, 'test.html', 3600)).rejects.toThrow('Upload failed: 400 Bad Request');
  });

  it('should list artifacts', async () => {
    const mockArtifacts = [
      { id: 'abc123', name: 'test.html', size_bytes: 100, created_at: 1700000000, expires_at: 1700003600 },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockArtifacts,
    } as Response);

    const result = await api.list();
    expect(result).toEqual(mockArtifacts);
    expect(fetch).toHaveBeenCalledWith(
      'https://toss-test.workers.dev/artifacts',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${TEST_CONFIG.token}` },
      })
    );
  });

  it('should revoke artifact', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
    } as Response);

    await api.revoke('abc123');
    expect(fetch).toHaveBeenCalledWith(
      'https://toss-test.workers.dev/artifacts/abc123',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TEST_CONFIG.token}` },
      })
    );
  });

  it('should set ?comments=1 on upload when comments enabled', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await api.upload(Buffer.from('<html>x</html>'), 'x.html', 3600, undefined, undefined, true);
    const calledUrl = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).toContain('comments=1');
  });

  it('should NOT set the comments param by default', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await api.upload(Buffer.from('<html>x</html>'), 'x.html', 3600);
    const calledUrl = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('comments');
  });

  it('should set ?total_bytes when a folder total is passed (so list shows the whole folder)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await api.upload(Buffer.from('<html>x</html>'), 'folder', 3600, undefined, undefined, undefined, undefined, 182400);
    const calledUrl = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).toContain('total_bytes=182400');
  });

  it('should NOT set total_bytes for a single-file share (server falls back to body length)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    await api.upload(Buffer.from('<html>x</html>'), 'x.html', 3600);
    const calledUrl = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('total_bytes');
  });

  it('setComments PATCHes the per-share toggle route', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);
    await api.setComments('abc123', true);
    expect(fetch).toHaveBeenCalledWith(
      'https://toss-test.workers.dev/artifacts/abc123/comments',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ Authorization: `Bearer ${TEST_CONFIG.token}` }),
        body: JSON.stringify({ enabled: true }),
      })
    );
  });

  it('lists comment labels from /comment-labels and normalizes the label envelope', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ commentLabelRevision: 3, commentLabels: [{ key: 'risk' }] }),
    } as Response);
    await expect(api.getCommentLabels()).resolves.toEqual({ revision: 3, labels: [{ key: 'risk' }] });
    expect(fetch).toHaveBeenCalledWith('https://toss-test.workers.dev/comment-labels', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${TEST_CONFIG.token}` }),
    }));
  });

  it('sends expectedRevision on every focused comment-label mutation', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"commentLabelRevision":8,"commentLabels":[]}' } as Response);
    const label = { key: 'risk', label: 'Risk', description: '', color: '#AABBCC', enabled: true };
    await api.createCommentLabel(7, label);
    await api.updateCommentLabel('risk', 8, { enabled: false });
    await api.deleteCommentLabel('risk', 9);
    await api.reorderCommentLabels(10, ['question', 'risk']);
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://toss-test.workers.dev/comment-labels', expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 7, commentLabel: label }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://toss-test.workers.dev/comment-labels/risk', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ expectedRevision: 8, changes: { enabled: false } }) }));
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://toss-test.workers.dev/comment-labels/risk', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ expectedRevision: 9 }) }));
    expect(fetch).toHaveBeenNthCalledWith(4, 'https://toss-test.workers.dev/comment-labels/order', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ expectedRevision: 10, keys: ['question', 'risk'] }) }));
  });

  it('previews then revision-binds apply and clear', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"commentLabelRevision":4,"commentLabels":[]}' } as Response);
    const document = { $schema: 'toss/comment-labels@v1' as const, version: 1 as const, commentLabels: [] };
    await api.previewCommentLabelApply(document);
    await api.applyCommentLabels(4, document);
    await api.previewCommentLabelClear();
    await api.clearCommentLabels(5);
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://toss-test.workers.dev/comment-labels/apply?dryRun=1', expect.objectContaining({ body: JSON.stringify({ document }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://toss-test.workers.dev/comment-labels/apply', expect.objectContaining({ body: JSON.stringify({ expectedRevision: 4, document }) }));
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://toss-test.workers.dev/comment-labels/clear?dryRun=1', expect.objectContaining({ method: 'POST' }));
    expect(fetch).toHaveBeenNthCalledWith(4, 'https://toss-test.workers.dev/comment-labels/clear', expect.objectContaining({ body: JSON.stringify({ expectedRevision: 5 }) }));
  });

  it('retains structured comment-label API errors and rejects malformed success JSON', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 409, text: async () => JSON.stringify({ error: 'stale_comment_label_registry', hint: 'Read again.' }),
    } as Response).mockResolvedValueOnce({ ok: true, status: 200, text: async () => 'not json' } as Response);
    await expect(api.getCommentLabels()).rejects.toMatchObject({ status: 409, details: { error: 'stale_comment_label_registry', hint: 'Read again.' } });
    await expect(api.getCommentLabels()).rejects.toThrow('returned invalid JSON');
  });
});
