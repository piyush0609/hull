import { promptConfirm } from '../lib/prompt.js';
import { TossAPI } from '../lib/api.js';
import { requireOwnerProfile } from '../lib/owner.js';

export async function cleanupCommand(options: { profile?: string; yes?: boolean } = {}) {
  const config = await requireOwnerProfile(
    options.profile,
    'Error: No toss connection found. Run "toss admin deploy" first.'
  );

  const api = new TossAPI(config);
  let artifacts: Awaited<ReturnType<typeof api.list>>;
  try {
    artifacts = await api.list();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const expired = artifacts.filter((artifact) => Number(artifact.expires_at) * 1000 < Date.now());
  if (expired.length === 0) {
    console.log('No expired artifacts found.');
    return;
  }

  const autoYes = options.yes || !process.stdin.isTTY;
  if (!autoYes) {
    const confirmed = await promptConfirm(`Delete ${expired.length} expired artifact(s)?`, true);
    if (!confirmed) {
      console.log('Cancelled.');
      return;
    }
  }

  let deleted = 0;
  let failed = 0;
  for (const artifact of expired) {
    try {
      await api.revoke(artifact.id);
      deleted += 1;
    } catch (err) {
      failed += 1;
      console.error(`Failed to delete ${artifact.slug || artifact.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Deleted ${deleted} expired artifact(s).`);
  if (failed > 0) {
    console.log(`Failed to delete ${failed} expired artifact(s).`);
    process.exit(1);
  }
}
