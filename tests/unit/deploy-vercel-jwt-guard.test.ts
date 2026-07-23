import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Command-level coverage for the deploy-time JWT_SECRET strength guard on the
// Vercel backend. deployVercelCommand shells out via promisify(exec) + spawn, so
// the whole child_process module is mocked; no vercel binary is invoked.
const vState = vi.hoisted(() => ({
  execCalls: [] as string[],
  envAdds: [] as string[],
  jwtOnProject: false,
  ownerOnProject: false,
  deployReached: false,
}));

vi.mock('child_process', () => ({
  exec: (...args: any[]) => {
    const cmd = String(args[0]);
    const cb = args[args.length - 1];
    vState.execCalls.push(cmd);
    if (cmd.includes('vercel deploy --prod')) vState.deployReached = true;
    let stdout = '';
    if (cmd.includes('vercel --version')) stdout = '56.2.0';
    else if (cmd.includes('vercel whoami')) stdout = 'test-user';
    else if (cmd.includes('vercel env ls')) {
      const names: string[] = [];
      if (vState.jwtOnProject) names.push('JWT_SECRET');
      if (vState.ownerOnProject) names.push('OWNER_TOKEN');
      stdout = names.join('\n');
    } else if (cmd.includes('vercel deploy --prod')) {
      stdout = 'Production: https://toss-test-abc-acme.vercel.app [10s]';
    }
    if (typeof cb === 'function') cb(null, { stdout, stderr: '' });
  },
  spawn: (_cmd: string, spawnArgs: string[] = []) => {
    const handlers: Record<string, Array<(...a: any[]) => void>> = {};
    const proc: any = {
      stdin: { write: () => {}, end: () => {} },
      stderr: { on: () => {} },
      on: (ev: string, cb: (...a: any[]) => void) => { (handlers[ev] ||= []).push(cb); return proc; },
    };
    vState.envAdds.push(Array.isArray(spawnArgs) ? spawnArgs.join(' ') : '');
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
  // project.json read fails (no projectId) → skips SSO fetch; other reads empty.
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
}));

import { deployVercelCommand } from '../../src/commands/deploy-vercel.js';
import * as fsp from 'fs/promises';
import * as config from '../../src/lib/config.js';

describe('deployVercelCommand — fail closed on weak JWT_SECRET (Vercel)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
    vi.spyOn(config, 'saveConfig').mockResolvedValue(undefined);
    vState.execCalls = [];
    vState.envAdds = [];
    vState.jwtOnProject = false;
    vState.ownerOnProject = false;
    vState.deployReached = false;
    // restoreAllMocks() clears fs/promises mock return values between tests.
    (fsp.readdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (fsp.mkdir as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.rm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.writeFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.copyFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (fsp.readFile as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockProfile(over: Partial<config.TossConfig> = {}) {
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      endpoint: 'https://old.example.com',
      token: 'owner-token',
      subdomain: 'toss',
      role: 'owner',
      backend: 'vercel',
      ...over,
    } as never);
  }

  it('validates a reused local secret (known:true, write:false) and aborts before `vercel deploy`', async () => {
    // Secret already on the project → resolveSecret returns known:true, write:false.
    vState.jwtOnProject = true;
    mockProfile({ jwtSecret: 'weak-secret' });

    await expect(
      deployVercelCommand({ profile: 'default', multiTenant: false, subdomain: 'toss', yes: true, postgresUrl: 'postgres://h/db' })
    ).rejects.toThrow(/at least 32 bytes/);

    // Never reached the deploy, never wrote the weak JWT_SECRET.
    expect(vState.deployReached).toBe(false);
    expect(vState.envAdds.some((a) => a.includes('JWT_SECRET'))).toBe(false);
  });

  it('does NOT write a weak first-deploy local secret (known:true, write:true)', async () => {
    vState.jwtOnProject = false;
    mockProfile({ jwtSecret: 'short' });

    await expect(
      deployVercelCommand({ profile: 'default', multiTenant: false, subdomain: 'toss', yes: true, postgresUrl: 'postgres://h/db' })
    ).rejects.toThrow(/at least 32 bytes/);

    expect(vState.envAdds.some((a) => a.includes('JWT_SECRET'))).toBe(false);
  });
});
