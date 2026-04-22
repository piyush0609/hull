import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

function configFile(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.toss', 'config.json');
}

export interface TossConfig {
  endpoint: string;
  ownerToken: string;
  subdomain: string;
  kvId?: string;
}

export async function loadConfig(): Promise<TossConfig | null> {
  try {
    const raw = await readFile(configFile(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveConfig(config: TossConfig): Promise<void> {
  const file = configFile();
  const dir = file.slice(0, file.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2));
}
