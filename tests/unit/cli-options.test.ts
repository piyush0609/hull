import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getCommandOptions, readRawOption } from '../../src/lib/cli-options.js';

describe('readRawOption', () => {
  it('reads a long-option value from argv', () => {
    expect(readRawOption('profile', ['--profile', 'test'])).toBe('test');
  });
  it('reads the --key=value form', () => {
    expect(readRawOption('profile', ['--profile=test'])).toBe('test');
  });
  it('maps camelCase to --kebab-case and returns true for a bare flag', () => {
    expect(readRawOption('multiTenant', ['--multi-tenant'])).toBe(true);
  });
  it('returns undefined when the option is absent', () => {
    expect(readRawOption('profile', ['--backend', 'vercel'])).toBeUndefined();
  });
});

describe('getCommandOptions', () => {
  it('prefers commander-parsed values over the argv fallback', () => {
    const fakeCommand = { opts: () => ({ profile: 'fromOpts' }) };
    const opts = getCommandOptions([fakeCommand], ['profile'], ['--profile', 'fromArgv']);
    expect(opts.profile).toBe('fromOpts');
  });

  it('recovers a --profile that commander dropped from subcommand opts (the footgun)', () => {
    // Commander drops a subcommand option when a same-named option exists on the
    // parent program. Here opts() lacks `profile`, but argv still has it.
    const fakeCommand = { opts: () => ({ backend: 'vercel', subdomain: 'test', yes: true }) };
    const argv = ['deploy', '--backend', 'vercel', '--profile', 'test', '--subdomain', 'test', '--yes'];
    const opts = getCommandOptions([fakeCommand], ['domain', 'profile', 'subdomain', 'backend', 'yes'], argv);
    expect(opts.profile).toBe('test');
    expect(opts.backend).toBe('vercel');
  });
});

// Drives the real CLI through commander to assert user-facing argument names.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function runCli(args: string[]): { stderr: string; status: number } {
  try {
    execFileSync(resolve(REPO_ROOT, 'node_modules/.bin/tsx'), [resolve(REPO_ROOT, 'src/index.ts'), ...args], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; status?: number };
    return { stderr: e.stderr?.toString() ?? '', status: e.status ?? 1 };
  }
}

describe('revoke argument name (CLI)', () => {
  // The artifact revoke operates on a slug (see `toss list` / share output), so a
  // missing positional must read 'slug', not the internal 'id'. Regression for a
  // user-reported confusing error: `toss revoke` -> "missing required argument 'id'".
  it('reports the missing positional as "slug", not "id"', () => {
    const { stderr, status } = runCli(['revoke']);
    expect(status).toBe(1);
    expect(stderr).toContain("missing required argument 'slug'");
    expect(stderr).not.toContain("missing required argument 'id'");
  }, 20000);
});

describe('comments argument name (CLI)', () => {
  // `comments` likewise takes a slug-or-id; the missing positional must read 'slug'.
  it('reports the missing positional as "slug", not "id"', () => {
    const { stderr, status } = runCli(['comments']);
    expect(status).toBe(1);
    expect(stderr).toContain("missing required argument 'slug'");
    expect(stderr).not.toContain("missing required argument 'id'");
  }, 20000);

  it('registers feedback filtering and check options in help', () => {
    try {
      const stdout = execFileSync(resolve(REPO_ROOT, 'node_modules/.bin/tsx'), [resolve(REPO_ROOT, 'src/index.ts'), 'comments', '--help'], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      expect(stdout).toContain('--type <kind>');
      expect(stdout).toContain('--status <status>');
      expect(stdout).toContain('--check');
    } catch (err) {
      throw new Error(`comments --help failed: ${String(err)}`);
    }
  }, 20000);
});
