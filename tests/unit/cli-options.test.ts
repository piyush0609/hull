import { describe, it, expect } from 'vitest';
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
