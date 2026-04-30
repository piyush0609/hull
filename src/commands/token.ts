import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

async function requireOwnerProfile(profile?: string) {
  const config = await loadConfig(profile);
  if (!config) {
    console.error('Error: No toss connection found. Run "toss admin deploy" first.');
    process.exit(1);
  }
  if (config.role && config.role !== 'owner') {
    console.error('Error: This profile is a member profile and cannot run admin token commands.');
    console.error('Use an owner profile with "toss profile switch <owner-profile>" or pass "--profile <owner-profile>".');
    process.exit(1);
  }
  return config;
}

export async function tokenCreateCommand(options: { label: string; profile?: string } = { label: '' }) {
  const config = await requireOwnerProfile(options.profile);

  const api = new TossAPI(config);
  try {
    const res = await fetch(`${config.endpoint}/tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token || config.ownerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ label: options.label }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed: ${res.status} ${text}`);
      process.exit(1);
    }

    const data = await res.json() as { token: string; label: string };
    console.log(`✓ Token created for ${data.label}`);
    console.log(`  Token: ${data.token}`);
    console.log(`  Setup: toss login ${config.endpoint} --token ${data.token}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function tokenListCommand(options: { profile?: string } = {}) {
  const config = await requireOwnerProfile(options.profile);

  try {
    const res = await fetch(`${config.endpoint}/tokens`, {
      headers: { Authorization: `Bearer ${config.token || config.ownerToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed: ${res.status} ${text}`);
      process.exit(1);
    }

    const tokens = await res.json() as Array<{ token_hash: string; label: string; created_at: number; is_admin: number }>;
    if (tokens.length === 0) {
      console.log('No tokens found.');
      return;
    }

    console.log('HASH (first 16)  LABEL                ADMIN  CREATED');
    for (const t of tokens) {
      const hash = t.token_hash.slice(0, 16).padEnd(17);
      const label = t.label.slice(0, 20).padEnd(20);
      const admin = t.is_admin ? 'yes' : 'no';
      const created = new Date(t.created_at * 1000).toISOString().slice(0, 10);
      console.log(`${hash} ${label} ${admin.padEnd(6)} ${created}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function tokenRevokeCommand(hash: string, options: { profile?: string } = {}) {
  const config = await requireOwnerProfile(options.profile);

  try {
    const res = await fetch(`${config.endpoint}/tokens/${hash}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${config.token || config.ownerToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed: ${res.status} ${text}`);
      process.exit(1);
    }

    console.log(`✓ Revoked token ${hash}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function tokenRotateCommand(options: { profile?: string } = {}) {
  const config = await requireOwnerProfile(options.profile);

  console.log('Token rotation requires re-deploying the worker with a new OWNER_TOKEN.');
  console.log('Run: toss admin destroy && toss admin deploy --multi-tenant');
  console.log('Then re-create user tokens with toss admin token create.');
}
