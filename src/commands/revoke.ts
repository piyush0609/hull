import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

export async function revokeCommand(idOrSlug: string, options: { profile?: string } = {}) {
  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('Error: No toss found. Run "toss deploy" first.');
    process.exit(1);
  }

  const api = new TossAPI(config);

  // If it looks like a slug (has letters beyond hex), resolve to ID
  let id = idOrSlug;
  if (/[g-z]/i.test(idOrSlug) || idOrSlug.includes('-') && !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(idOrSlug)) {
    try {
      const artifacts = await api.list();
      const match = artifacts.find((a) => a.slug === idOrSlug);
      if (match) {
        id = match.id;
      } else {
        console.error(`Error: No artifact found with slug "${idOrSlug}"`);
        process.exit(1);
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  try {
    await api.revoke(id);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`Revoked ${idOrSlug}. Link is now dead.`);
}
