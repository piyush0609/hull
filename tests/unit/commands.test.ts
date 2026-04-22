import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareCommand } from '../../src/commands/share.js';
import { listCommand } from '../../src/commands/list.js';
import { revokeCommand } from '../../src/commands/revoke.js';
import { destroyCommand } from '../../src/commands/destroy.js';
import * as config from '../../src/lib/config.js';

describe('CLI Commands', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('share should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(shareCommand('test.html', { expires: '24h' })).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss found. Run "toss deploy" first.');
  });

  it('list should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(listCommand()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss found. Run "toss deploy" first.');
  });

  it('revoke should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(revokeCommand('abc123')).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss found. Run "toss deploy" first.');
  });

  it('destroy should exit when no toss is deployed', async () => {
    vi.spyOn(config, 'loadConfig').mockResolvedValue(null);
    await expect(destroyCommand()).rejects.toThrow('process.exit(1)');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Error: No toss found. Nothing to destroy.');
  });
});
