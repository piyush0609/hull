import { loadConfig, deleteProfile } from '../lib/config.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { rm } from 'fs/promises';
import { join } from 'path';

const execAsync = promisify(exec);

export async function destroyCommand(options: { profile?: string } = {}) {
  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('Error: No toss found. Nothing to destroy.');
    process.exit(1);
  }

  console.log(`Destroying toss (${config.subdomain})...\n`);

  const workerDir = join(process.env.HOME || '.', '.toss', 'worker');
  const dbName = `toss-db-${config.subdomain}`;

  // Build env with profile API token if available
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.accountId) env.CLOUDFLARE_ACCOUNT_ID = config.accountId;
  if (config.apiToken) env.CLOUDFLARE_API_TOKEN = config.apiToken;

  // Delete worker
  try {
    await execAsync('wrangler delete', { cwd: workerDir, env });
    console.log('✓ Worker deleted');
  } catch (err: any) {
    console.error('✗ Worker deletion failed:', err.stderr?.trim() || err.message);
  }

  // Delete D1 database
  try {
    await execAsync(`wrangler d1 delete ${dbName} -y`, { cwd: workerDir, env });
    console.log('✓ Database deleted');
  } catch (err: any) {
    console.error('✗ Database deletion failed:', err.stderr?.trim() || err.message);
  }

  // Delete KV namespace
  if (config.kvId) {
    try {
      await execAsync(`wrangler kv namespace delete --namespace-id ${config.kvId} -y`, { env });
      console.log('✓ KV namespace deleted');
    } catch (err: any) {
      console.error('✗ KV namespace deletion failed:', err.stderr?.trim() || err.message);
    }
  }

  // Remove profile or default config
  if (options.profile) {
    await deleteProfile(options.profile);
    console.log(`✓ Profile ${options.profile} removed`);
  } else {
    const configFile = join(process.env.HOME || '.', '.toss', 'config.json');
    await rm(configFile, { force: true });
  }

  console.log('\nToss destroyed.');
}
