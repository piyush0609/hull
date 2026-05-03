import { loadConfig, type TossConfig } from './config.js';

export async function requireOwnerProfile(
  profile?: string,
  missingMessage = 'Error: No toss connection found. Run "toss admin deploy" first.',
  memberMessage = 'Error: This profile is a member profile and cannot run owner-only commands.'
): Promise<TossConfig> {
  const config = await loadConfig(profile);
  if (!config) {
    console.error(missingMessage);
    process.exit(1);
  }
  if (config.role && config.role !== 'owner') {
    console.error(memberMessage);
    console.error('Use an owner profile with "toss profile switch <owner-profile>" or pass "--profile <owner-profile>".');
    process.exit(1);
  }
  return config;
}
