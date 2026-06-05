import { describe, it, expect } from 'vitest';
import { retryAsync, buildVercelEnvAddArgs } from '../../src/commands/deploy-vercel.js';

describe('retryAsync', () => {
  it('returns the result without retrying when the first attempt succeeds', async () => {
    let calls = 0;
    const result = await retryAsync(async () => { calls++; return 'ok'; }, { attempts: 3, delayMs: 0 });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on failure and resolves once an attempt succeeds', async () => {
    let calls = 0;
    const result = await retryAsync(async () => {
      calls++;
      if (calls < 3) throw new Error('fetch failed');
      return 'recovered';
    }, { attempts: 5, delayMs: 0 });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws the last error after exhausting all attempts', async () => {
    let calls = 0;
    await expect(
      retryAsync(async () => { calls++; throw new Error(`boom ${calls}`); }, { attempts: 3, delayMs: 0 })
    ).rejects.toThrow('boom 3');
    expect(calls).toBe(3);
  });
});

describe('buildVercelEnvAddArgs', () => {
  it('passes the value as a discrete argv element so the shell never parses it', () => {
    // A Neon URL is full of shell metacharacters ($ ? & @). As a discrete argv
    // element it needs no quoting and cannot be injected or corrupted.
    const value = 'postgres://u:p$$@host/db?sslmode=require&x=1';
    const args = buildVercelEnvAddArgs('DATABASE_URL', 'production', value);
    const valueIdx = args.indexOf('--value');
    expect(valueIdx).toBeGreaterThan(-1);
    expect(args[valueIdx + 1]).toBe(value);
  });

  it('marks the variable non-sensitive so `vercel env pull` can read it back (CLI 52+ regression)', () => {
    const args = buildVercelEnvAddArgs('JWT_SECRET', 'production', 'abc');
    expect(args).toContain('--no-sensitive');
  });

  it('overwrites in place and runs non-interactively (no separate rm, no stdin prompt)', () => {
    const args = buildVercelEnvAddArgs('OWNER_TOKEN', 'production', 'abc');
    expect(args).toContain('--force');
    expect(args).toContain('--yes');
    expect(args).toContain('--non-interactive'); // without this, `env add` hangs on a prompt under spawn
    expect(args.slice(0, 4)).toEqual(['env', 'add', 'OWNER_TOKEN', 'production']);
  });
});
