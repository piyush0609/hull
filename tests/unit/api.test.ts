import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TossAPI } from '../../src/lib/api.js';

const TEST_CONFIG = {
  endpoint: 'https://toss-test.workers.dev',
  ownerToken: 'deadbeef0123456789abcdef01234567',
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
          Authorization: `Bearer ${TEST_CONFIG.ownerToken}`,
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
        headers: { Authorization: `Bearer ${TEST_CONFIG.ownerToken}` },
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
        headers: { Authorization: `Bearer ${TEST_CONFIG.ownerToken}` },
      })
    );
  });
});
