import { readFile, writeFile, mkdir, chmod, access, rename } from 'fs/promises';
import { join } from 'path';

function getTossDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.toss');
}

function configFile(): string {
  return join(getTossDir(), 'config.json');
}

function profilesFile(): string {
  return join(getTossDir(), 'profiles.json');
}

export interface TossConfig {
  endpoint: string;
  token?: string;
  ownerToken?: string;
  subdomain: string;
  role?: 'owner' | 'member';
  backend?: 'cloudflare' | 'vercel';
  kvId?: string;
  accountId?: string;
  apiToken?: string;
  vercelProjectId?: string;
  vercelTeamId?: string;
}

interface ProfilesData {
  active?: string;
  profiles: Record<string, TossConfig>;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function isTransientJsonReadError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonWithRetry<T>(path: string, attempts = 3): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await readFile(path, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (error) {
      if (attempt === attempts || !isTransientJsonReadError(error)) {
        return null;
      }
      await sleep(10);
    }
  }

  return null;
}

async function writeJsonAtomically(path: string, data: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2));
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
  await chmod(path, 0o600);
}

async function readProfiles(): Promise<ProfilesData | null> {
  try {
    return await readJsonWithRetry<ProfilesData>(profilesFile());
  } catch {
    return null;
  }
}

async function writeProfiles(data: ProfilesData): Promise<void> {
  const dir = getTossDir();
  await mkdir(dir, { recursive: true });
  await writeJsonAtomically(profilesFile(), data);
}

function normalizeConfig(raw: TossConfig | null | undefined): TossConfig | null {
  if (!raw) return null;
  const token = raw.token || raw.ownerToken || '';
  return {
    ...raw,
    token,
    ownerToken: token,
  };
}

function serializeConfig(config: TossConfig): TossConfig {
  const normalized = normalizeConfig(config);
  if (!normalized) throw new Error('Invalid config');

  const { ownerToken, ...rest } = normalized;
  return rest;
}

export async function loadConfig(profile?: string): Promise<TossConfig | null> {
  // If a specific profile is requested, load it directly
  if (profile) {
    if (profile === 'default') {
      try {
        return normalizeConfig(await readJsonWithRetry<TossConfig>(configFile()));
      } catch {
        return null;
      }
    }
    const profiles = await readProfiles();
    return normalizeConfig(profiles?.profiles[profile] ?? null);
  }

  // Otherwise, check if there's an active profile
  const profiles = await readProfiles();
  if (profiles?.active && profiles.active !== 'default') {
    return normalizeConfig(profiles.profiles[profiles.active] ?? null);
  }

  // Fall back to default config
  try {
    return normalizeConfig(await readJsonWithRetry<TossConfig>(configFile()));
  } catch {
    return null;
  }
}

export async function getActiveProfile(): Promise<string | undefined> {
  const profiles = await readProfiles();
  if (profiles?.active) return profiles.active;
  const defaultExists = await fileExists(configFile());
  return defaultExists ? 'default' : undefined;
}

export async function saveConfig(config: TossConfig, profile?: string): Promise<void> {
  const serializable = serializeConfig(config);

  // If explicit profile given, save directly
  if (profile && profile !== 'default') {
    const profiles = (await readProfiles()) || { profiles: {} };
    profiles.profiles[profile] = serializable;
    await writeProfiles(profiles);
    return;
  }

  // If no profile specified, follow same logic as loadConfig:
  // save to active profile, or fall back to config.json
  if (!profile) {
    const profiles = await readProfiles();
    if (profiles?.active && profiles.active !== 'default') {
      profiles.profiles[profiles.active] = serializable;
      await writeProfiles(profiles);
      return;
    }
  }

  // Save to default config.json
  const dir = getTossDir();
  await mkdir(dir, { recursive: true });
  await writeJsonAtomically(configFile(), serializable);
}

export async function listProfiles(): Promise<{ active?: string; profiles: Record<string, TossConfig> }> {
  const defaultExists = await fileExists(configFile());
  const profilesData = await readProfiles();

  const allProfiles: Record<string, TossConfig> = {};
  if (defaultExists) {
    try {
      allProfiles.default = normalizeConfig(await readJsonWithRetry<TossConfig>(configFile()))!;
    } catch {}
  }
  if (profilesData) {
    for (const [name, config] of Object.entries(profilesData.profiles)) {
      const normalized = normalizeConfig(config);
      if (normalized) allProfiles[name] = normalized;
    }
  }

  return {
    active: profilesData?.active || (defaultExists ? 'default' : undefined),
    profiles: allProfiles,
  };
}

export async function switchProfile(name: string): Promise<boolean> {
  if (name === 'default') {
    const exists = await fileExists(configFile());
    if (!exists) return false;
    const profiles = await readProfiles();
    if (profiles) {
      profiles.active = 'default';
      await writeProfiles(profiles);
    } else {
      // No profiles file yet — create one just to track active = default
      await writeProfiles({ active: 'default', profiles: {} });
    }
    return true;
  }

  const profiles = await readProfiles();
  if (!profiles || !profiles.profiles[name]) return false;
  profiles.active = name;
  await writeProfiles(profiles);
  return true;
}

export async function deleteProfile(name: string): Promise<boolean> {
  if (name === 'default') {
    // Can't delete default via this API
    return false;
  }
  const profiles = await readProfiles();
  if (!profiles || !profiles.profiles[name]) return false;
  delete profiles.profiles[name];
  if (profiles.active === name) {
    profiles.active = 'default';
  }
  await writeProfiles(profiles);
  return true;
}

export async function renameProfile(oldName: string, newName: string): Promise<boolean> {
  if (oldName === 'default' || newName === 'default') return false;
  if (oldName === newName) return true;

  const profiles = await readProfiles();
  if (!profiles || !profiles.profiles[oldName]) return false;
  if (profiles.profiles[newName]) return false; // target exists

  profiles.profiles[newName] = profiles.profiles[oldName];
  delete profiles.profiles[oldName];

  if (profiles.active === oldName) {
    profiles.active = newName;
  }
  await writeProfiles(profiles);
  return true;
}

export async function copyProfile(from: string, to: string): Promise<boolean> {
  if (from === to) return true;

  const profiles = await readProfiles();
  let sourceConfig: TossConfig | null = null;

  if (from === 'default') {
    try {
      sourceConfig = normalizeConfig(await readJsonWithRetry<TossConfig>(configFile()));
    } catch {
      return false;
    }
  } else {
    if (!profiles || !profiles.profiles[from]) return false;
    sourceConfig = normalizeConfig(profiles.profiles[from]);
  }

  if (!sourceConfig) return false;

  if (to === 'default') {
    const dir = getTossDir();
    await mkdir(dir, { recursive: true });
    await writeFile(configFile(), JSON.stringify(serializeConfig(sourceConfig), null, 2));
    await chmod(configFile(), 0o600);
  } else {
    const p = profiles || { profiles: {} };
    p.profiles[to] = serializeConfig(sourceConfig);
    await writeProfiles(p);
  }
  return true;
}
