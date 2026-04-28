import { exec } from 'child_process';
import { promisify } from 'util';
import { loadConfig, saveConfig } from '../lib/config.js';
import { promptConfirm } from '../lib/prompt.js';

const execAsync = promisify(exec);

export async function destroyVercelCommand(options: { profile?: string; yes?: boolean } = {}) {
  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('No configuration found. Run: toss setup --backend vercel');
    process.exit(1);
  }

  const projectName = config.vercelProjectId
    ? undefined
    : config.subdomain && config.subdomain !== 'toss'
      ? `toss-${config.subdomain}`
      : 'toss';

  if (!projectName && !config.vercelProjectId) {
    console.error('Could not determine Vercel project name. No subdomain or project ID in config.');
    process.exit(1);
  }

  const autoYes = options.yes || !process.stdin.isTTY;
  if (!autoYes) {
    const confirm = await promptConfirm(
      `Destroy Vercel project "${projectName || config.vercelProjectId}"? This cannot be undone.`,
      false
    );
    if (!confirm) {
      console.log('Cancelled.');
      return;
    }
  }

  console.log('Destroying Vercel project...');

  try {
    const name = projectName || config.vercelProjectId;
    if (name) {
      await execAsync(`echo "y" | vercel project rm ${name}`);
      console.log(`✅ Project "${name}" removed.`);
    }
  } catch (err: any) {
    console.warn('Warning: Could not remove project:', err.stderr || err.message);
  }

  // Clear config
  const cleared = { endpoint: '', ownerToken: '', subdomain: '', backend: 'vercel' as const };
  await saveConfig(cleared, options.profile);

  console.log('\n✅ Toss Vercel project destroyed.');
  console.log('   Config cleared. Run setup again to redeploy.');
}
