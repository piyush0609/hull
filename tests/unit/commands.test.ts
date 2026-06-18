import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareCommand } from '../../src/commands/share.js';
import { listCommand } from '../../src/commands/list.js';
import { revokeCommand } from '../../src/commands/revoke.js';
import { destroyCommand } from '../../src/commands/destroy.js';
import { tokenListCommand } from '../../src/commands/token.js';
import { membersListCommand } from '../../src/commands/members.js';
import { cleanupCommand } from '../../src/commands/cleanup.js';
import { infoCommand } from '../../src/commands/info.js';
import { whoamiCommand } from '../../src/commands/whoami.js';
import * as config from '../../src/lib/config.js';

describe('CLI Commands', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('share should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(shareCommand('test.html', { expires: '24h' })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
  });

  it('list should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(listCommand()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
  });

  it('list shows permanent shares (expires_at 0) as "never", not EXPIRED', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'owner-token',
      subdomain: 'team',
      role: 'owner',
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'perm-1', slug: 'forever', name: 'doc.html', size_bytes: 100, created_at: 1, expires_at: 0 },
      ],
    } as Response);

    await listCommand();

    const row = consoleLogSpy.mock.calls.map((c) => String(c[0])).find((r) => r.includes('forever'));
    expect(row).toBeDefined();
    expect(row).toContain('never');
    expect(row).not.toContain('EXPIRED');
  });

  it('revoke should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(revokeCommand('abc123')).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
  });

  it('destroy should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(destroyCommand()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss found. Nothing to destroy.');
  });

  it('admin token list should reject member profiles locally', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'member-token',
      subdomain: 'team',
      role: 'member',
    });
    await expect(tokenListCommand()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: This profile is a member profile and cannot run admin token commands.');
  });

  it('admin members should reject member profiles locally', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'member-token',
      subdomain: 'team',
      role: 'member',
    });
    await expect(membersListCommand()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: This profile is a member profile and cannot run owner-only commands.');
  });

  it('admin cleanup should reject member profiles locally', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'member-token',
      subdomain: 'team',
      role: 'member',
    });
    await expect(cleanupCommand({ yes: true })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: This profile is a member profile and cannot run owner-only commands.');
  });

  it('info should show the explicitly requested profile name', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'owner-token',
      subdomain: 'team',
      role: 'owner',
    });
    vi.spyOn(config, 'getActiveProfile').mockResolvedValue('default');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    await infoCommand({ profile: 'member-a' });

    expect(consoleLogSpy).toHaveBeenCalledWith('Profile:   member-a');
    expect(consoleLogSpy).toHaveBeenCalledWith('Active:    default');
  });

  it('whoami should show the explicitly requested profile name', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'member-token',
      subdomain: 'team',
      role: 'member',
      backend: 'vercel',
    });
    vi.spyOn(config, 'getActiveProfile').mockResolvedValue('default');
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    await whoamiCommand({ profile: 'member-a' });

    expect(consoleLogSpy).toHaveBeenCalledWith('Profile:   member-a');
    expect(consoleLogSpy).toHaveBeenCalledWith('Active:    default');
    expect(consoleLogSpy).toHaveBeenCalledWith('Role:      member');
  });

  it('admin members should print owner and member rows', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'owner-token',
      subdomain: 'team',
      role: 'owner',
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { token_hash: 'a'.repeat(64), label: 'admin', created_at: 1700000000, is_admin: 1 },
        { token_hash: 'b'.repeat(64), label: 'alice', created_at: 1700003600, is_admin: 0 },
      ],
    } as Response);

    await membersListCommand();

    expect(consoleLogSpy).toHaveBeenCalledWith('MEMBER               ROLE    TOKEN (first 16)    CREATED');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('admin'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('owner'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('alice'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('member'));
  });

  it('admin cleanup should delete expired artifacts only', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'owner-token',
      subdomain: 'team',
      role: 'owner',
    });

    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: 'expired-1', slug: 'expired-one', name: 'old.html', size_bytes: 1, created_at: 1, expires_at: Math.floor(Date.now() / 1000) - 10 },
          { id: 'fresh-1', slug: 'fresh-one', name: 'new.html', size_bytes: 1, created_at: 1, expires_at: Math.floor(Date.now() / 1000) + 3600 },
        ],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
      } as Response);

    await cleanupCommand({ yes: true });

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.com/artifacts/expired-1',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner-token' },
      })
    );
    expect(consoleLogSpy).toHaveBeenCalledWith('Deleted 1 expired artifact(s).');
  });

  it('admin cleanup should report when there is nothing to delete', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://example.com',
      token: 'owner-token',
      subdomain: 'team',
      role: 'owner',
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 'fresh-1', slug: 'fresh-one', name: 'new.html', size_bytes: 1, created_at: 1, expires_at: Math.floor(Date.now() / 1000) + 3600 },
      ],
    } as Response);

    await cleanupCommand({ yes: true });

    expect(consoleLogSpy).toHaveBeenCalledWith('No expired artifacts found.');
  });
});
