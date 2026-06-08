import { mkdir, writeFile, rm, readdir, copyFile, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { saveConfig, loadConfig, listProfiles } from '../lib/config.js';
import { prompt, promptConfirm, promptSelect } from '../lib/prompt.js';
import { resolveSecret } from '../lib/deploy-secrets.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

function deriveDeploymentSuffix(profileName?: string, savedSubdomain?: string): string {
  if (savedSubdomain) return savedSubdomain;
  if (!profileName || profileName === 'default' || profileName === 'owner') return 'toss';
  return profileName.toLowerCase().replace(/_/g, '-');
}

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isVercelAppEndpoint(endpoint: string | undefined | null): boolean {
  if (!endpoint) return false;
  try { return new URL(endpoint).hostname.endsWith('.vercel.app'); } catch { return false; }
}

// Endpoint to persist for the profile. An explicit --domain wins; otherwise KEEP an
// existing custom-domain endpoint so a redeploy never clobbers e.g.
// https://share.example.com with the throwaway per-deploy *.vercel.app URL; only fall
// back to the deploy URL when there is no custom domain yet (first deploy).
export function chooseEndpoint(
  customDomain: string | undefined,
  existingEndpoint: string | undefined | null,
  deploymentUrl: string
): string {
  if (customDomain) return `https://${customDomain}`;
  if (existingEndpoint && !isVercelAppEndpoint(existingEndpoint)) return existingEndpoint;
  return deploymentUrl;
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

async function vercelExec(cmd: string, cwd?: string): Promise<string> {
  const { stdout, stderr } = await execAsync(cmd, cwd ? { cwd, maxBuffer: 10 * 1024 * 1024 } : { maxBuffer: 10 * 1024 * 1024 });
  return stdout + '\n' + (stderr || '');
}

// Build argv for `vercel env add`. Pure + exported for testing.
//
// Vercel CLI 52+ defaults Production/Preview variables to *sensitive*, which
// makes them unreadable by `vercel env pull` — that broke secret reuse
// (resolveSecret) and, with the previous stdin approach, silently stored empty
// values (and dropped MULTI_TENANT). The flags fix each failure mode:
//   --value         pass the value as a discrete argv element (no shell
//                   parsing, no injection, no trailing-newline corruption)
//   --no-sensitive  keep the var readable so a later deploy can reuse it
//   --force         overwrite an existing var in place (no separate `env rm`)
//   --yes           skip the add-confirmation prompt
//   --non-interactive  never prompt (e.g. the --force overwrite confirmation);
//                   without it `env add` blocks on stdin forever under spawn
export function buildVercelEnvAddArgs(name: string, env: string, value: string): string[] {
  return ['env', 'add', name, env, '--value', value, '--no-sensitive', '--force', '--yes', '--non-interactive'];
}

async function setVercelEnv(cwd: string, name: string, value: string): Promise<void> {
  // Only Production is consumed by `vercel deploy --prod`; Development is for
  // `vercel dev` (which toss never runs), so we write Production only. spawn (no
  // shell) passes the value as a discrete arg — safe for secrets and Postgres
  // URLs with shell metacharacters — and stdin is closed ('ignore') so vercel can
  // never block waiting on a prompt.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('vercel', buildVercelEnvAddArgs(name, 'production', value), {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`vercel env add ${name} exited with code ${code}: ${stderr.trim()}`))
    );
  });
}

async function projectHasVercelEnv(cwd: string, name: string): Promise<boolean> {
  try {
    const envList = await vercelExec('vercel env ls --non-interactive', cwd);
    return envList.includes(name);
  } catch {
    return false;
  }
}

// Pull the PRODUCTION env — toss always deploys with `--prod`, so the live
// secrets and the production Neon branch URL live there. The development env can
// hold different secrets or a suspended/stale Neon branch (cause of failed
// migrations and accidental secret rotation).
async function pullVercelEnvFile(cwd: string): Promise<string | null> {
  try {
    await vercelExec('vercel env pull .env.local --environment=production --yes --non-interactive', cwd);
    return await readFile(join(cwd, '.env.local'), 'utf-8');
  } catch {
    return null;
  }
}

function readEnvVar(envContent: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quoted = envContent.match(new RegExp(`^${escaped}="([^"]*)"$`, 'm'));
  if (quoted) return quoted[1];
  const plain = envContent.match(new RegExp(`^${escaped}=(.+)$`, 'm'));
  return plain ? plain[1].trim() : null;
}

// Retry an async operation a few times. Neon serverless compute auto-suspends
// when idle and the first query after a cold start can fail with "fetch failed";
// a couple of retries let the first attempt wake the compute for the next.
export async function retryAsync<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number }
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < opts.attempts - 1) await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }
  throw lastErr;
}

function extractDatabaseUrl(envContent: string): string | null {
  return readEnvVar(envContent, 'DATABASE_URL')
    || readEnvVar(envContent, 'POSTGRES_URL')
    || readEnvVar(envContent, 'POSTGRES_PRISMA_URL')
    || null;
}

async function getVercelToken(): Promise<string | null> {
  const paths = [
    join(homedir(), 'Library/Application Support/com.vercel.cli/auth.json'),
    join(homedir(), '.local/share/com.vercel.cli/auth.json'),
    join(homedir(), '.config/com.vercel.cli/auth.json'),
  ];
  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.token) return parsed.token;
    } catch {}
  }
  return null;
}

async function disableSSOProtection(projectId: string, token: string): Promise<void> {
  try {
    const res = await fetch(`https://api.vercel.com/v9/projects/${projectId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ssoProtection: null }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn('Warning: Could not disable SSO protection:', text);
    }
  } catch (err: any) {
    console.warn('Warning: Could not disable SSO protection:', err.message);
  }
}

export async function deployVercelCommand(options: {
  domain?: string;
  multiTenant?: boolean;
  profile?: string;
  subdomain?: string;
  yes?: boolean;
  postgresUrl?: string;
  blobToken?: string;
  skipMigrate?: boolean;
}) {
  console.log('Setting up your toss on Vercel...\n');

  // Check vercel CLI
  try {
    const out = await vercelExec('vercel --version');
    console.log(`✅ Vercel CLI ${out.trim()}`);
  } catch {
    console.error('❌ Vercel CLI not found. Install it: npm i -g vercel');
    process.exit(1);
  }

  // Check auth
  let vercelUser: string | null = null;
  try {
    const out = await vercelExec('vercel whoami');
    vercelUser = out.trim();
    console.log(`✅ Logged in as ${vercelUser}`);
  } catch {
    console.error('❌ Not logged in to Vercel. Run: vercel login');
    console.error('   This opens a browser for OAuth/GitHub authentication.');
    process.exit(1);
  }

  // Interactive profile selection
  let profileName = options.profile;
  if (!profileName && process.stdin.isTTY && !options.yes) {
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
    }
  }

  // Load the resolved config: the named profile, or the active/default profile
  // when none is named. Loading unconditionally means a previously saved
  // subdomain is honored even without an explicit --profile — otherwise a
  // redeploy resolves to a different project name and creates a new app.
  const profileConfig = await loadConfig(profileName);

  // Interactive deployment mode
  let multiTenant = options.multiTenant;
  if (multiTenant === undefined && process.stdin.isTTY && !options.yes) {
    const mode = await promptSelect('Deployment mode:', [
      { label: 'Single-user (personal use)', value: 'single' as const },
      { label: 'Multi-tenant team (shared with teammates)', value: 'team' as const },
    ]);
    multiTenant = mode === 'team';
    console.log();
  }

  // Stable service name comes from the profile by default.
  // Priority: explicit --subdomain → TOSS_SUBDOMAIN env → saved profile → derived default.
  const subdomain = options.subdomain
    || process.env.TOSS_SUBDOMAIN
    || deriveDeploymentSuffix(profileName, profileConfig?.subdomain);
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    console.error('Error: Suffix must be lowercase alphanumeric with hyphens only.');
    process.exit(1);
  }
  console.log(`Using project suffix: ${subdomain}`);

  // Save early
  const earlyConfig = await loadConfig(profileName) || { endpoint: '', token: '', subdomain, role: 'owner' as const, backend: 'vercel' as const };
  earlyConfig.subdomain = subdomain;
  earlyConfig.role = 'owner';
  earlyConfig.backend = 'vercel';
  await saveConfig(earlyConfig, profileName);

  // Custom domain
  const customDomain = options.domain || process.env.TOSS_DOMAIN || undefined;
  if (customDomain) {
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z]{2,}(\.[a-z]{2,})?$/i.test(customDomain)) {
      console.error('Error: Invalid domain format.');
      process.exit(1);
    }
  }

  const projectName = subdomain === 'toss' ? 'toss' : `toss-${subdomain}`;
  const deployDir = join(process.env.HOME || process.env.USERPROFILE || '.', '.toss', 'vercel', projectName);

  // Prepare project files
  console.log('Preparing project files...');
  await rm(deployDir, { recursive: true, force: true });
  await mkdir(deployDir, { recursive: true });
  await copyDir(join(__dirname, '..', 'templates', 'vercel'), deployDir);

  // Create or ensure project exists
  console.log(`Creating Vercel project "${projectName}"...`);
  try {
    await vercelExec(`vercel project add ${projectName} --non-interactive`);
  } catch (err: any) {
    const msg = err.stderr || err.message || '';
    if (!msg.includes('already exists')) {
      console.error('Failed to create project:', msg);
      process.exit(1);
    }
  }

  // Link project
  await vercelExec(`vercel link --project ${projectName} --yes --non-interactive`, deployDir);

  // Read project ID
  let projectId: string | null = null;
  try {
    const projectJson = await readFile(join(deployDir, '.vercel', 'project.json'), 'utf-8');
    const parsed = JSON.parse(projectJson);
    projectId = parsed.projectId || null;
  } catch {}

  // Disable SSO protection so shared links are publicly accessible
  if (projectId) {
    const token = await getVercelToken();
    if (token) {
      console.log('Disabling SSO protection...');
      await disableSSOProtection(projectId, token);
    }
  }

  // Secrets persist on the Vercel project across deploys, so a redeploy must not
  // re-mint them (rotating JWT_SECRET invalidates every signed link). Decide by
  // existence (by name) — never by reading the value back, since sensitive vars
  // read empty. Local config is the source of truth + migration backup.
  console.log('Setting secrets...');
  const jwtExists = await projectHasVercelEnv(deployDir, 'JWT_SECRET');
  const ownerExists = await projectHasVercelEnv(deployDir, 'OWNER_TOKEN');
  const jwt = resolveSecret(profileConfig?.jwtSecret, jwtExists, generateToken);
  const owner = resolveSecret(profileConfig?.token, ownerExists, generateToken, { mustHaveValue: true });
  const ownerToken = owner.value as string;
  if (jwt.write && jwt.value) await setVercelEnv(deployDir, 'JWT_SECRET', jwt.value);
  if (owner.write && owner.value) await setVercelEnv(deployDir, 'OWNER_TOKEN', owner.value);
  if (multiTenant) {
    await setVercelEnv(deployDir, 'MULTI_TENANT', 'true');
  }

  // Auto-provision Neon Postgres if not provided
  let databaseUrl = options.postgresUrl || process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!databaseUrl) {
    console.log('Provisioning Neon Postgres database...');
    try {
      await vercelExec('vercel integration add neon --non-interactive', deployDir);
      const envContent = await pullVercelEnvFile(deployDir);
      if (envContent) {
        const extracted = extractDatabaseUrl(envContent);
        if (extracted) {
          databaseUrl = extracted;
          await setVercelEnv(deployDir, 'DATABASE_URL', databaseUrl);
          console.log('✅ Postgres database provisioned and linked.');
        } else {
          console.warn('Warning: Could not read DATABASE_URL or POSTGRES_URL from provisioned Neon database.');
        }
      } else {
        console.warn('Warning: Could not pull environment variables from provisioned Neon database.');
      }
    } catch (err: any) {
      const msg = err.stderr || err.message || '';
      if (msg.includes('terms_acceptance_required')) {
        console.warn('⚠️  Neon marketplace terms not accepted. Accept them at:');
        console.warn('   https://vercel.com/dashboard/integrations/neon');
      } else {
        const envContent = await pullVercelEnvFile(deployDir);
        const extracted = envContent ? extractDatabaseUrl(envContent) : null;
        if (extracted) {
          databaseUrl = extracted;
          await setVercelEnv(deployDir, 'DATABASE_URL', databaseUrl);
          console.log('✅ Postgres database already linked to project.');
        } else {
          console.warn('Warning: Could not provision Neon:', msg);
        }
      }
    }
  } else {
    await setVercelEnv(deployDir, 'DATABASE_URL', databaseUrl);
  }

  // Auto-provision Vercel Blob store if not provided
  let blobToken = options.blobToken || process.env.BLOB_READ_WRITE_TOKEN || '';
  let blobStoreUrl = '';
  if (!blobToken) {
    // Check if project already has a BLOB_READ_WRITE_TOKEN
    if (await projectHasVercelEnv(deployDir, 'BLOB_READ_WRITE_TOKEN')) {
      console.log('✅ Blob store already connected to project.');
      blobToken = 'existing';
    }
  }
  if (!blobToken) {
    console.log('Provisioning Vercel Blob store...');
    try {
      const out = await vercelExec(`vercel blob create-store ${projectName}-blob --access private --yes --non-interactive`, deployDir);
      // Extract store ID from output
      const idMatch = out.match(/store_[a-zA-Z0-9]+/);
      const storeId = idMatch ? idMatch[0] : '';
      if (storeId) {
        blobStoreUrl = `https://vercel.com/dashboard/stores/blob/${storeId}`;
        console.log(`✅ Blob store created: ${storeId}`);
      }
    } catch (err: any) {
      const msg = err.stderr || err.message || '';
      if (msg.includes('max_store_count_reached')) {
        console.warn('⚠️  Max Blob stores reached. Delete unused stores or reuse one.');
      } else if (msg.includes('already exists')) {
        console.warn('⚠️  Blob store already exists.');
      } else {
        console.warn('Warning: Could not provision Blob store:', msg);
      }
    }

    // Re-check project env after store creation. Vercel often auto-injects
    // BLOB_READ_WRITE_TOKEN even though we do not know the token value locally.
    if (await projectHasVercelEnv(deployDir, 'BLOB_READ_WRITE_TOKEN')) {
      console.log('✅ Blob token detected in project environment.');
      blobToken = 'existing';
    }
  } else if (blobToken !== 'existing') {
    await setVercelEnv(deployDir, 'BLOB_READ_WRITE_TOKEN', blobToken);
  }

  // Migrate BEFORE promoting code. The new code can require new columns, so a failed
  // (or skipped) migration must block the deploy — otherwise we promote code that 500s
  // against an un-migrated schema. Migrations are additive + idempotent, so applying
  // them while the previous deploy is still live is safe.
  const skipMigrate = options.skipMigrate || process.env.TOSS_SKIP_MIGRATE === '1';
  if (databaseUrl && !skipMigrate) {
    console.log('Running database migrations (before deploy)...');
    try {
      await execAsync('npm install --no-package-lock --silent', { cwd: deployDir });
      // Idempotent + retried: the first attempt wakes a cold (auto-suspended) Neon
      // compute so a later attempt connects.
      await retryAsync(
        () => execAsync('node migrate.js', {
          cwd: deployDir,
          env: { ...process.env, DATABASE_URL: databaseUrl },
        }),
        { attempts: 4, delayMs: 2500 }
      );
      console.log('✅ Migrations applied.');
    } catch (err: any) {
      console.error('❌ Migration failed:', err.stderr || err.message);
      console.error('   Deploy aborted — new code was NOT promoted, so production is unchanged.');
      console.error('   Fix the migration (or apply it manually), then re-deploy.');
      console.error('   If the schema is already applied (or this machine cannot reach the DB),');
      console.error('   re-run with --skip-migrate (or TOSS_SKIP_MIGRATE=1).');
      process.exit(1);
    }
  } else if (databaseUrl && skipMigrate) {
    console.warn('⚠️  Skipping migrations (--skip-migrate / TOSS_SKIP_MIGRATE). Ensure the schema is already applied, or the new code may fail.');
  }

  // Deploy
  console.log('Deploying to Vercel...');
  let deployOutput: string;
  try {
    deployOutput = await vercelExec('vercel deploy --prod --yes --non-interactive --force', deployDir);
  } catch (err: any) {
    console.error('Deploy failed:', err.stderr || err.message);
    process.exit(1);
  }

  // Parse deployment URL from JSON output (last line)
  let projectUrl: string | null = null;
  const lines = deployOutput.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        const parsed = JSON.parse(line);
        projectUrl = parsed.deployment?.url || null;
      } catch {}
      if (projectUrl) break;
    }
  }
  if (!projectUrl) {
    const match = deployOutput.match(/Production:\s*(https:\/\/[^\s]+)/);
    if (match) projectUrl = match[1];
  }

  if (!projectUrl) {
    console.error('Deploy succeeded but could not extract URL.');
    process.exit(1);
  }

  // Add custom domain
  if (customDomain) {
    console.log(`Adding custom domain ${customDomain}...`);
    try {
      await vercelExec(`vercel domains add ${customDomain} --yes --non-interactive`, deployDir);
      console.log(`✅ Custom domain configured: ${customDomain}`);
    } catch (err: any) {
      const msg = err.stderr || err.message || '';
      if (!msg.includes('already exists') && !msg.includes('in use')) {
        console.warn('Warning: Could not add custom domain:', msg);
      }
    }
  }

  // Promote the just-deployed production deployment to "current" so the project's
  // production domains — including a pinned custom domain that does NOT auto-follow
  // `vercel deploy --prod` — actually serve this build. Non-fatal: the deploy already
  // succeeded, so a promote hiccup must not abort; surface the manual command instead.
  console.log('Promoting to current production...');
  try {
    await vercelExec(`vercel promote ${projectUrl}`, deployDir);
    console.log('✅ Promoted — production domains now serve this deployment.');
  } catch (err: any) {
    console.warn('⚠️  Could not auto-promote to current production:', err.stderr || err.message);
    console.warn(`   Run manually (linked to the project): vercel promote ${projectUrl}`);
  }

  // Check storage status
  const hasDatabase = !!databaseUrl;
  const hasBlob = !!blobToken;

  if (!hasDatabase || !hasBlob) {
    console.log('\n📦 Storage Setup Required');
    console.log('=========================');
    if (!hasDatabase) {
      console.log('❌ DATABASE_URL not available.');
      console.log('   Run: vercel integration add neon --non-interactive');
      console.log('   Or accept terms at: https://vercel.com/integrations/neon');
      console.log('   If this project already has Postgres env vars, re-run with: --postgres-url <POSTGRES_URL>');
      console.log('');
    }
    if (!hasBlob) {
      console.log('❌ BLOB_READ_WRITE_TOKEN not available.');
      if (blobStoreUrl) {
        console.log(`   Copy the token from your Blob store dashboard:`);
        console.log(`   ${blobStoreUrl}`);
      } else {
        console.log(`   Create a Blob store at: https://vercel.com/dashboard`);
        console.log(`   → Storage → Create Store → Blob`);
      }
      console.log('   Then re-deploy with: --blob-token <token>');
      console.log('');
    }
  }

  // (Migrations already ran before the deploy above — fail-loud, so reaching this
  // point means the schema is applied.)

  // Save config. Preserve an existing custom-domain endpoint (e.g. share.example.com)
  // — a redeploy must not overwrite it with the throwaway per-deploy *.vercel.app URL.
  const endpoint = chooseEndpoint(customDomain, profileConfig?.endpoint, projectUrl);
  await saveConfig(
    {
      endpoint,
      token: ownerToken,
      jwtSecret: jwt.known ? jwt.value : profileConfig?.jwtSecret,
      subdomain,
      role: 'owner',
      backend: 'vercel',
      vercelProjectId: projectId || undefined,
    },
    profileName
  );

  // Note: we intentionally do NOT switch the active profile here. Deploying a
  // profile shouldn't hijack what bare `toss …` commands target — switch
  // explicitly with `toss profile switch` when you mean to.
  console.log('\n✅ Your toss project is deployed.');
  console.log(`   Project:  ${projectName}`);
  console.log(`   URL:      ${projectUrl}`);
  if (customDomain) {
    console.log(`   Domain:   https://${customDomain}`);
    console.log('   DNS:      Add this CNAME in Route53:');
    console.log(`             ${customDomain.split('.')[0]}  CNAME  cname.vercel-dns.com`);
  }
  console.log(`   Mode:     ${multiTenant ? 'Multi-tenant team' : 'Single-user'}`);
  if (hasDatabase && hasBlob) {
    console.log(`   Upload:   toss ./file.html`);
  } else {
    console.log('   ⚠️  Configure storage before uploading files.');
  }
  console.log(`   Manage:   toss list`);
}
