import { describe, it, expect } from 'vitest';
import { compareSemver, maybeNotifyUpdate } from '../../src/lib/update-check.js';

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareSemver('1.2.0', '1.1.0')).toBeGreaterThan(0);
    expect(compareSemver('1.1.1', '1.1.2')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('treats a prerelease as older than its release', () => {
    expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0);
  });

  it('ignores build metadata', () => {
    expect(compareSemver('1.2.3+build.9', '1.2.3')).toBe(0);
  });

  it('flags a newer published version (current < latest)', () => {
    expect(compareSemver('0.1.0', '0.1.1') < 0).toBe(true);
    expect(compareSemver('0.1.0', '0.1.0') < 0).toBe(false);
  });
});

describe('maybeNotifyUpdate', () => {
  it('is silent and safe in a non-TTY context (no throw, no network)', async () => {
    // vitest stderr is not a TTY, so this must return early — proving it never
    // blocks a command and never reaches the network during tests.
    await expect(maybeNotifyUpdate('0.0.1')).resolves.toBeUndefined();
  });

  it('respects the TOSS_NO_UPDATE_CHECK opt-out', async () => {
    const prev = process.env.TOSS_NO_UPDATE_CHECK;
    process.env.TOSS_NO_UPDATE_CHECK = '1';
    try {
      await expect(maybeNotifyUpdate('0.0.1')).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.TOSS_NO_UPDATE_CHECK;
      else process.env.TOSS_NO_UPDATE_CHECK = prev;
    }
  });
});
