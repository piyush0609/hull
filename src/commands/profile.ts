import { listProfiles, switchProfile, deleteProfile, loadConfig, getActiveProfile, renameProfile } from '../lib/config.js';

export async function profileListCommand() {
  const { active, profiles } = await listProfiles();

  if (Object.keys(profiles).length === 0) {
    console.log('No profiles found. Run "toss admin deploy" or "toss login" to create one.');
    return;
  }

  console.log('PROFILE    ROLE     ENDPOINT');
  for (const [name, config] of Object.entries(profiles)) {
    const marker = name === active ? '* ' : '  ';
    const endpoint = config.endpoint;
    const role = (config.role || 'owner').padEnd(8);
    console.log(`${marker}${name.padEnd(8)} ${role} ${endpoint}`);
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
  const active = await getActiveProfile();
  const config = await loadConfig();
  if (!config) {
    console.error('Error: No profile active. Run "toss admin deploy" or "toss login" first.');
    process.exit(1);
  }

  console.log(`Profile:   ${active || 'default'}`);
  console.log(`Role:      ${config.role || 'owner'}`);
  console.log(`Endpoint:  ${config.endpoint}`);
  console.log(`Subdomain: ${config.subdomain}`);
  if (config.accountId) {
    console.log(`Account:   ${config.accountId}`);
  }
  if (config.kvId) {
    console.log(`KV ID:     ${config.kvId}`);
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

export async function profileDefaultCommand(name?: string) {
  if (!name) {
    const active = await getActiveProfile();
    if (!active) {
      console.log('No active profile set. Run "toss admin deploy" or "toss login" first.');
      return;
    }
    console.log(`Active profile: ${active}`);
    return;
  }

  const ok = await switchProfile(name);
  if (!ok) {
    console.error(`Error: Profile "${name}" not found.`);
    console.error('Run "toss profile list" to see available profiles.');
    process.exit(1);
  }
  console.log(`Set active profile: ${name}`);
}

export async function profileRenameCommand(oldName: string, newName: string) {
  if (oldName === 'default') {
    console.error('Error: Cannot rename the default profile.');
    console.error('Use "toss admin deploy --profile <new>" to copy default to a named profile.');
    process.exit(1);
  }
  if (newName === 'default') {
    console.error('Error: Cannot rename a profile to "default".');
    process.exit(1);
  }
  if (!/^[a-z0-9_-]+$/.test(newName)) {
    console.error('Error: Profile name must be lowercase alphanumeric with hyphens/underscores only.');
    process.exit(1);
  }

  const ok = await renameProfile(oldName, newName);
  if (!ok) {
    console.error(`Error: Could not rename "${oldName}" to "${newName}".`);
    console.error('The source profile may not exist, or the target name is already taken.');
    process.exit(1);
  }
  console.log(`Renamed profile: ${oldName} → ${newName}`);
}
