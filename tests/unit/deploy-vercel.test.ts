import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { retryAsync, buildVercelEnvAddArgs, extractVercelDeploymentUrl, requireVercelDatabaseUrl, vercelMigrationSteps } from '../../src/commands/deploy-vercel.js';

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

describe('extractVercelDeploymentUrl', () => {
  it('accepts the successful Vercel CLI 56 production output shape with ANSI progress', () => {
    const output = [
      'Vercel CLI 56.2.0',
      'Inspect: https://vercel.com/acme/toss/abc123',
      '\u001b[32mProduction:\u001b[0m https://toss-test-iphqfn6cj-acme.vercel.app [18s]',
    ].join('\n');
    expect(extractVercelDeploymentUrl(output)).toBe('https://toss-test-iphqfn6cj-acme.vercel.app');
  });

  it('accepts JSON and plain deployment URL output without selecting dashboard URLs', () => {
    expect(extractVercelDeploymentUrl('{"deployment":{"url":"toss-json-acme.vercel.app"}}')).toBe('https://toss-json-acme.vercel.app');
    expect(extractVercelDeploymentUrl('Inspect: https://vercel.com/acme/toss/abc\nhttps://toss-plain-acme.vercel.app')).toBe('https://toss-plain-acme.vercel.app');
    expect(extractVercelDeploymentUrl('Inspect: https://vercel.com/acme/toss/abc')).toBeNull();
  });
});

describe('Vercel staged migration ordering', () => {
  it('aborts the cutover without a production database URL, including skip mode', () => {
    expect(() => requireVercelDatabaseUrl('', false)).toThrow('production DATABASE_URL');
    expect(() => requireVercelDatabaseUrl('   ', true)).toThrow('--skip-migrate still requires an exact schema probe');
    expect(requireVercelDatabaseUrl(' postgres://host/db ', false)).toBe('postgres://host/db');
    const source = readFileSync('src/commands/deploy-vercel.ts', 'utf8');
    expect(source.indexOf('databaseUrl = requireVercelDatabaseUrl')).toBeLessThan(source.indexOf('// Auto-provision Vercel Blob store'));
    expect(source.indexOf('databaseUrl = requireVercelDatabaseUrl')).toBeLessThan(source.indexOf("deployOutput = await vercelExec('vercel deploy --prod"));
  });
  it('installs the committed lock, expands, promotes, then contracts and verifies', () => {
    expect(vercelMigrationSteps(false)).toEqual([
      'npm ci --silent',
      'node migrate.js --phase pre',
      'vercel deploy --prod --yes --non-interactive --force',
      'vercel promote <deployment-url>',
      'node migrate.js --phase post',
      'node migrate.js --phase probe',
    ]);
  });

  it('turns skip-pre into a probe and never skips post', () => {
    const steps = vercelMigrationSteps(true);
    expect(steps[1]).toBe('node migrate.js --phase probe');
    expect(steps).toContain('node migrate.js --phase post');
    expect(steps.join('\n')).not.toContain('npm install --no-package-lock');
  });
});
