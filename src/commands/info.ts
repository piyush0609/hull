import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

export async function infoCommand(options: { profile?: string } = {}) {
  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('Error: No toss found. Run "toss deploy" first.');
    process.exit(1);
  }

  console.log('Toss Info');
  console.log('=========');
  console.log(`Endpoint:  ${config.endpoint}`);
  console.log(`Subdomain: ${config.subdomain}`);
  if (config.kvId) {
    console.log(`KV ID:     ${config.kvId}`);
  }

  try {
    const api = new TossAPI(config);
    const artifacts = await api.list();
    console.log(`Artifacts: ${artifacts.length}`);
    const expired = artifacts.filter((a) => Number(a.expires_at) * 1000 < Date.now()).length;
    if (expired > 0) {
      console.log(`  (including ${expired} expired)`);
    }
  } catch {
    console.log('Artifacts: (could not reach worker)');
  }
}
