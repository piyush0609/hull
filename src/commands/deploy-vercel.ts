import { mkdir, rm, readdir, copyFile, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { saveConfig, loadConfig, listProfiles, switchProfile } from '../lib/config.js';
import { prompt, promptConfirm, promptSelect } from '../lib/prompt.js';
import { deriveDeploymentSuffix, getVercelProjectName } from '../lib/deployment-target.js';
import { extractVercelStorageEnv } from '../lib/vercel-env.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const { stdout, stderr } = await execAsync(
    cmd,
    cwd ? { cwd, maxBuffer: 10 * 1024 * 1024 } : { maxBuffer: 10 * 1024 * 1024 }
  );
  return stdout + '\n' + (stderr || '');
}

async function setVercelEnv(cwd: string, name: string, value: string): Promise<void> {
  const environments = ['production', 'development'];
  for (const env of environments) {
    try {
      await execAsync(`vercel env rm ${name} ${env} --yes --non-interactive`, { cwd });
    } catch {
      // Ignore if it doesn't exist.
    }
    await execAsync(
      `printf "%s\\n" "${value.replace(/"/g, '\\"')}" | vercel env add ${name} ${env} --non-interactive`,
      { cwd }
    );
  }
}

async function pullVercelStorageEnv(cwd: string): Promise<{ databaseUrl?: string; blobToken?: string }> {
  try {
    await vercelExec('vercel env pull --yes --non-interactive', cwd);
    const envContent = await readFile(join(cwd, '.env.local'), 'utf-8');
    return extractVercelStorageEnv(envContent);
  } catch {
    return {};
  }
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
}) {
  console.log('Setting up your toss on Vercel...\n');

  try {
    const out = await vercelExec('vercel --version');
    console.log(`✅ Vercel CLI ${out.trim()}`);
  } catch {
    console.error('❌ Vercel CLI not found. Install it: npm i -g vercel');
    process.exit(1);
  }

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

  let profileConfig = null;
  if (profileName) {
    profileConfig = await loadConfig(profileName);
  }

  let multiTenant = options.multiTenant;
  if (multiTenant === undefined && process.stdin.isTTY && !options.yes) {
    const mode = await promptSelect('Deployment mode:', [
      { label: 'Single-user (personal use)', value: 'single' as const },
      { label: 'Multi-tenant team (shared with teammates)', value: 'team' as const },
    ]);
    multiTenant = mode === 'team';
    console.log();
  }

  const subdomain =
    options.subdomain ||
    process.env.TOSS_SUBDOMAIN ||
    deriveDeploymentSuffix(profileName, profileConfig?.subdomain);
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    console.error('Error: Suffix must be lowercase alphanumeric with hyphens only.');
    process.exit(1);
  }
  console.log(`Using project suffix: ${subdomain}`);

  const earlyConfig =
    (await loadConfig(profileName)) || {
      endpoint: '',
      token: '',
      subdomain,
      role: 'owner' as const,
      backend: 'vercel' as const,
    };
  earlyConfig.subdomain = subdomain;
  earlyConfig.role = 'owner';
  earlyConfig.backend = 'vercel';
  await saveConfig(earlyConfig, profileName);

  const customDomain = options.domain || process.env.TOSS_DOMAIN || undefined;
  if (customDomain && !/^[a-z0-9][a-z0-9-]*\.[a-z]{2,}(\.[a-z]{2,})?$/i.test(customDomain)) {
    console.error('Error: Invalid domain format.');
    process.exit(1);
  }

  const projectName = getVercelProjectName(subdomain);
  const deployDir = join(process.env.HOME || process.env.USERPROFILE || '.', '.toss', 'vercel', projectName);
  const ownerToken = generateToken();
  const jwtSecret = generateToken();

  console.log('Preparing project files...');
  await rm(deployDir, { recursive: true, force: true });
  await mkdir(deployDir, { recursive: true });
  await copyDir(join(__dirname, '..', 'templates', 'vercel'), deployDir);

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

  await vercelExec(`vercel link --project ${projectName} --yes --non-interactive`, deployDir);

  let projectId: string | null = null;
  try {
    const projectJson = await readFile(join(deployDir, '.vercel', 'project.json'), 'utf-8');
    const parsed = JSON.parse(projectJson);
    projectId = parsed.projectId || null;
  } catch {}

  if (projectId) {
    const token = await getVercelToken();
    if (token) {
      console.log('Disabling SSO protection...');
      await disableSSOProtection(projectId, token);
    }
  }

  console.log('Setting secrets...');
  await setVercelEnv(deployDir, 'JWT_SECRET', jwtSecret);
  await setVercelEnv(deployDir, 'OWNER_TOKEN', ownerToken);
  if (multiTenant) {
    await setVercelEnv(deployDir, 'MULTI_TENANT', 'true');
  }

  const existingStorageEnv = await pullVercelStorageEnv(deployDir);

  let databaseUrl =
    options.postgresUrl ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    existingStorageEnv.databaseUrl ||
    '';
  if (databaseUrl && !options.postgresUrl && !process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    console.log('✅ Reusing existing Postgres database from project environment.');
  }
  if (!databaseUrl) {
    console.log('Provisioning Neon Postgres database...');
    try {
      await vercelExec('vercel integration add neon --non-interactive', deployDir);
      const storageEnv = await pullVercelStorageEnv(deployDir);
      if (storageEnv.databaseUrl) {
        databaseUrl = storageEnv.databaseUrl;
        await setVercelEnv(deployDir, 'DATABASE_URL', databaseUrl);
        console.log('✅ Postgres database provisioned and linked.');
      } else {
        console.warn('Warning: Could not read DATABASE_URL from provisioned Neon database.');
      }
    } catch (err: any) {
      const msg = err.stderr || err.message || '';
      if (msg.includes('terms_acceptance_required')) {
        console.warn('⚠️  Neon marketplace terms not accepted. Accept them at:');
        console.warn('   https://vercel.com/dashboard/integrations/neon');
      } else {
        console.warn('Warning: Could not provision Neon:', msg);
      }

      const storageEnv = await pullVercelStorageEnv(deployDir);
      if (storageEnv.databaseUrl) {
        databaseUrl = storageEnv.databaseUrl;
        await setVercelEnv(deployDir, 'DATABASE_URL', databaseUrl);
        console.log('✅ Reusing existing Postgres database linked to the project.');
      }
    }
  } else {
    await setVercelEnv(deployDir, 'DATABASE_URL', databaseUrl);
  }

  let blobToken =
    options.blobToken || process.env.BLOB_READ_WRITE_TOKEN || existingStorageEnv.blobToken || '';
  let blobStoreUrl = '';
  if (blobToken && !options.blobToken && !process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('✅ Reusing existing Blob store from project environment.');
  }
  if (!blobToken) {
    console.log('Provisioning Vercel Blob store...');
    try {
      const out = await vercelExec(
        `vercel blob create-store ${projectName}-blob --access private --yes --non-interactive`,
        deployDir
      );
      const idMatch = out.match(/store_[a-zA-Z0-9]+/);
      const storeId = idMatch ? idMatch[0] : '';
      if (storeId) {
        blobStoreUrl = `https://vercel.com/dashboard/stores/blob/${storeId}`;
        console.log(`✅ Blob store created: ${storeId}`);
      }
      const storageEnv = await pullVercelStorageEnv(deployDir);
      if (storageEnv.blobToken) {
        blobToken = storageEnv.blobToken;
        console.log('✅ Blob store linked to project.');
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
      const storageEnv = await pullVercelStorageEnv(deployDir);
      if (storageEnv.blobToken) {
        blobToken = storageEnv.blobToken;
        console.log('✅ Reusing existing Blob store linked to the project.');
      }
    }
  } else {
    await setVercelEnv(deployDir, 'BLOB_READ_WRITE_TOKEN', blobToken);
  }

  console.log('Deploying to Vercel...');
  let deployOutput: string;
  try {
    deployOutput = await vercelExec('vercel deploy --prod --yes --non-interactive --force', deployDir);
  } catch (err: any) {
    console.error('Deploy failed:', err.stderr || err.message);
    process.exit(1);
  }

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

  const hasDatabase = !!databaseUrl;
  const hasBlob = !!blobToken;

  if (!hasDatabase || !hasBlob) {
    console.log('\n📦 Storage Setup Required');
    console.log('=========================');
    if (!hasDatabase) {
      console.log('❌ DATABASE_URL not available.');
      console.log('   Run: vercel integration add neon --non-interactive');
      console.log('   Or accept terms at: https://vercel.com/integrations/neon');
      console.log('');
    }
    if (!hasBlob) {
      console.log('❌ BLOB_READ_WRITE_TOKEN not available.');
      if (blobStoreUrl) {
        console.log('   Copy the token from your Blob store dashboard:');
        console.log(`   ${blobStoreUrl}`);
      } else {
        console.log('   Create a Blob store at: https://vercel.com/dashboard');
        console.log('   → Storage → Create Store → Blob');
      }
      console.log('   Then re-deploy with: --blob-token <token>');
      console.log('');
    }
  }

  if (hasDatabase) {
    console.log('Running database migrations...');
    try {
      await execAsync('npm install --no-package-lock --silent', { cwd: deployDir });
      await execAsync('node migrate.js', {
        cwd: deployDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      });
    } catch (err: any) {
      console.error('Migration failed:', err.stderr || err.message);
      console.log('  You may need to apply migrations manually.');
    }
  }

  const endpoint = customDomain ? `https://${customDomain}` : projectUrl;
  await saveConfig(
    {
      endpoint,
      token: ownerToken,
      subdomain,
      role: 'owner',
      backend: 'vercel',
      vercelProjectId: projectId || undefined,
    },
    profileName
  );

  if (profileName) {
    await switchProfile(profileName);
  }

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
    console.log('   Upload:   toss ./file.html');
  } else {
    console.log('   ⚠️  Configure storage before uploading files.');
  }
  console.log('   Manage:   toss list');
}
