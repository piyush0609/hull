import { describe, it, expect } from 'vitest';
import { resolveSecret } from '../../src/lib/deploy-secrets.js';

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
