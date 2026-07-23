import { mkdir, writeFile, rm, readdir, copyFile, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { saveConfig, loadConfig, listProfiles } from '../lib/config.js';
import { prompt, promptConfirm, promptSelect } from '../lib/prompt.js';
import { resolveSecret, assertStrongJwtSecret } from '../lib/deploy-secrets.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

function deriveDeploymentSuffix(profileName?: string, savedSubdomain?: string): string {
  if (savedSubdomain) return savedSubdomain;
  if (!profileName || profileName === 'default' || profileName === 'owner') return 'toss';
  return profileName.toLowerCase().replace(/_/g, '-');
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function getWranglerToken(): Promise<string | null> {
  const paths = [
    join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
    join(homedir(), '.wrangler/config/default.toml'),
  ];
  for (const p of paths) {
    try {
      const toml = await readFile(p, 'utf-8');
      const match = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}
  }
  return null;
}

async function getWorkersDevSubdomain(accountId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await res.json();
    if (data.success && data.result?.subdomain) {
      return data.result.subdomain;
    }
  } catch {}
  return null;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

async function wranglerJSON(cmd: string, env?: { env: NodeJS.ProcessEnv }): Promise<string> {
  const { stdout } = await execAsync(cmd, env);
  return typeof stdout === 'string' ? stdout : stdout.toString();
}

async function createKV(title: string, env?: { env: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const out = await wranglerJSON(`wrangler kv namespace create "${title}"`, env);
    const m = out.match(/"id":\s*"([a-f0-9]+)"/) || out.match(/([a-f0-9]{32})/);
    if (m) return m[1];
  } catch (err: any) {
    if (!err.stderr?.includes('already exists')) throw err;
    const out = await wranglerJSON('wrangler kv namespace list', env);
    const m = out.match(new RegExp(`"id"\\s*:\\s*"([a-f0-9]{32})".*"title"\\s*:\\s*"${title}"`, 's'));
    if (m) return m[1];
  }
  throw new Error('Could not create or find KV namespace');
}

async function createD1(name: string, env?: { env: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const out = await wranglerJSON(`wrangler d1 create ${name}`, env);
    const m = out.match(/"database_id":\s*"([a-f0-9-]+)"/) || out.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    if (m) return m[1];
  } catch (err: any) {
    if (!err.stderr?.includes('already exists')) throw err;
    const out = await wranglerJSON('wrangler d1 list', env);
    const m = out.match(new RegExp(`([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}).*${name}`));
    if (m) return m[1];
  }
  throw new Error('Could not create or find D1 database');
}

async function setSecret(cwd: string, name: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('wrangler', ['secret', 'put', name], { cwd, stdio: ['pipe', 'inherit', 'inherit'] });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler secret put ${name} exited with code ${code}`));
    });
    proc.stdin!.write(value);
    proc.stdin!.end();
  });
}

// Existence-by-name check (worker secrets are write-only — never readable). Used
// to avoid re-minting a secret that already exists on the worker across deploys.
async function cloudflareSecretExists(cwd: string, name: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await execAsync('wrangler secret list', { cwd, env });
    return String(stdout).includes(`"${name}"`);
  } catch {
    return false;
  }
}

export async function deployCommand(options: { domain?: string; multiTenant?: boolean; profile?: string; subdomain?: string }) {
  console.log('Setting up your toss on Cloudflare...\n');

  // Quick prereq check — direct to setup if anything is missing
  try {
    await execAsync('wrangler --version');
  } catch {
    console.error('❌ Wrangler not found. Run: toss admin setup');
    process.exit(1);
  }

  // Interactive profile selection
  let profileName = options.profile;
  if (!profileName && process.stdin.isTTY) {
    const { profiles, active } = await listProfiles();
    const profileNames = Object.keys(profiles);
    if (profileNames.length > 0) {
      console.log('Existing profiles:');
      profileNames.forEach((p) => {
        const marker = p === active ? ' *' : '';
        console.log(`  ${p}${marker}`);
      });
      const useExisting = await promptConfirm('Use an existing profile?', true);
      if (useExisting) {
        const choices = profileNames.map((p) => ({ label: p + (p === active ? ' (active)' : ''), value: p }));
        profileName = await promptSelect('Select profile:', choices);
      } else {
        profileName = await prompt('Name for new profile: ');
        if (!profileName || !/^[a-z0-9_-]+$/.test(profileName)) {
          console.error('Error: Profile name must be lowercase alphanumeric with hyphens/underscores.');
          process.exit(1);
        }
      }
    } else {
      const createProfile = await promptConfirm('Save this deployment as a named profile?', true);
      if (createProfile) {
        profileName = await prompt('Profile name (e.g. personal, work): ');
        if (!profileName || !/^[a-z0-9_-]+$/.test(profileName)) {
          console.error('Error: Profile name must be lowercase alphanumeric with hyphens/underscores.');
          process.exit(1);
        }
      }
    }
  }

  // Interactive deployment mode
  let multiTenant = options.multiTenant;
  if (multiTenant === undefined && process.stdin.isTTY) {
    const mode = await promptSelect('Deployment mode:', [
      { label: 'Single-user (personal use)', value: 'single' as const },
      { label: 'Multi-tenant team (shared with teammates)', value: 'team' as const },
    ]);
    multiTenant = mode === 'team';
    console.log();
  }

  // Load unconditionally so a saved subdomain/secrets are honored even without an
  // explicit --profile (otherwise a redeploy can't reuse them and would rotate).
  const profileConfig = await loadConfig(profileName);

  // Build wrangler environment: support API token per profile
  let apiToken = profileConfig?.apiToken || process.env.CLOUDFLARE_API_TOKEN || '';
  let accountId = profileConfig?.accountId || '';

  if (apiToken) {
    // Verify API token
    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      const data = await res.json() as { success: boolean };
      if (!data.success) throw new Error('Invalid token');
      console.log('✅ Using profile API token');
    } catch {
      console.error('❌ API token verification failed. Check your token.');
      process.exit(1);
    }
    // Fetch account ID if not stored
    if (!accountId) {
      try {
        const res = await fetch('https://api.cloudflare.com/client/v4/accounts', {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        const data = await res.json() as { success: boolean; result?: Array<{ id: string }> };
        if (data.success && data.result && data.result.length > 0) {
          accountId = data.result[0].id;
        }
      } catch {}
    }
  } else {
    // Fall back to wrangler OAuth
    try {
      const { stdout } = await execAsync('wrangler whoami');
      if (stdout.includes('not authenticated')) {
        console.error('❌ Not authenticated with Cloudflare. Run: toss admin setup');
        process.exit(1);
      }
      const match = stdout.match(/([a-f0-9]{32})/);
      if (match) accountId = match[1];
    } catch {
      console.error('❌ Not authenticated with Cloudflare. Run: toss admin setup');
      process.exit(1);
    }
  }

  // Priority: explicit --subdomain → TOSS_SUBDOMAIN env → saved profile → derived default.
  const subdomain = options.subdomain
    || process.env.TOSS_SUBDOMAIN
    || deriveDeploymentSuffix(profileName, profileConfig?.subdomain);
  if (subdomain && !/^[a-z0-9-]+$/.test(subdomain)) {
    console.error('Error: Subdomain must be lowercase alphanumeric with hyphens only.');
    process.exit(1);
  }
  console.log(`Using deployment suffix: ${subdomain}`);

  // Save subdomain early so destroy can find resources if deploy fails later
  const earlyConfig = await loadConfig(profileName) || { endpoint: '', token: '', subdomain, role: 'owner' as const };
  earlyConfig.subdomain = subdomain;
  earlyConfig.role = 'owner';
  if (accountId) earlyConfig.accountId = accountId;
  if (apiToken) earlyConfig.apiToken = apiToken;
  await saveConfig(earlyConfig, profileName);

  // Validate custom domain if provided
  const customDomain = options.domain || process.env.TOSS_DOMAIN || undefined;
  if (customDomain) {
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z]{2,}(\.[a-z]{2,})?$/i.test(customDomain)) {
      console.error('Error: Invalid domain format.');
      process.exit(1);
    }
  }

  const workerName = subdomain && subdomain !== 'toss' ? `toss-${subdomain}` : 'toss';
  const dbName = subdomain && subdomain !== 'toss' ? `toss-db-${subdomain}` : 'toss-db';
  const kvTitle = subdomain && subdomain !== 'toss' ? `toss-kv-${subdomain}` : 'toss-kv';
  const workerDir = join(process.env.HOME || process.env.USERPROFILE || '.', '.toss', 'worker');

  const wranglerEnvBase: NodeJS.ProcessEnv = { ...process.env };
  if (accountId) wranglerEnvBase.CLOUDFLARE_ACCOUNT_ID = accountId;
  if (apiToken) wranglerEnvBase.CLOUDFLARE_API_TOKEN = apiToken;
  const wranglerEnv = Object.keys(wranglerEnvBase).length > 0 ? { env: wranglerEnvBase } : undefined;

  console.log(`Creating KV namespace ${kvTitle}...`);
  const kvId = await createKV(kvTitle, wranglerEnv).catch((err) => {
    console.error('Failed to create KV namespace:', err.message);
    process.exit(1);
  });

  console.log(`Creating D1 database ${dbName}...`);
  const databaseId = await createD1(dbName, wranglerEnv).catch((err) => {
    console.error('Failed to create D1 database:', err.message);
    process.exit(1);
  });

  console.log('Preparing worker files...');
  await rm(workerDir, { recursive: true, force: true });
  await mkdir(workerDir, { recursive: true });
  await copyDir(join(__dirname, '..', 'templates', 'worker'), workerDir);

  const routeConfig = customDomain
    ? `\n[[routes]]\npattern = "${customDomain}"\ncustom_domain = true\n`
    : '';

  const multiTenantConfig = multiTenant
    ? `\n[vars]\nMULTI_TENANT = "true"\n`
    : '';

  await writeFile(
    join(workerDir, 'wrangler.toml'),
    `name = "${workerName}"
main = "src/index.ts"
compatibility_date = "2024-05-01"
${accountId ? `account_id = "${accountId}"\n` : ''}${routeConfig}${multiTenantConfig}
[[kv_namespaces]]
binding = "TOSS_KV"
id = "${kvId}"

[[d1_databases]]
binding = "TOSS_DB"
database_name = "${dbName}"
database_id = "${databaseId}"
`
  );

  console.log('Verifying workers.dev subdomain...');
  let workersDevSubdomain = '';
  try {
    if (apiToken && accountId) {
      workersDevSubdomain = (await getWorkersDevSubdomain(accountId, apiToken)) || '';
    } else {
      const { stdout: whoami } = await execAsync('wrangler whoami');
      const accountMatch = whoami.match(/([a-f0-9]{32})/);
      const token = await getWranglerToken();
      if (accountMatch && token) {
        workersDevSubdomain = (await getWorkersDevSubdomain(accountMatch[1], token)) || '';
      }
    }
  } catch {}

  if (!workersDevSubdomain) {
    console.error('\n❌ No workers.dev subdomain found.');
    console.error('You need to register one before deploying.');
    console.error('');
    console.error('Two options:');
    console.error('  1. Visit https://dash.cloudflare.com/workers/onboarding');
    console.error('  2. Or run: wrangler subdomain <name>');
    console.error('');
    process.exit(1);
  }

  // Worker secrets persist across deploys, so reuse them — re-minting JWT_SECRET
  // would invalidate every signed link. Decide by existence (secret list shows
  // names only, never values); local config is the source of truth + backup.
  //
  // Resolve + validate the signing key BEFORE `wrangler deploy` so we never
  // promote hardened code with a weak/missing JWT_SECRET. cloudflareSecretExists
  // and resolveSecret have no ordering dependency on the deploy, so they move up
  // safely; the actual `setSecret` writes stay after deploy (they push to the
  // live worker).
  let ownerToken = '';
  let jwtForConfig: string | undefined = profileConfig?.jwtSecret || undefined;
  let owner!: ReturnType<typeof resolveSecret>;
  let jwt!: ReturnType<typeof resolveSecret>;
  try {
    const ownerExists = await cloudflareSecretExists(workerDir, 'OWNER_TOKEN', wranglerEnvBase);
    const jwtExists = await cloudflareSecretExists(workerDir, 'JWT_SECRET', wranglerEnvBase);
    owner = resolveSecret(profileConfig?.token, ownerExists, generateToken, { mustHaveValue: true });
    jwt = resolveSecret(profileConfig?.jwtSecret, jwtExists, generateToken);
    // Validate EVERY locally known secret (first-deploy write:true AND reused
    // write:false), not just ones being written — a reused weak local secret
    // must fail the deploy too.
    //
    // Sealed-backend case: resolveSecret returns { value: undefined, write:false,
    // known:false } when the secret exists on the worker but the local value is
    // unknown. Strength can't be verified at deploy, so we do NOT throw; the
    // runtime passwordSessionSecretUsable guard is the backstop (a protected
    // share fails closed with 500 if that worker secret is weak/missing).
    if (jwt.known && jwt.value) assertStrongJwtSecret(jwt.value);
    ownerToken = owner.value as string;
    if (jwt.known) jwtForConfig = jwt.value;
  } catch (err: any) {
    console.error('Failed to resolve secrets:', err.message);
    process.exit(1);
  }

  console.log('Deploying worker...');
  try {
    await execAsync('wrangler deploy', { cwd: workerDir });
  } catch (err: any) {
    console.error('Deploy failed:', err.stderr || err.message);
    process.exit(1);
  }

  const workerUrl = customDomain
    ? `https://${customDomain}`
    : `https://${workerName}.${workersDevSubdomain}.workers.dev`;

  console.log('Setting secrets...');
  try {
    if (owner.write && owner.value) await setSecret(workerDir, 'OWNER_TOKEN', owner.value);
    if (jwt.write && jwt.value) {
      // Defense in depth: re-validate immediately before writing the signing key.
      assertStrongJwtSecret(jwt.value);
      await setSecret(workerDir, 'JWT_SECRET', jwt.value);
    }
  } catch (err: any) {
    console.error('Failed to set secrets:', err.message);
    process.exit(1);
  }

  console.log('Running database migration...');
  try {
    await execAsync(`wrangler d1 migrations apply ${dbName} --remote`, { cwd: workerDir });
  } catch (err: any) {
    console.error('Migration failed:', err.stderr || err.message);
    process.exit(1);
  }

  await saveConfig(
    {
      endpoint: workerUrl,
      token: ownerToken,
      jwtSecret: jwtForConfig,
      subdomain,
      role: 'owner',
      backend: 'cloudflare',
      kvId,
      accountId,
      apiToken,
    },
    profileName
  );

  // Note: we intentionally do NOT switch the active profile here. Deploying a
  // profile shouldn't hijack what bare `toss …` commands target — switch
  // explicitly with `toss profile switch` when you mean to.
  console.log('\n✅ Your toss is ready.');
  console.log(`   Endpoint: ${workerUrl}`);
  if (multiTenant) {
    console.log(`   Mode:     Multi-tenant team service`);
    console.log(`   Admin:    toss admin token create --label "teammate"`);
  }
  console.log(`   Upload:   toss ./file.html`);
  console.log(`   Manage:   toss list`);
}
