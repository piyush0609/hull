import { loadConfig } from '../lib/config.js';
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

  // Delete worker
  try {
    await execAsync('wrangler delete', { cwd: workerDir });
    console.log('✓ Worker deleted');
  } catch (err: any) {
    console.error('✗ Worker deletion failed:', err.stderr?.trim() || err.message);
  }

  // Delete D1 database
  try {
    await execAsync(`wrangler d1 delete ${dbName} -y`, { cwd: workerDir });
    console.log('✓ Database deleted');
  } catch (err: any) {
    console.error('✗ Database deletion failed:', err.stderr?.trim() || err.message);
  }

  // Delete KV namespace
  if (config.kvId) {
    try {
      await execAsync(`wrangler kv namespace delete --namespace-id ${config.kvId} -y`);
      console.log('✓ KV namespace deleted');
    } catch (err: any) {
      console.error('✗ KV namespace deletion failed:', err.stderr?.trim() || err.message);
    }
  }

  // Remove local config
  const configFile = join(process.env.HOME || '.', '.toss', 'config.json');
  await rm(configFile, { force: true });

  console.log('\nToss destroyed.');
}
