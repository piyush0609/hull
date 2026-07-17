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
import { commentsCommand } from '../../src/commands/comments.js';
import { versionsCommand } from '../../src/commands/versions.js';
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

describe('versions + comments --version', () => {
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

  // Hex, no dash, no g-z letters => the command skips slug→id resolution (no list() call).
  const HEXID = 'abc12345';
  const ownerCfg = { endpoint: 'https://example.com', token: 'owner-token', subdomain: 'team', role: 'owner' } as any;

  it('versions exits when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(versionsCommand(HEXID)).rejects.toThrow('process.exit(1)');
  });

  it('versions lists seq, count, and the current marker, hitting /versions', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(ownerCfg);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ artifactId: HEXID, versions: [
        { seq: 2, content_hash: 'a1b2c3d4ee', created_at: 1700000000, comment_count: 3, is_current: true },
        { seq: 1, content_hash: '0011223344', created_at: 1699000000, comment_count: 1, is_current: false },
      ] }),
    } as Response);
    await versionsCommand(HEXID, {});
    const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('SEQ');
    expect(out).toContain('a1b2c3d4');
    expect(out).toMatch(/\(current\)/);
    expect(String((global.fetch as any).mock.calls[0][0])).toContain(`/artifacts/${HEXID}/versions`);
  });

  it('versions --json emits structured data', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(ownerCfg);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ artifactId: HEXID, versions: [{ seq: 1, content_hash: 'x', created_at: 1, comment_count: 0, is_current: true }] }),
    } as Response);
    await versionsCommand(HEXID, { json: true });
    const parsed = JSON.parse(consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n'));
    expect(parsed.versions[0].seq).toBe(1);
    expect(parsed.versions[0].is_current).toBe(true);
  });

  it('comments --version pins the read to that version seq', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(ownerCfg);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 2, threads: [], activityThreads: [] }),
    } as Response);
    await commentsCommand(HEXID, undefined, { seq: '2' });
    expect(String((global.fetch as any).mock.calls[0][0])).toContain('version=2');
    const out = consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain(`No comments on ${HEXID} version 2.`);
  });

  it('comments rejects a non-integer --version before calling the API', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(ownerCfg);
    global.fetch = vi.fn();
    await expect(commentsCommand(HEXID, undefined, { seq: 'abc' })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--seq must be a positive integer'));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('comments feedback kinds, filters, and checks', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  const HEXID = 'abc12345';
  const ownerCfg = { endpoint: 'https://example.com', token: 'owner-token', subdomain: 'team', role: 'owner' } as any;
  const threads = [
    {
      id: 'open-thread', status: 'open', scope_type: 'artifact', page_path: 'index.html', messages: [
        { id: 'blocker', kind: 'blocker', author_label: 'Alice', body: 'Must fix', created_at: 1700000000 },
        { id: 'note', kind: 'note', author_label: 'Bob', body: 'For context', created_at: 1700000001 },
        { id: 'legacy', body: 'Old comment', created_at: 1700000002 },
        { id: 'concern', kind: 'concern', author_label: 'Cara', body: 'Risky', created_at: 1700000003 },
        { id: 'question', kind: 'question', author_label: 'Dan', body: 'Why?', created_at: 1700000004 },
        { id: 'action', kind: 'action', author_label: 'Eli', body: 'Follow up', created_at: 1700000005 },
        { id: 'nit', kind: 'nit', author_label: 'Fran', body: 'Small polish', created_at: 1700000006 },
      ],
    },
    {
      id: 'resolved-thread', status: 'resolved', scope_type: 'artifact', page_path: 'index.html', messages: [
        { id: 'resolution', kind: 'resolution', author_label: '', body: 'Fixed', created_at: 1700000003 },
        { id: 'deleted-blocker', kind: 'blocker', author_label: 'Eve', body: 'Gone', created_at: 1700000004, deleted_at: 1700000005 },
      ],
    },
  ];

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    process.exitCode = undefined;
    vi.spyOn(config, 'loadConfig').mockResolvedValue(ownerCfg);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ threads, activityThreads: threads }),
    } as Response);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('labels attributed kinds, omits NOTE, and never prints anon for legacy authors', async () => {
    await commentsCommand(HEXID, undefined);
    const out = consoleLogSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(out).toContain('[BLOCKER] Alice');
    expect(out).toContain('[CONCERN] Cara');
    expect(out).toContain('[QUESTION] Dan');
    expect(out).toContain('[ACTION] Eli');
    expect(out).toContain('[NIT] Fran');
    expect(out).toContain('[RESOLUTION] <unknown author>');
    expect(out).not.toContain('[NOTE]');
    expect(out).not.toContain('anon');
  });

  it('applies type and status filters to JSON without changing retained messages', async () => {
    await commentsCommand(HEXID, undefined, { type: 'resolution', status: 'resolved', json: true });
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].id).toBe('resolved-thread');
    expect(parsed.threads[0].messages).toEqual([threads[1].messages[0]]);
  });

  it('treats legacy messages without a kind as notes when filtering', async () => {
    await commentsCommand(HEXID, undefined, { type: 'note', json: true });
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.threads[0].messages.map((message: any) => message.id)).toEqual(['note', 'legacy']);
  });

  it('excludes a thread whose only matching blocker message is deleted', async () => {
    const deletedOnlyThreads = [{
      id: 'deleted-only', status: 'open', scope_type: 'artifact', page_path: 'index.html', messages: [
        { id: 'deleted-blocker', kind: 'blocker', author_label: 'Eve', body: 'Gone', created_at: 1700000004, deleted_at: 1700000005 },
      ],
    }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ threads: deletedOnlyThreads, activityThreads: deletedOnlyThreads }),
    } as Response);

    await commentsCommand(HEXID, undefined, { type: 'blocker', json: true });
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.threads).toEqual([]);
  });

  it('rejects invalid type and status values with accepted values in the error', async () => {
    await expect(commentsCommand(HEXID, undefined, { type: 'urgent' })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('note, blocker, concern, question, action, nit, resolution'));

    await expect(commentsCommand(HEXID, undefined, { status: 'closed' })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('open, resolved'));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checks all unfiltered threads and sets exitCode for an unresolved blocker', async () => {
    await commentsCommand(HEXID, undefined, { type: 'resolution', status: 'resolved', check: true, json: true });
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Check failed: 1 unresolved blocker thread(s).');
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.threads[0].id).toBe('resolved-thread');
  });

  it('passes check when blockers are resolved or deleted', async () => {
    const safeThreads = [
      { ...threads[0], messages: threads[0].messages.filter((message) => message.kind !== 'blocker') },
      threads[1],
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ threads: safeThreads, activityThreads: safeThreads }),
    } as Response);

    await commentsCommand(HEXID, undefined, { check: true });
    expect(process.exitCode).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Check passed: no unresolved blocker threads.');
  });

  it('passes check when an open thread\'s only blocker is deleted', async () => {
    const deletedOnlyThreads = [{
      id: 'deleted-only', status: 'open', scope_type: 'artifact', page_path: 'index.html', messages: [
        { id: 'deleted-blocker', kind: 'blocker', author_label: 'Eve', body: 'Gone', created_at: 1700000004, deleted_at: 1700000005 },
      ],
    }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ threads: deletedOnlyThreads, activityThreads: deletedOnlyThreads }),
    } as Response);

    await commentsCommand(HEXID, undefined, { check: true });
    expect(process.exitCode).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledWith('Check passed: no unresolved blocker threads.');
  });
});
