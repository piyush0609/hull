import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtemp, writeFile, rm, readFile, mkdir, copyFile, access } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { TossConfig } from '../../src/lib/config.js';

const RUN_E2E = process.env.TOSS_E2E === '1';
const E2E_BACKEND = process.env.TOSS_E2E_BACKEND || 'cloudflare';
const projectRoot = join(__dirname, '../..');
const realHome = process.env.HOME || process.env.USERPROFILE || '';

async function findOwnerConfigForBackend(backend: string): Promise<TossConfig | null> {
  if (!realHome) return null;

  try {
    const raw = await readFile(join(realHome, '.toss', 'config.json'), 'utf-8');
    const profiles = JSON.parse(raw) as {
      active?: string;
      profiles?: Record<string, TossConfig>;
    };

    if (!profiles.profiles) return null;

    const candidates = [
      profiles.active ? profiles.profiles[profiles.active] : undefined,
      ...Object.values(profiles.profiles),
    ].filter((config): config is TossConfig => Boolean(config));

    return candidates.find((config) => config.backend === backend && config.role === 'owner') || null;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function seedCloudflareAuth(tempHome: string): Promise<void> {
  const candidatePaths = [
    join(realHome, '.config/.wrangler/config/default.toml'),
    join(realHome, 'Library/Preferences/.wrangler/config/default.toml'),
  ];

  for (const source of candidatePaths) {
    if (!(await fileExists(source))) continue;

    const relativePath = source.slice(realHome.length + 1);
    const target = join(tempHome, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

describe.skipIf(!RUN_E2E)('Live E2E', () => {
  let tempHome: string;
  let config: { endpoint: string; token: string; subdomain: string; role?: string; backend?: string };
  let childEnv: NodeJS.ProcessEnv;
  const profile = `e2e-owner-${Date.now()}`;

  beforeAll(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'toss-e2e-'));
    childEnv = { ...process.env, HOME: tempHome };

    // Ensure built
    execSync('npm run build', { cwd: projectRoot, stdio: 'ignore' });

    if (E2E_BACKEND === 'cloudflare' && (!childEnv.CLOUDFLARE_API_TOKEN || !childEnv.CLOUDFLARE_ACCOUNT_ID)) {
      const ownerConfig = await findOwnerConfigForBackend('cloudflare');
      if (ownerConfig?.apiToken && ownerConfig?.accountId) {
        childEnv.CLOUDFLARE_API_TOKEN = ownerConfig.apiToken;
        childEnv.CLOUDFLARE_ACCOUNT_ID = ownerConfig.accountId;
      } else {
        await seedCloudflareAuth(tempHome);
        if (ownerConfig?.accountId) {
          childEnv.CLOUDFLARE_ACCOUNT_ID = ownerConfig.accountId;
        }
      }
    }

    // Bootstrap owner auth/config for the chosen backend, then deploy.
    execSync(`./toss admin setup --backend ${E2E_BACKEND} --profile ${profile} --yes`, {
      cwd: projectRoot,
      env: childEnv,
      stdio: 'pipe',
    });

    execSync(`./toss admin deploy --backend ${E2E_BACKEND} --profile ${profile} --yes`, {
      cwd: projectRoot,
      env: childEnv,
      stdio: 'pipe',
    });

    const raw = await readFile(join(tempHome, '.toss', 'config.json'), 'utf-8');
    const profiles = JSON.parse(raw);
    config = profiles.profiles[profile];
    console.log(`Deployed to ${config.endpoint}`);
  }, 120000);

  afterAll(async () => {
    try {
      execSync(`./toss admin destroy --profile ${profile} --backend ${E2E_BACKEND} --yes`, {
        cwd: projectRoot,
        env: childEnv,
        stdio: 'pipe',
      });
      console.log('Destroyed.');
    } catch {
      // cleanup best-effort
    }
    await rm(tempHome, { recursive: true, force: true });
  }, 60000);

  it('full lifecycle: share → fetch → list → revoke → dead link', async () => {
    const htmlFile = join(tempHome, 'test.html');
    await writeFile(htmlFile, '<html><body>Hello E2E</body></html>');

    // Share through the named owner profile.
    const shareJson = execSync(`./toss ${htmlFile} --expires 1h --json --profile ${profile}`, {
      cwd: projectRoot,
      env: childEnv,
      encoding: 'utf-8',
    });
    const { id, url } = JSON.parse(shareJson);
    expect(id).toBeDefined();
    expect(url).toMatch(/^https:\/\//);

    // Fetch the share link
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<html><body>Hello E2E</body></html>');

    // List should contain the artifact
    const listOut = execSync(`./toss list --profile ${profile}`, {
      cwd: projectRoot,
      env: childEnv,
      encoding: 'utf-8',
    });
    expect(listOut).toContain(id.slice(0, 8));

    // Revoke
    execSync(`./toss revoke ${id} --profile ${profile}`, {
      cwd: projectRoot,
      env: childEnv,
      encoding: 'utf-8',
    });

    // Link should be dead
    const res2 = await fetch(url);
    expect(res2.status).toBe(404);
  }, 30000);
});
