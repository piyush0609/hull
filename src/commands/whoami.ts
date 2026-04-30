import { loadConfig, getActiveProfile } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

function displayProfileName(requestedProfile?: string, activeProfile?: string): string {
  if (requestedProfile) return requestedProfile;
  return activeProfile || 'default';
}

export async function whoamiCommand(options: { profile?: string } = {}) {
  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('Error: No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
    process.exit(1);
  }

  const activeProfile = await getActiveProfile();
  const shownProfile = displayProfileName(options.profile, activeProfile);

  console.log('Who Am I');
  console.log('=========');
  console.log(`Profile:   ${shownProfile}`);
  if (activeProfile && shownProfile !== activeProfile) {
    console.log(`Active:    ${activeProfile}`);
  }
  console.log(`Role:      ${config.role || 'owner'}`);
  console.log(`Endpoint:  ${config.endpoint}`);
  console.log(`Subdomain: ${config.subdomain}`);
  if (config.backend) {
    console.log(`Backend:   ${config.backend}`);
  }

  try {
    const api = new TossAPI(config);
    const artifacts = await api.list();
    console.log(`Artifacts: ${artifacts.length}`);
  } catch {
    console.log('Artifacts: (could not reach worker)');
  }
}
