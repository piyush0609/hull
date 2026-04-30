import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/prompt.js', () => ({
  promptSelect: vi.fn(),
}));

import { promptSelect } from '../../src/lib/prompt.js';
import {
  createBackendHandlers,
  getBackendHandler,
  resolveBackendForCommand,
  resolveBackendForSetup,
} from '../../src/lib/backend-router.js';

describe('Backend Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create backend handlers with names', () => {
    const handlers = createBackendHandlers({
      cloudflare: {
        setup: vi.fn(),
        deploy: vi.fn(),
        destroy: vi.fn(),
      },
      vercel: {
        setup: vi.fn(),
        deploy: vi.fn(),
        destroy: vi.fn(),
      },
    });

    expect(handlers.cloudflare.name).toBe('cloudflare');
    expect(handlers.vercel.name).toBe('vercel');
  });

  it('should resolve requested backend for commands', () => {
    expect(resolveBackendForCommand('vercel', 'cloudflare')).toBe('vercel');
    expect(resolveBackendForCommand('cloudflare', 'vercel')).toBe('cloudflare');
  });

  it('should resolve saved backend for commands when no explicit backend is provided', () => {
    expect(resolveBackendForCommand(undefined, 'vercel')).toBe('vercel');
    expect(resolveBackendForCommand(undefined, 'cloudflare')).toBe('cloudflare');
  });

  it('should default command backend to cloudflare when nothing is set', () => {
    expect(resolveBackendForCommand(undefined, undefined)).toBe('cloudflare');
  });

  it('should prefer requested backend during setup', async () => {
    await expect(resolveBackendForSetup({
      requestedBackend: 'vercel',
      profileBackend: 'cloudflare',
      promptOnMissing: true,
    })).resolves.toBe('vercel');
  });

  it('should reuse saved backend during setup when present', async () => {
    await expect(resolveBackendForSetup({
      requestedBackend: undefined,
      profileBackend: 'vercel',
      promptOnMissing: true,
    })).resolves.toBe('vercel');
  });

  it('should prompt for backend during setup when missing', async () => {
    vi.mocked(promptSelect).mockResolvedValue('vercel');

    await expect(resolveBackendForSetup({
      requestedBackend: undefined,
      profileBackend: undefined,
      promptOnMissing: true,
    })).resolves.toBe('vercel');

    expect(promptSelect).toHaveBeenCalledWith('Where do you want to deploy toss?', [
      { label: 'Cloudflare', value: 'cloudflare' },
      { label: 'Vercel', value: 'vercel' },
    ]);
  });

  it('should default setup backend to cloudflare in non-interactive mode', async () => {
    await expect(resolveBackendForSetup({
      requestedBackend: undefined,
      profileBackend: undefined,
      promptOnMissing: false,
    })).resolves.toBe('cloudflare');
  });

  it('should expose real backend handlers', () => {
    expect(getBackendHandler('cloudflare').name).toBe('cloudflare');
    expect(getBackendHandler('vercel').name).toBe('vercel');
  });
});
