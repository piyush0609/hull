import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared, mutable state driving the mocked child_process for the Cloudflare
// deploy tests below. Declared via vi.hoisted so the vi.mock factory (hoisted
// above the imports) can close over it.
const cfState = vi.hoisted(() => ({
  execCalls: [] as string[],
  secretPuts: [] as string[],
  jwtExistsOnBackend: false,
  ownerExistsOnBackend: false,
}));

// deployCommand shells out via promisify(exec) and spawn; mock the whole module
// so no wrangler binary is invoked. The other commands in this file exit before
// touching child_process, so this is inert for them.
vi.mock('child_process', () => ({
  exec: (...args: any[]) => {
    const cmd = String(args[0]);
    const cb = args[args.length - 1];
    cfState.execCalls.push(cmd);
    let stdout = '';
    if (cmd.includes('kv namespace create')) stdout = '{"id":"0123456789abcdef0123456789abcdef"}';
    else if (cmd.includes('d1 create')) stdout = '{"database_id":"11111111-2222-3333-4444-555555555555"}';
    else if (cmd.includes('secret list')) {
      const names: string[] = [];
      if (cfState.jwtExistsOnBackend) names.push('"JWT_SECRET"');
      if (cfState.ownerExistsOnBackend) names.push('"OWNER_TOKEN"');
      stdout = names.join('\n');
    }
    if (typeof cb === 'function') cb(null, { stdout, stderr: '' });
  },
  spawn: (_cmd: string, spawnArgs: string[] = []) => {
    const handlers: Record<string, Array<(...a: any[]) => void>> = {};
    const proc: any = {
      stdin: { write: () => {}, end: () => {} },
      on: (ev: string, cb: (...a: any[]) => void) => { (handlers[ev] ||= []).push(cb); return proc; },
    };
    cfState.secretPuts.push(Array.isArray(spawnArgs) ? spawnArgs.join(' ') : '');
    setImmediate(() => (handlers['exit'] || []).forEach((cb) => cb(0)));
    return proc;
  },
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  copyFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  chmod: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => false, size: 0 }),
  lstat: vi.fn().mockResolvedValue({ isDirectory: () => false, size: 0 }),
}));

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
import { deployCommand } from '../../src/commands/deploy.js';
import * as fsp from 'fs/promises';
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

describe('dynamic comment labels and filters', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  const HEXID = 'abc12345';
  const ownerCfg = { endpoint: 'https://example.com', token: 'owner-token', subdomain: 'team', role: 'owner' } as any;
  const threads = [
    {
      id: 'open-thread', status: 'open', scope_type: 'artifact', page_path: 'index.html', messages: [
        { id: 'risk', kind: 'release-risk', author_label: 'Alice', body: 'Must fix', created_at: 1700000000 },
        { id: 'unlabeled', kind: null, author_label: 'Bob', body: 'For context', created_at: 1700000001 },
        { id: 'omitted', author_label: 'Cara', body: 'Old comment', created_at: 1700000002 },
      ],
    },
    {
      id: 'resolved-thread', status: 'resolved', scope_type: 'artifact', page_path: 'index.html', messages: [
        { id: 'resolution', kind: 'resolution', author_label: '', body: 'Fixed', created_at: 1700000003 },
        { id: 'deleted-risk', kind: 'release-risk', author_label: 'Eve', body: 'Gone', created_at: 1700000004, deleted_at: 1700000005 },
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
      json: async () => ({
        artifactId: HEXID,
        viewer: { role: 'owner' },
        pagePath: 'index.html',
        commentLabelRevision: 7,
        commentLabels: [{ key: 'release-risk', label: 'Release risk', description: '', color: '#D97706', enabled: false, position: 1 }],
        threads,
        activityThreads: threads,
        futureField: 'preserved',
      }),
    } as Response);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('uses configured human labels, leaves unlabeled comments unbadged, and preserves resolution', async () => {
    await commentsCommand(HEXID, undefined);
    const out = consoleLogSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(out).toContain('[Release risk] Alice');
    expect(out).toContain('Bob');
    expect(out).not.toContain('[null]');
    expect(out).toContain('[Resolution] <unknown author>');
    expect(out).not.toContain('anon');
  });

  it('filters both thread arrays while preserving the complete JSON envelope and raw nullable kinds', async () => {
    await commentsCommand(HEXID, undefined, { label: 'release-risk', status: 'open', json: true });
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.futureField).toBe('preserved');
    expect(parsed.viewer).toEqual({ role: 'owner' });
    expect(parsed.commentLabelRevision).toBe(7);
    expect(parsed.commentLabels[0].enabled).toBe(false);
    expect(parsed.threads).toHaveLength(1);
    expect(parsed.activityThreads).toHaveLength(1);
    expect(parsed.threads[0].messages).toEqual([threads[0].messages[0]]);
  });

  it('filters explicit null and omitted kinds with --unlabeled', async () => {
    await commentsCommand(HEXID, undefined, { unlabeled: true, json: true });
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.threads[0].messages.map((message: any) => message.id)).toEqual(['unlabeled', 'omitted']);
    expect(parsed.threads[0].messages[0].kind).toBeNull();
  });

  it('excludes deleted matches', async () => {
    const deletedOnlyThreads = [{
      id: 'deleted-only', status: 'open', scope_type: 'artifact', page_path: 'index.html', messages: [
        { id: 'deleted-risk', kind: 'release-risk', author_label: 'Eve', body: 'Gone', created_at: 1700000004, deleted_at: 1700000005 },
      ],
    }];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commentLabels: [{ key: 'release-risk', label: 'Risk' }], threads: deletedOnlyThreads, activityThreads: deletedOnlyThreads }),
    } as Response);

    await commentsCommand(HEXID, undefined, { label: 'release-risk', json: true });
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.threads).toEqual([]);
  });

  it('validates labels dynamically and rejects incompatible filters', async () => {
    await expect(commentsCommand(HEXID, undefined, { label: 'urgent' })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('release-risk, resolution'));

    await expect(commentsCommand(HEXID, undefined, { status: 'closed' })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('open, resolved'));
    await expect(commentsCommand(HEXID, undefined, { label: 'release-risk', unlabeled: true })).rejects.toThrow('process.exit(1)');
  });

  it('supports metadata-absent Cloudflare envelopes using exact raw keys', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ threads, activityThreads: threads, cloudflareField: true }) } as Response);
    await commentsCommand(HEXID, undefined, { label: 'release-risk', json: true });
    const parsed = JSON.parse(String(consoleLogSpy.mock.calls[0][0]));
    expect(parsed.cloudflareField).toBe(true);
    expect(parsed.threads).toHaveLength(1);
  });
});

describe('deployCommand — fail closed on weak JWT_SECRET (Cloudflare)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  const ACCOUNT_ID = 'abcdef0123456789abcdef0123456789';

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    cfState.execCalls = [];
    cfState.secretPuts = [];
    cfState.jwtExistsOnBackend = false;
    cfState.ownerExistsOnBackend = false;
    // vi.restoreAllMocks() in sibling suites clears the fs/promises mock return
    // values, so re-seed the ones deployCommand relies on.
    (fsp.readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (fsp.mkdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.rm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.writeFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.copyFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('');
    vi.spyOn(config, 'saveConfig').mockResolvedValue(undefined);
    // apiToken present → deploy uses the fetch-based subdomain lookup (no wrangler
    // whoami), which we stub below.
    global.fetch = vi.fn().mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('/tokens/verify')) return { json: async () => ({ success: true }) } as Response;
      if (u.includes('/workers/subdomain')) {
        return { json: async () => ({ success: true, result: { subdomain: 'testsub' } }) } as Response;
      }
      return { json: async () => ({ success: true, result: [] }) } as Response;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockProfile(over: Partial<config.TossConfig> = {}) {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://old.example.com',
      token: 'owner-token',
      subdomain: 'testsub',
      role: 'owner',
      backend: 'cloudflare',
      apiToken: 'cf-api-token',
      accountId: ACCOUNT_ID,
      ...over,
    } as never);
  }

  it('aborts BEFORE `wrangler deploy` when a reused local secret (write:false) is weak', async () => {
    // Secret already on the worker → resolveSecret returns known:true, write:false.
    cfState.jwtExistsOnBackend = true;
    mockProfile({ jwtSecret: 'too-short' });

    await expect(deployCommand({ profile: 'default', multiTenant: false, subdomain: 'testsub' }))
      .rejects.toThrow('process.exit(1)');

    // The deploy must not have been spawned before validation failed.
    expect(cfState.execCalls).not.toContain('wrangler deploy');
    expect(cfState.secretPuts.some((a) => a.includes('JWT_SECRET'))).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to resolve secrets:',
      expect.stringContaining('at least 32 bytes')
    );
  });

  it('aborts BEFORE `wrangler deploy` when a first-deploy weak local secret (write:true) is set', async () => {
    // Not on backend + weak local value → known:true, write:true.
    cfState.jwtExistsOnBackend = false;
    mockProfile({ jwtSecret: 'short-weak-secret' });

    await expect(deployCommand({ profile: 'default', multiTenant: false, subdomain: 'testsub' }))
      .rejects.toThrow('process.exit(1)');

    expect(cfState.execCalls).not.toContain('wrangler deploy');
  });

  it('deploys on the auto-generated-secret happy path (no local secret, none on backend)', async () => {
    // No local jwtSecret and none on backend → resolveSecret generates a 64-hex
    // value (32 bytes) that passes assertStrongJwtSecret.
    cfState.jwtExistsOnBackend = false;
    mockProfile({ jwtSecret: undefined });

    await deployCommand({ profile: 'default', multiTenant: false, subdomain: 'testsub' });

    expect(cfState.execCalls).toContain('wrangler deploy');
    // A generated JWT_SECRET (write:true) was pushed after the deploy.
    expect(cfState.secretPuts.some((a) => a.includes('JWT_SECRET'))).toBe(true);
    expect(config.saveConfig).toHaveBeenCalled();
  });
});
