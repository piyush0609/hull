import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadConfig,
  saveConfig,
  getActiveProfile,
  renameProfile,
  copyProfile,
  type TossConfig,
} from '../../src/lib/config.js';

let tempDir: string;

// Mock the config paths
const originalHomedir = process.env.HOME;

function configFile() {
  return join(tempDir, '.toss', 'config.json');
}

function profilesFile() {
  return join(tempDir, '.toss', 'profiles.json');
}

async function writeDefaultConfig(config: TossConfig) {
  const dir = join(tempDir, '.toss');
  await mkdir(dir, { recursive: true });
  await writeFile(configFile(), JSON.stringify(config));
}

async function writeProfiles(active: string | undefined, profiles: Record<string, TossConfig>) {
  const dir = join(tempDir, '.toss');
  await mkdir(dir, { recursive: true });
  await writeFile(profilesFile(), JSON.stringify({ active, profiles }));
}

function withLegacyToken(config: TossConfig) {
  return {
    ...config,
    ownerToken: config.token || config.ownerToken,
  };
}

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
      token: 'deadbeef0123456789abcdef01234567',
      subdomain: 'test',
    };

    await saveConfig(testConfig);
    const loaded = await loadConfig();

    expect(loaded).toEqual(withLegacyToken(testConfig));
  });

  it('should load default profile explicitly', async () => {
    const testConfig: TossConfig = {
      endpoint: 'https://default.workers.dev',
      token: 'token-default',
      subdomain: 'default',
    };
    await writeDefaultConfig(testConfig);

    const loaded = await loadConfig('default');
    expect(loaded).toEqual(withLegacyToken(testConfig));
  });

  it('should load named profile', async () => {
    const workConfig: TossConfig = {
      endpoint: 'https://work.workers.dev',
      token: 'token-work',
      subdomain: 'work',
    };
    await writeProfiles(undefined, { work: workConfig });

    const loaded = await loadConfig('work');
    expect(loaded).toEqual(withLegacyToken(workConfig));
  });

  it('should use active profile when no profile specified', async () => {
    const workConfig: TossConfig = {
      endpoint: 'https://work.workers.dev',
      token: 'token-work',
      subdomain: 'work',
    };
    await writeProfiles('work', { work: workConfig });

    const loaded = await loadConfig();
    expect(loaded).toEqual(withLegacyToken(workConfig));
  });

  it('should fall back to default config when no active profile', async () => {
    const defaultConfig: TossConfig = {
      endpoint: 'https://default.workers.dev',
      token: 'token-default',
      subdomain: 'default',
    };
    await writeDefaultConfig(defaultConfig);

    const loaded = await loadConfig();
    expect(loaded).toEqual(withLegacyToken(defaultConfig));
  });

  it('should fall back to default config when active is default', async () => {
    const defaultConfig: TossConfig = {
      endpoint: 'https://default.workers.dev',
      token: 'token-default',
      subdomain: 'default',
    };
    await writeDefaultConfig(defaultConfig);
    await writeProfiles('default', {});

    const loaded = await loadConfig();
    expect(loaded).toEqual(withLegacyToken(defaultConfig));
  });

  it('should save to active profile when no profile specified', async () => {
    const workConfig: TossConfig = {
      endpoint: 'https://work.workers.dev',
      token: 'token-work',
      subdomain: 'work',
    };
    await writeProfiles('work', { work: workConfig });

    const updatedConfig: TossConfig = {
      ...workConfig,
      endpoint: 'https://work-new.workers.dev',
    };
    await saveConfig(updatedConfig);

    const loaded = await loadConfig('work');
    expect(loaded).toEqual(withLegacyToken(updatedConfig));
  });

  it('should save to default config when no active profile', async () => {
    const defaultConfig: TossConfig = {
      endpoint: 'https://default.workers.dev',
      token: 'token-default',
      subdomain: 'default',
    };
    await writeDefaultConfig(defaultConfig);

    const updatedConfig: TossConfig = {
      ...defaultConfig,
      endpoint: 'https://default-new.workers.dev',
    };
    await saveConfig(updatedConfig);

    const loaded = await loadConfig('default');
    expect(loaded).toEqual(withLegacyToken(updatedConfig));
  });

  it('should save to explicit default profile', async () => {
    const defaultConfig: TossConfig = {
      endpoint: 'https://default.workers.dev',
      token: 'token-default',
      subdomain: 'default',
    };
    await writeDefaultConfig(defaultConfig);

    const updatedConfig: TossConfig = {
      ...defaultConfig,
      endpoint: 'https://default-new.workers.dev',
    };
    await saveConfig(updatedConfig, 'default');

    const loaded = await loadConfig('default');
    expect(loaded).toEqual(withLegacyToken(updatedConfig));
  });
});

describe('getActiveProfile', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'toss-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHomedir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return undefined when nothing exists', async () => {
    expect(await getActiveProfile()).toBeUndefined();
  });

  it('should return default when only config.json exists', async () => {
    await writeDefaultConfig({ endpoint: 'https://test.workers.dev', token: 't', subdomain: 's' });
    expect(await getActiveProfile()).toBe('default');
  });

  it('should return active profile name', async () => {
    await writeProfiles('work', { work: { endpoint: 'https://work.workers.dev', token: 't', subdomain: 's' } });
    expect(await getActiveProfile()).toBe('work');
  });
});

describe('renameProfile', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'toss-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHomedir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should rename a profile', async () => {
    const config: TossConfig = { endpoint: 'https://old.workers.dev', token: 't', subdomain: 's' };
    await writeProfiles('old', { old: config });

    const ok = await renameProfile('old', 'new');
    expect(ok).toBe(true);

    expect(await loadConfig('old')).toBeNull();
    expect(await loadConfig('new')).toEqual(withLegacyToken(config));
  });

  it('should update active profile on rename', async () => {
    const config: TossConfig = { endpoint: 'https://old.workers.dev', token: 't', subdomain: 's' };
    await writeProfiles('old', { old: config });

    await renameProfile('old', 'new');
    expect(await getActiveProfile()).toBe('new');
  });

  it('should fail to rename default profile', async () => {
    expect(await renameProfile('default', 'new')).toBe(false);
  });

  it('should fail to rename to default', async () => {
    expect(await renameProfile('old', 'default')).toBe(false);
  });

  it('should fail if target exists', async () => {
    const a: TossConfig = { endpoint: 'https://a.workers.dev', token: 't', subdomain: 's' };
    const b: TossConfig = { endpoint: 'https://b.workers.dev', token: 't', subdomain: 's' };
    await writeProfiles('a', { a, b });

    expect(await renameProfile('a', 'b')).toBe(false);
  });
});

describe('copyProfile', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'toss-test-'));
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHomedir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should copy default to named profile', async () => {
    const config: TossConfig = { endpoint: 'https://default.workers.dev', token: 't', subdomain: 's' };
    await writeDefaultConfig(config);

    const ok = await copyProfile('default', 'work');
    expect(ok).toBe(true);
    expect(await loadConfig('work')).toEqual(withLegacyToken(config));
  });

  it('should copy named to default', async () => {
    const config: TossConfig = { endpoint: 'https://work.workers.dev', token: 't', subdomain: 's' };
    await writeProfiles('work', { work: config });

    const ok = await copyProfile('work', 'default');
    expect(ok).toBe(true);
    expect(await loadConfig('default')).toEqual(withLegacyToken(config));
  });

  it('should copy named to named', async () => {
    const config: TossConfig = { endpoint: 'https://a.workers.dev', token: 't', subdomain: 's' };
    await writeProfiles('a', { a: config });

    const ok = await copyProfile('a', 'b');
    expect(ok).toBe(true);
    expect(await loadConfig('b')).toEqual(withLegacyToken(config));
  });

  it('should fail if source does not exist', async () => {
    expect(await copyProfile('missing', 'target')).toBe(false);
  });

  it('should succeed for same name', async () => {
    expect(await copyProfile('same', 'same')).toBe(true);
  });
});
