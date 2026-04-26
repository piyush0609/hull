import { listProfiles, switchProfile, deleteProfile, loadConfig } from '../lib/config.js';

export async function profileListCommand() {
  const { active, profiles } = await listProfiles();

  if (Object.keys(profiles).length === 0) {
    console.log('No profiles found. Run toss deploy or toss join to create one.');
    return;
  }

  console.log('PROFILE    ENDPOINT');
  for (const [name, config] of Object.entries(profiles)) {
    const marker = name === active ? '* ' : '  ';
    const endpoint = config.endpoint;
    console.log(`${marker}${name.padEnd(8)} ${endpoint}`);
  }
  console.log('\n* = active profile');
}

export async function profileSwitchCommand(name: string) {
  const ok = await switchProfile(name);
  if (!ok) {
    console.error(`Error: Profile "${name}" not found.`);
    console.error('Run "toss profile list" to see available profiles.');
    process.exit(1);
  }
  console.log(`Switched to profile: ${name}`);
}

export async function profileShowCommand() {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: No profile active. Run "toss deploy" or "toss join" first.');
    process.exit(1);
  }

  const { active } = await listProfiles();
  console.log(`Profile:  ${active || 'default'}`);
  console.log(`Endpoint: ${config.endpoint}`);
  console.log(`Subdomain: ${config.subdomain}`);
  if (config.kvId) {
    console.log(`KV ID:    ${config.kvId}`);
  }
}

export async function profileDeleteCommand(name: string) {
  if (name === 'default') {
    console.error('Error: Cannot delete the default profile.');
    console.error('Delete ~/.toss/config.json manually if needed.');
    process.exit(1);
  }

  const ok = await deleteProfile(name);
  if (!ok) {
    console.error(`Error: Profile "${name}" not found.`);
    process.exit(1);
  }
  console.log(`Deleted profile: ${name}`);
}
