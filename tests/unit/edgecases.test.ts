import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig, saveConfig } from '../../src/lib/config.js';
import { shareCommand } from '../../src/commands/share.js';

describe('Edge Cases & Failure Modes', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'toss-edge-'));
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  describe('Config', () => {
    it('should handle malformed JSON gracefully', async () => {
      const configDir = join(tempHome, '.toss');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'config.json'), '{ invalid json');
      const config = await loadConfig();
      expect(config).toBeNull();
    });

    it('should handle missing fields gracefully', async () => {
      await saveConfig({ endpoint: 'http://test', ownerToken: 'abc', subdomain: 'test' });
      // Should load without crashing
      const config = await loadConfig();
      expect(config).not.toBeNull();
      expect(config!.endpoint).toBe('http://test');
    });
  });

  describe('Share Command', () => {
    it('should reject invalid duration strings', async () => {
      vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
        throw new Error(`process.exit(${code})`);
      });

      await expect(shareCommand('test.html', { expires: '99x' })).rejects.toThrow();
    });

    it('should reject non-existent files', async () => {
      vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
        throw new Error(`process.exit(${code})`);
      });

      // Mock config so it passes config check but fails on file read
      await saveConfig({ endpoint: 'http://test', ownerToken: 'abc', subdomain: 'test' });
      await expect(shareCommand('/nonexistent/file.html', { expires: '1h' })).rejects.toThrow();
    });
  });
});
