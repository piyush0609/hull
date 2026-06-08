import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs helper, no type declarations
import { renderVersionModule } from '../../scripts/genversion.mjs';

describe('genversion renderVersionModule', () => {
  it('emits a valid version module for a plain semver', () => {
    const out = renderVersionModule('1.2.3');
    expect(out).toContain('export const VERSION = "1.2.3";');
    expect(out).toContain('do not edit');
  });

  it('accepts prerelease and build metadata', () => {
    expect(renderVersionModule('1.2.3-beta.1')).toContain('"1.2.3-beta.1"');
    expect(renderVersionModule('1.2.3+build.5')).toContain('"1.2.3+build.5"');
  });

  it('rejects non-semver values', () => {
    expect(() => renderVersionModule('1.2')).toThrow();
    expect(() => renderVersionModule('latest')).toThrow();
    expect(() => renderVersionModule('v1.2.3')).toThrow();
    // @ts-expect-error — deliberately passing a non-string
    expect(() => renderVersionModule(undefined)).toThrow();
  });

  it('cannot be tricked into emitting executable code via the version string', () => {
    // A crafted version must fail validation, not be serialized into source.
    expect(() => renderVersionModule('1.0.0"; globalThis.pwned = 1; //')).toThrow();
  });

  it('is deterministic, so writes are idempotent', () => {
    expect(renderVersionModule('0.1.0')).toBe(renderVersionModule('0.1.0'));
  });
});
