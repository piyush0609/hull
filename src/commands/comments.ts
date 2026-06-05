import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

// toss comments <slug-or-id> on|off — owner-only per-share comment toggle.
export async function commentsCommand(
  idOrSlug: string,
  state: string,
  options: { profile?: string } = {}
) {
  if (state !== 'on' && state !== 'off') {
    console.error('Error: usage: toss comments <id-or-slug> on|off');
    process.exit(1);
  }
  const enabled = state === 'on';

  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('Error: No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
    process.exit(1);
  }

  const api = new TossAPI(config);

  // Resolve a slug to its artifact id (mirrors `revoke`).
  let id = idOrSlug;
  if (/[g-z]/i.test(idOrSlug) || (idOrSlug.includes('-') && !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(idOrSlug))) {
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
    await api.setComments(id, enabled);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`Comments ${enabled ? 'enabled' : 'disabled'} for ${idOrSlug}.`);
}
