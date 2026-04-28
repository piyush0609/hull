import { exec } from 'child_process';
import { promisify } from 'util';
import { prompt, promptConfirm } from '../lib/prompt.js';
import { loadConfig, saveConfig, switchProfile } from '../lib/config.js';

const execAsync = promisify(exec);

export async function setupVercelCommand(options: { profile?: string; subdomain?: string; yes?: boolean } = {}) {
  const profileName = options.profile;
  const presetSubdomain = options.subdomain;
  const autoYes = options.yes || !process.stdin.isTTY;

  if (profileName) {
    console.log(`Toss Setup — Vercel — Profile: ${profileName}\n==========\n`);
    const existing = await loadConfig(profileName);
    if (existing) {
      console.log(`Profile "${profileName}" already exists with endpoint: ${existing.endpoint}`);
      if (!autoYes) {
        const reauth = await promptConfirm('Re-configure auth for this profile?', true);
        if (!reauth) {
          console.log('Setup cancelled. Profile auth unchanged.');
          return;
        }
      }
    }
  } else {
    console.log('Toss Setup — Vercel\n==========\n');
  }

  // Subdomain
  let subdomain = presetSubdomain;
  if (!subdomain && process.stdin.isTTY && !autoYes) {
    subdomain = await prompt('Choose a project suffix (e.g., rf, share, team): ');
    if (subdomain && !/^[a-z0-9-]+$/.test(subdomain)) {
      console.error('Error: Suffix must be lowercase alphanumeric with hyphens only.');
      process.exit(1);
    }
  }
  if (subdomain && !/^[a-z0-9-]+$/.test(subdomain)) {
    console.error('Error: Suffix must be lowercase alphanumeric with hyphens only.');
    process.exit(1);
  }

  // Check Node.js
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (nodeMajor < 18) {
    console.error(`❌ Node.js 18+ required. Found: ${nodeVersion}`);
    process.exit(1);
  }
  console.log(`✅ Node.js ${nodeVersion}`);

  // Check / install Vercel CLI
  let vercelVersion = '';
  try {
    const { stdout } = await execAsync('vercel --version');
    vercelVersion = stdout.trim();
    console.log(`✅ Vercel CLI ${vercelVersion}`);
  } catch {
    console.log('❌ Vercel CLI not found.');
    const answer = autoYes ? 'y' : await prompt('Install Vercel CLI now? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.error('Please install: npm install -g vercel');
      process.exit(1);
    }
    console.log('Installing Vercel CLI...');
    try {
      await execAsync('npm install -g vercel');
      const { stdout } = await execAsync('vercel --version');
      vercelVersion = stdout.trim();
      console.log(`✅ Vercel CLI ${vercelVersion} installed`);
    } catch (err: any) {
      console.error('Failed to install Vercel CLI:', err.stderr || err.message);
      process.exit(1);
    }
  }

  // Check auth
  let authOk = false;
  try {
    const { stdout } = await execAsync('vercel whoami');
    if (stdout.trim()) {
      console.log(`✅ Authenticated as ${stdout.trim()}`);
      authOk = true;
    }
  } catch {}

  if (!authOk) {
    console.log('\n🔑 Vercel Login');
    console.log('================');
    console.log('You need to log in to Vercel.');
    console.log('This will open a browser for authentication.');
    console.log('');
    if (!autoYes) {
      const go = await promptConfirm('Proceed with login?', true);
      if (!go) {
        console.error('Login cancelled.');
        process.exit(1);
      }
    }
    try {
      await execAsync('vercel login');
      const { stdout } = await execAsync('vercel whoami');
      console.log(`✅ Authenticated as ${stdout.trim()}`);
      authOk = true;
    } catch (err: any) {
      console.error('Login failed:', err.stderr || err.message);
      process.exit(1);
    }
  }

  // Save profile
  if (profileName) {
    const existingConfig = await loadConfig(profileName);
    const config = existingConfig || { endpoint: '', ownerToken: '', subdomain: '' };
    config.backend = 'vercel';
    if (subdomain) config.subdomain = subdomain;
    await saveConfig(config, profileName);
    await switchProfile(profileName);
    console.log(`\n✅ Profile "${profileName}" configured for Vercel.`);
    console.log(`   Next: toss deploy --backend vercel --profile ${profileName}`);
  } else {
    const config = await loadConfig() || { endpoint: '', ownerToken: '', subdomain: '' };
    config.backend = 'vercel';
    if (subdomain) config.subdomain = subdomain;
    await saveConfig(config);
    console.log('\n✅ Setup complete for Vercel.');
    console.log('   Next: toss deploy --backend vercel');
  }
}
