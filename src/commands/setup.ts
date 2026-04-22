import { exec } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

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

async function getWranglerToken(): Promise<string | null> {
  const paths = [
    join(homedir(), '.config/.wrangler/config/default.toml'),
    join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'),
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

function getAccountIdFromWhoami(stdout: string): string | null {
  const match = stdout.match(/([a-f0-9]{32})/);
  return match ? match[1] : null;
}

function getEmailFromWhoami(stdout: string): string | null {
  const match = stdout.match(/associated with the email (.+)/);
  return match ? match[1].trim() : null;
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

  // Check auth state
  let whoamiStdout = '';
  let authOk = false;
  try {
    const { stdout } = await execAsync('wrangler whoami');
    whoamiStdout = stdout;
    if (!stdout.includes('not authenticated')) {
      authOk = true;
    }
  } catch {}

  if (authOk) {
    const email = getEmailFromWhoami(whoamiStdout) || 'Cloudflare account';
    console.log(`✅ Authenticated as ${email}`);
    const answer = await prompt('Use this account? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Signing out...');
      try {
        await execAsync('wrangler logout');
      } catch {}
      authOk = false;
    }
  }

  if (!authOk) {
    console.log('\nChoose login method:');
    console.log('  1. Browser login (opens Cloudflare OAuth)');
    console.log('  2. API token (paste a token, no browser)');
    const method = await prompt('Option (1/2): ');

    if (method === '2') {
      console.log('\nCreate a token at: https://dash.cloudflare.com/profile/api-tokens');
      console.log('Use template: "Edit Cloudflare Workers" + D1 + KV\n');
      const token = await prompt('Paste your API token: ');
      if (!token) {
        console.error('No token provided.');
        process.exit(1);
      }
      // Verify token works
      try {
        const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!data.success) throw new Error('Invalid token');
      } catch {
        console.error('Token verification failed. Check your token.');
        process.exit(1);
      }
      // Set token for wrangler to use
      process.env.CLOUDFLARE_API_TOKEN = token;
      console.log('✅ Token verified');
    } else {
      console.log('\nOpening browser for Cloudflare login...');
      console.log('(Scopes: account:read, workers_scripts:write, workers_kv:write, d1:write, zone:read)');
      console.log('Tip: Use incognito/private mode to switch accounts\n');
      try {
        await execAsync('wrangler login --scopes account:read workers_scripts:write workers_kv:write d1:write zone:read');
      } catch (err: any) {
        console.error('Login failed:', err.stderr || err.message);
        process.exit(1);
      }
    }
  }

  // Verify auth again
  try {
    const { stdout } = await execAsync('wrangler whoami');
    if (stdout.includes('not authenticated')) {
      console.error('❌ Still not authenticated.');
      process.exit(1);
    }
  } catch {
    console.error('❌ Auth check failed.');
    process.exit(1);
  }

  // Check workers.dev subdomain
  console.log('\nVerifying workers.dev subdomain...');
  let subdomain = '';
  try {
    const { stdout } = await execAsync('wrangler whoami');
    const accountId = getAccountIdFromWhoami(stdout);
    const token = await getWranglerToken();
    if (accountId && token) {
      subdomain = (await getWorkersDevSubdomain(accountId, token)) || '';
    }
  } catch {}

  if (subdomain) {
    console.log(`✅ workers.dev subdomain: ${subdomain}`);
  } else {
    console.log('❌ No workers.dev subdomain registered.');
    console.log('   Visit: https://dash.cloudflare.com/workers/onboarding');
    console.log('   Or run: wrangler subdomain <name>');
    process.exit(1);
  }

  console.log('\n✅ Setup complete. You can now run:');
  console.log('   hull deploy');
}
