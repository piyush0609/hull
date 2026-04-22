import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, saveConfig, type TossConfig } from '../../src/lib/config.js';

let tempDir: string;

// Mock the config paths
const originalHomedir = process.env.HOME;

describe('Config', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'toss-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHomedir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return null when config does not exist', async () => {
    const config = await loadConfig();
    expect(config).toBeNull();
  });

  it('should save and load config', async () => {
    const testConfig: TossConfig = {
      endpoint: 'https://toss-test.workers.dev',
      ownerToken: 'deadbeef0123456789abcdef01234567',
      subdomain: 'test',
    };

    await saveConfig(testConfig);
    const loaded = await loadConfig();

    expect(loaded).toEqual(testConfig);
  });
});
