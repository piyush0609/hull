import { readFile, writeFile, mkdir, chmod, access, rename, rm } from 'fs/promises';
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
  jwtSecret?: string;
  subdomain: string;
  role?: 'owner' | 'member';
  backend?: 'cloudflare' | 'vercel';
  kvId?: string;
  accountId?: string;
  apiToken?: string;
  vercelProjectId?: string;
  vercelTeamId?: string;
}

// Unified on-disk store: a single config.json holds every profile (including
// `default`) plus the active marker. Legacy installs — a flat config.json for the
// default profile + a separate profiles.json for named profiles — are read
// transparently and folded into this shape; the next write persists the unified
// file and removes the legacy profiles.json. Migration is therefore automatic and
// non-breaking. (Forward-only: an older toss cannot read the unified format.)
interface ConfigStore {
  active?: string;
  profiles: Record<string, TossConfig>;
}

// Legacy profiles.json shape (when config.json was a flat TossConfig).
interface LegacyProfilesData {
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

// A flat TossConfig (the legacy default config.json), as opposed to a unified store.
function isLegacyFlatConfig(obj: any): boolean {
  return !!obj && typeof obj === 'object' && !('profiles' in obj)
    && ('endpoint' in obj || 'subdomain' in obj || 'token' in obj || 'ownerToken' in obj);
}

// Read the unified store, transparently merging any legacy two-file layout.
// Pure read — never writes; the migration is persisted on the next write (writeStore).
async function readStore(): Promise<ConfigStore> {
  const cfgRaw = await readJsonWithRetry<any>(configFile());
  const legacy = await readJsonWithRetry<LegacyProfilesData>(profilesFile());

  const profiles: Record<string, TossConfig> = {};
  let active: string | undefined;
  const unified = !!cfgRaw && typeof cfgRaw === 'object'
    && !!cfgRaw.profiles && typeof cfgRaw.profiles === 'object';

  if (unified) {
    Object.assign(profiles, cfgRaw.profiles);
    active = cfgRaw.active;
  } else if (isLegacyFlatConfig(cfgRaw)) {
    profiles.default = cfgRaw as TossConfig;
    active = 'default';
  }

  // Fold in legacy named profiles without overwriting unified entries.
  if (legacy && legacy.profiles && typeof legacy.profiles === 'object') {
    for (const [name, config] of Object.entries(legacy.profiles)) {
      if (!(name in profiles)) profiles[name] = config;
    }
    // The legacy active marker wins only before migration (no unified file yet).
    if (legacy.active && !unified) active = legacy.active;
  }

  if (!active && profiles.default) active = 'default';
  return { active, profiles };
}

async function writeStore(store: ConfigStore): Promise<void> {
  await mkdir(getTossDir(), { recursive: true });
  await writeJsonAtomically(configFile(), store);
  // Unified config.json is now the single source of truth — drop the legacy file.
  if (await fileExists(profilesFile())) {
    try { await rm(profilesFile(), { force: true }); } catch {}
  }
}

export async function loadConfig(profile?: string): Promise<TossConfig | null> {
  const store = await readStore();
  const name = profile || store.active || 'default';
  return normalizeConfig(store.profiles[name] ?? null);
}

export async function getActiveProfile(): Promise<string | undefined> {
  const store = await readStore();
  if (store.active && store.profiles[store.active]) return store.active;
  if (store.profiles.default) return 'default';
  return undefined;
}

export async function saveConfig(config: TossConfig, profile?: string): Promise<void> {
  const store = await readStore();
  const name = profile || store.active || 'default';
  store.profiles[name] = serializeConfig(config);
  if (!store.active) store.active = name;
  await writeStore(store);
}

export async function listProfiles(): Promise<{ active?: string; profiles: Record<string, TossConfig> }> {
  const store = await readStore();
  const profiles: Record<string, TossConfig> = {};
  for (const [name, config] of Object.entries(store.profiles)) {
    const normalized = normalizeConfig(config);
    if (normalized) profiles[name] = normalized;
  }
  return {
    active: store.active || (profiles.default ? 'default' : undefined),
    profiles,
  };
}

export async function switchProfile(name: string): Promise<boolean> {
  const store = await readStore();
  if (!store.profiles[name]) return false;
  store.active = name;
  await writeStore(store);
  return true;
}

export async function deleteProfile(name: string): Promise<boolean> {
  if (name === 'default') return false; // default profile is not deletable
  const store = await readStore();
  if (!store.profiles[name]) return false;
  delete store.profiles[name];
  if (store.active === name) store.active = 'default';
  await writeStore(store);
  return true;
}

export async function renameProfile(oldName: string, newName: string): Promise<boolean> {
  if (oldName === 'default' || newName === 'default') return false;
  if (oldName === newName) return true;

  const store = await readStore();
  if (!store.profiles[oldName]) return false;
  if (store.profiles[newName]) return false; // target exists

  store.profiles[newName] = store.profiles[oldName];
  delete store.profiles[oldName];
  if (store.active === oldName) store.active = newName;
  await writeStore(store);
  return true;
}

export async function copyProfile(from: string, to: string): Promise<boolean> {
  if (from === to) return true;

  const store = await readStore();
  const source = store.profiles[from];
  if (!source) return false;
  const normalized = normalizeConfig(source);
  if (!normalized) return false;

  store.profiles[to] = serializeConfig(normalized);
  await writeStore(store);
  return true;
}
