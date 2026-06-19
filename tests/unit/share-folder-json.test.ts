import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// API + filesystem are mocked so the folder-share path runs with no network/disk.
const { uploadMock, uploadFileMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  uploadFileMock: vi.fn(),
}));

vi.mock('../../src/lib/api.js', () => ({
  TossAPI: vi.fn(() => ({ upload: uploadMock, uploadFile: uploadFileMock })),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readdir: vi.fn(),
  lstat: vi.fn(),
  readFile: vi.fn(),
}));

import { shareCommand } from '../../src/commands/share.js';
import * as config from '../../src/lib/config.js';
import * as fsp from 'fs/promises';

describe('folder share --json output', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'owner-token',
      subdomain: 'team',
    } as never);

    // A folder ('site') containing index.html + app.js.
    (fsp.stat as never as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => (
      p === 'site' ? { isDirectory: () => true, size: 0 } : { isDirectory: () => false, size: 10 }
    ));
    (fsp.readdir as never as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'index.html', isDirectory: () => false },
      { name: 'app.js', isDirectory: () => false },
    ]);
    (fsp.lstat as never as ReturnType<typeof vi.fn>).mockResolvedValue({ isSymbolicLink: () => false });
    (fsp.readFile as never as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('<html></html>'));

    uploadMock.mockResolvedValue({ id: 'abc', slug: 'site', url: 'https://example.com/s/site', legacyUrl: '' });
    uploadFileMock.mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  // Regression: folder shares print "Uploading N additional files..." while
  // uploading the non-entry files. That progress must NOT land on stdout, or
  // `toss share <folder> --json | <parser>` breaks (JSON has a junk first line).
  it('emits a single clean JSON object on stdout; progress goes to stderr', async () => {
    await shareCommand('site', { json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const stdout = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(stdout); // throws if stdout is polluted
    expect(parsed.slug).toBe('site');

    // the multi-file folder share did emit the progress line — to stderr
    expect(uploadFileMock).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Uploading'));
  });
});
