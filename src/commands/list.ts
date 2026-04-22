import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtExpiry(msLeft: number): string {
  if (msLeft <= 0) return 'EXPIRED';
  if (msLeft < 60000) return '<1m left';
  if (msLeft < 3600000) return `${Math.floor(msLeft / 60000)}m left`;
  if (msLeft < 86400000) return `${Math.floor(msLeft / 3600000)}h left`;
  return `${Math.floor(msLeft / 86400000)}d left`;
}

export async function listCommand() {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: No toss found. Run "toss deploy" first.');
    process.exit(1);
  }

  const api = new TossAPI(config);
  let artifacts: Awaited<ReturnType<typeof api.list>>;
  try {
    artifacts = await api.list();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (artifacts.length === 0) {
    console.log('No artifacts found.');
    return;
  }

  console.log('ID        NAME              SIZE     EXPIRES');
  for (const a of artifacts) {
    const id = a.id.slice(0, 8).padEnd(9);
    const name = a.name.slice(0, 17).padEnd(17);
    const size = fmtSize(Number(a.size_bytes)).padStart(7).padEnd(8);
    const expiry = fmtExpiry(Number(a.expires_at) * 1000 - Date.now());
    console.log(`${id} ${name} ${size} ${expiry}`);
  }
}
