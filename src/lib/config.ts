import { readFile, writeFile, mkdir, chmod, access } from 'fs/promises';
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
  ownerToken: string;
  subdomain: string;
  kvId?: string;
  accountId?: string;
  apiToken?: string;
}

interface ProfilesData {
  active?: string;
  profiles: Record<string, TossConfig>;
}

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function readProfiles(): Promise<ProfilesData | null> {
  try {
    const raw = await readFile(profilesFile(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeProfiles(data: ProfilesData): Promise<void> {
  const dir = getTossDir();
  await mkdir(dir, { recursive: true });
  await writeFile(profilesFile(), JSON.stringify(data, null, 2));
  await chmod(profilesFile(), 0o600);
}

export async function loadConfig(profile?: string): Promise<TossConfig | null> {
  // If a specific profile is requested, load it directly
  if (profile) {
    if (profile === 'default') {
      try {
        const raw = await readFile(configFile(), 'utf-8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    const profiles = await readProfiles();
    return profiles?.profiles[profile] ?? null;
  }

  // Otherwise, check if there's an active profile
  const profiles = await readProfiles();
  if (profiles?.active && profiles.active !== 'default') {
    return profiles.profiles[profiles.active] ?? null;
  }

  // Fall back to default config
  try {
    const raw = await readFile(configFile(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveConfig(config: TossConfig, profile?: string): Promise<void> {
  if (profile && profile !== 'default') {
    const profiles = (await readProfiles()) || { profiles: {} };
    profiles.profiles[profile] = config;
    await writeProfiles(profiles);
  } else {
    const dir = getTossDir();
    await mkdir(dir, { recursive: true });
    await writeFile(configFile(), JSON.stringify(config, null, 2));
    await chmod(configFile(), 0o600);
  }
}

export async function listProfiles(): Promise<{ active?: string; profiles: Record<string, TossConfig> }> {
  const defaultExists = await fileExists(configFile());
  const profilesData = await readProfiles();

  const allProfiles: Record<string, TossConfig> = {};
  if (defaultExists) {
    try {
      allProfiles.default = JSON.parse(await readFile(configFile(), 'utf-8'));
    } catch {}
  }
  if (profilesData) {
    Object.assign(allProfiles, profilesData.profiles);
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
