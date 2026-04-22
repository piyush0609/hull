import { mkdir, writeFile, rm, readdir, copyFile, readFile } from 'fs/promises';
import { join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { saveConfig } from '../lib/config.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
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

async function wranglerJSON(cmd: string): Promise<string> {
  const { stdout } = await execAsync(cmd);
  return stdout;
}

async function createKV(title: string): Promise<string> {
  try {
    const out = await wranglerJSON(`wrangler kv namespace create "${title}"`);
    const m = out.match(/"id":\s*"([a-f0-9]+)"/) || out.match(/([a-f0-9]{32})/);
    if (m) return m[1];
  } catch (err: any) {
    if (!err.stderr?.includes('already exists')) throw err;
    const out = await wranglerJSON('wrangler kv namespace list');
    const m = out.match(new RegExp(`"id"\\s*:\\s*"([a-f0-9]{32})".*"title"\\s*:\\s*"${title}"`, 's'));
    if (m) return m[1];
  }
  throw new Error('Could not create or find KV namespace');
}

async function createD1(name: string): Promise<string> {
  try {
    const out = await wranglerJSON(`wrangler d1 create ${name}`);
    const m = out.match(/"database_id":\s*"([a-f0-9-]+)"/) || out.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    if (m) return m[1];
  } catch (err: any) {
    if (!err.stderr?.includes('already exists')) throw err;
    const out = await wranglerJSON('wrangler d1 list');
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

export async function deployCommand() {
  console.log('Setting up your hull on Cloudflare...\n');

  // Check wrangler — offer to install if missing
  let wranglerVersion = '';
  try {
    const { stdout } = await execAsync('wrangler --version');
    wranglerVersion = stdout.trim();
  } catch {
    const answer = await prompt('Wrangler not found. Install now? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.error('Please install Wrangler: npm install -g wrangler');
      process.exit(1);
    }
    console.log('Installing wrangler...');
    try {
      await execAsync('npm install -g wrangler');
      const { stdout } = await execAsync('wrangler --version');
      wranglerVersion = stdout.trim();
      console.log(`✓ Wrangler ${wranglerVersion} installed`);
    } catch (err: any) {
      console.error('Failed to install wrangler:', err.stderr || err.message);
      process.exit(1);
    }
  }

  // Check auth — run login if needed
  let authOk = false;
  try {
    await execAsync('wrangler whoami');
    authOk = true;
  } catch {
    console.log('Not authenticated with Cloudflare.');
    const answer = await prompt('Run wrangler login now? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.error('Please run: wrangler login');
      process.exit(1);
    }
    console.log('Opening browser for Cloudflare login...');
    console.log('(Scopes: account:read, workers_scripts:write, workers_kv:write, d1:write, zone:read)');
    try {
      await execAsync('wrangler login --scopes account:read workers_scripts:write workers_kv:write d1:write zone:read');
      authOk = true;
    } catch (err: any) {
      console.error('Login failed:', err.stderr || err.message);
      process.exit(1);
    }
  }

  const subdomain = process.env.HULL_SUBDOMAIN || await prompt('Choose a subdomain (e.g., yourname): ');
  if (!subdomain || !/^[a-z0-9-]+$/.test(subdomain)) {
    console.error('Error: Subdomain must be lowercase alphanumeric with hyphens only.');
    process.exit(1);
  }

  const workerName = `hull-${subdomain}`;
  const dbName = `hull-db-${subdomain}`;
  const kvTitle = `hull-kv-${subdomain}`;
  const workerDir = join(process.env.HOME || process.env.USERPROFILE || '.', '.hull', 'worker');
  const ownerToken = generateToken();
  const jwtSecret = generateToken();

  console.log(`Creating KV namespace ${kvTitle}...`);
  const kvId = await createKV(kvTitle).catch((err) => {
    console.error('Failed to create KV namespace:', err.message);
    process.exit(1);
  });

  console.log(`Creating D1 database ${dbName}...`);
  const databaseId = await createD1(dbName).catch((err) => {
    console.error('Failed to create D1 database:', err.message);
    process.exit(1);
  });

  console.log('Preparing worker files...');
  await rm(workerDir, { recursive: true, force: true });
  await mkdir(workerDir, { recursive: true });
  await copyDir(join(__dirname, '..', 'templates', 'worker'), workerDir);

  await writeFile(
    join(workerDir, 'wrangler.toml'),
    `name = "${workerName}"
main = "src/index.ts"
compatibility_date = "2024-05-01"

[[kv_namespaces]]
binding = "HULL_KV"
id = "${kvId}"

[[d1_databases]]
binding = "HULL_DB"
database_name = "${dbName}"
database_id = "${databaseId}"
`
  );

  console.log('Verifying workers.dev subdomain...');
  let workersDevSubdomain = '';
  try {
    const { stdout: whoami } = await execAsync('wrangler whoami');
    const accountMatch = whoami.match(/([a-f0-9]{32})/);
    const token = await getWranglerToken();
    if (accountMatch && token) {
      workersDevSubdomain = (await getWorkersDevSubdomain(accountMatch[1], token)) || '';
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

  console.log('Deploying worker...');
  try {
    await execAsync('wrangler deploy', { cwd: workerDir });
  } catch (err: any) {
    console.error('Deploy failed:', err.stderr || err.message);
    process.exit(1);
  }

  const workerUrl = `https://${workerName}.${workersDevSubdomain}.workers.dev`;

  console.log('Setting secrets...');
  try {
    await setSecret(workerDir, 'OWNER_TOKEN', ownerToken);
    await setSecret(workerDir, 'JWT_SECRET', jwtSecret);
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

  await saveConfig({ endpoint: workerUrl, ownerToken, subdomain, kvId });

  console.log('\n✅ Your hull is ready.');
  console.log(`   Endpoint: ${workerUrl}`);
  console.log(`   Upload:   hull share ./file.html --expires 24h`);
  console.log(`   Manage:   hull list`);
}
