import { describe, it, expect } from 'vitest';
import { resolveSecret, retryAsync } from '../../src/commands/deploy-vercel.js';

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

describe('resolveSecret', () => {
  it('reuses an existing secret from the project env instead of generating', () => {
    const env = 'JWT_SECRET="existing-secret-abc"\nDATABASE_URL="postgres://x"';
    const result = resolveSecret(env, 'JWT_SECRET', () => 'NEW-GENERATED');
    expect(result.value).toBe('existing-secret-abc');
    expect(result.generated).toBe(false);
  });

  it('generates a new secret when the env does not contain it', () => {
    const env = 'DATABASE_URL="postgres://x"';
    const result = resolveSecret(env, 'JWT_SECRET', () => 'NEW-GENERATED');
    expect(result.value).toBe('NEW-GENERATED');
    expect(result.generated).toBe(true);
  });

  it('generates a new secret when there is no project env yet (first deploy)', () => {
    const result = resolveSecret(null, 'OWNER_TOKEN', () => 'NEW-GENERATED');
    expect(result.value).toBe('NEW-GENERATED');
    expect(result.generated).toBe(true);
  });
});
