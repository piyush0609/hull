import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig } from '../lib/config.js';

const execAsync = promisify(exec);

function check(label: string, pass: boolean, fix?: string) {
  const icon = pass ? '✅' : '❌';
  console.log(`${icon} ${label}`);
  if (!pass && fix) console.log(`   → ${fix}`);
  return pass;
}

export async function doctorCommand() {
  let ok = true;

  console.log('Checking toss prerequisites...\n');

  // Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
  ok = check(
    `Node.js ${nodeVersion}`,
    major >= 18,
    'Upgrade to Node 18+ (https://nodejs.org)'
  ) && ok;

  // Wrangler installed
  let wranglerVersion = '';
  try {
    const { stdout } = await execAsync('wrangler --version');
    wranglerVersion = stdout.trim();
  } catch {}
  const wranglerMajor = wranglerVersion ? parseInt(wranglerVersion.split('.')[0], 10) : 0;
  ok = check(
    wranglerVersion ? `Wrangler ${wranglerVersion}` : 'Wrangler not found',
    !!wranglerVersion && wranglerMajor >= 3,
    wranglerMajor < 3 ? 'Upgrade to Wrangler v3+ (npm install -g wrangler@latest)' : 'Run: npm install -g wrangler'
  ) && ok;

  // Wrangler authenticated
  let wranglerAuth = false;
  let accountEmail = '';
  try {
    const { stdout } = await execAsync('wrangler whoami');
    wranglerAuth = stdout.includes('@') || stdout.includes('Account');
    const match = stdout.match(/associated with the email (.+)/);
    if (match) accountEmail = match[1].trim();
  } catch {}
  ok = check(
    wranglerAuth ? `Authenticated as ${accountEmail}` : 'Not authenticated with Cloudflare',
    wranglerAuth,
    'Run: wrangler login   (or export CLOUDFLARE_API_TOKEN=...)'
  ) && ok;

  // Workers.dev subdomain
  let subdomain = '';
  if (wranglerAuth) {
    try {
      const { stdout } = await execAsync('wrangler whoami');
      const accountMatch = stdout.match(/([a-f0-9]{32})/);
      if (accountMatch) {
        // Try to get subdomain via API using OAuth token from wrangler config
        const configPath = `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`;
        try {
          const { readFile } = await import('fs/promises');
          const toml = await readFile(configPath, 'utf-8');
          const tokenMatch = toml.match(/oauth_token\s*=\s*"([^"]+)"/);
          if (tokenMatch) {
            const res = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${accountMatch[1]}/workers/subdomain`,
              { headers: { Authorization: `Bearer ${tokenMatch[1]}` } }
            );
            if (res.ok) {
              const data = await res.json();
              if (data.success && data.result?.subdomain) {
                subdomain = data.result.subdomain;
              }
            }
          }
        } catch {}
      }
    } catch {}
  }
  ok = check(
    subdomain ? `workers.dev subdomain: ${subdomain}` : 'No workers.dev subdomain registered',
    !!subdomain,
    'Visit: https://dash.cloudflare.com/workers/onboarding'
  ) && ok;

  // Config
  const config = await loadConfig();
  if (config) {
    console.log(`✅ Toss config found (${config.subdomain})`);
  } else {
    console.log(`ℹ️  No toss config found — run 'toss deploy' when ready`);
  }

  console.log();
  if (ok) {
    console.log('All checks passed. Ready to deploy!');
    console.log('   toss deploy');
  } else {
    console.log('Some checks failed. Fix the issues above, then try again.');
    process.exit(1);
  }
}
