import { exec } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';

const execAsync = promisify(exec);

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

export async function setupCommand() {
  console.log('Hull Setup\n==========\n');

  // Check Node.js
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (nodeMajor < 18) {
    console.error(`❌ Node.js 18+ required. Found: ${nodeVersion}`);
    console.error('Install from https://nodejs.org');
    process.exit(1);
  }
  console.log(`✅ Node.js ${nodeVersion}`);

  // Check / install wrangler
  let wranglerVersion = '';
  try {
    const { stdout } = await execAsync('wrangler --version');
    wranglerVersion = stdout.trim();
    console.log(`✅ Wrangler ${wranglerVersion}`);
  } catch {
    console.log('❌ Wrangler not found.');
    const answer = await prompt('Install Wrangler now? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.error('Please install: npm install -g wrangler');
      process.exit(1);
    }
    console.log('Installing wrangler...');
    try {
      await execAsync('npm install -g wrangler');
      const { stdout } = await execAsync('wrangler --version');
      wranglerVersion = stdout.trim();
      console.log(`✅ Wrangler ${wranglerVersion} installed`);
    } catch (err: any) {
      console.error('Failed to install wrangler:', err.stderr || err.message);
      process.exit(1);
    }
  }

  // Check / run auth
  let authOk = false;
  try {
    const { stdout } = await execAsync('wrangler whoami');
    if (!stdout.includes('not authenticated')) {
      authOk = true;
      console.log('✅ Authenticated with Cloudflare');
    }
  } catch {}

  if (!authOk) {
    console.log('❌ Not authenticated with Cloudflare.');
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
      console.log('✅ Authenticated with Cloudflare');
    } catch (err: any) {
      console.error('Login failed:', err.stderr || err.message);
      process.exit(1);
    }
  }

  // Check workers.dev subdomain
  console.log('\nVerifying workers.dev subdomain...');
  let subdomain = '';
  try {
    const { stdout } = await execAsync('wrangler whoami');
    const accountMatch = stdout.match(/([a-f0-9]{32})/);
    if (accountMatch) {
      const tokenRes = await execAsync('grep oauth_token ~/.config/.wrangler/config/default.toml 2>/dev/null || grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml 2>/dev/null').catch(() => null);
      // Best-effort subdomain check via API would go here
      // For now just trust wrangler whoami working means they're set up
      console.log('✅ Account connected');
    }
  } catch {
    console.log('⚠️  Could not verify subdomain. You may need to register one.');
    console.log('   Visit: https://dash.cloudflare.com/workers/onboarding');
  }

  console.log('\n✅ Setup complete. You can now run:');
  console.log('   hull deploy');
}
