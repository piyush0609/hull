import { describe, it, expect } from 'vitest';
import { resolveSecret, assertStrongJwtSecret } from '../../src/lib/deploy-secrets.js';

// Mirrors generateToken() in the deploy commands: 32 random bytes -> 64 hex chars.
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('resolveSecret', () => {
  it('reuses the local config value and does NOT rewrite when the backend already has it', () => {
    const r = resolveSecret('local-secret', true, () => 'GEN');
    expect(r.value).toBe('local-secret');
    expect(r.write).toBe(false); // no churn, no rotation
    expect(r.known).toBe(true);
  });

  it('reuses the local value and writes it when the backend is missing it (seeds a fresh/recreated backend)', () => {
    const r = resolveSecret('local-secret', false, () => 'GEN');
    expect(r.value).toBe('local-secret');
    expect(r.write).toBe(true); // migration path: same secret onto a new project/worker
    expect(r.known).toBe(true);
  });

  it('does NOT rotate a backend secret it cannot read when there is no local copy', () => {
    const r = resolveSecret(undefined, true, () => 'GEN');
    expect(r.value).toBeUndefined();
    expect(r.write).toBe(false); // leave the existing (sealed) secret alone
    expect(r.known).toBe(false); // unknown -> must not be persisted to config
  });

  it('generates on a true first deploy (no local copy, not on backend)', () => {
    const r = resolveSecret(undefined, false, () => 'GEN');
    expect(r.value).toBe('GEN');
    expect(r.write).toBe(true);
    expect(r.known).toBe(true);
  });

  it('mustHaveValue regenerates even when the backend has it but the local copy is gone (owner-token recovery)', () => {
    const r = resolveSecret(undefined, true, () => 'GEN', { mustHaveValue: true });
    expect(r.value).toBe('GEN');
    expect(r.write).toBe(true);
    expect(r.known).toBe(true);
  });

  it('treats empty string as no local value', () => {
    const r = resolveSecret('', false, () => 'GEN');
    expect(r.value).toBe('GEN');
    expect(r.write).toBe(true);
  });
});

describe('assertStrongJwtSecret', () => {
  const MSG = /at least 32 bytes/;

  it('throws on an empty string', () => {
    expect(() => assertStrongJwtSecret('')).toThrow(MSG);
  });

  it('throws on undefined', () => {
    expect(() => assertStrongJwtSecret(undefined)).toThrow(MSG);
  });

  it('throws on a 31-char ASCII string (31 bytes, just under the boundary)', () => {
    const s = 'a'.repeat(31);
    expect(s.length).toBe(31);
    expect(() => assertStrongJwtSecret(s)).toThrow(MSG);
  });

  it('accepts a 32-char ASCII string (32 bytes, exactly at the boundary)', () => {
    const s = 'a'.repeat(32);
    expect(s.length).toBe(32);
    expect(() => assertStrongJwtSecret(s)).not.toThrow();
  });

  it('accepts the 64-hex generateToken() output (32 random bytes -> 64 chars)', () => {
    const s = generateToken();
    expect(s.length).toBe(64);
    expect(() => assertStrongJwtSecret(s)).not.toThrow();
  });

  it('measures BYTES not code units: accepts "é".repeat(16) (.length 16, byteLength 32)', () => {
    const s = 'é'.repeat(16);
    expect(s.length).toBe(16);
    expect(new TextEncoder().encode(s).byteLength).toBe(32);
    expect(() => assertStrongJwtSecret(s)).not.toThrow();
  });

  it('measures BYTES not code units: throws on "é".repeat(15)+"a" (.length 16, byteLength 31)', () => {
    const s = 'é'.repeat(15) + 'a';
    expect(s.length).toBe(16);
    expect(new TextEncoder().encode(s).byteLength).toBe(31);
    expect(() => assertStrongJwtSecret(s)).toThrow(MSG);
  });
});
