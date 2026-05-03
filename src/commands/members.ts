import { requireOwnerProfile } from '../lib/owner.js';

type MemberRow = {
  token_hash: string;
  label: string;
  created_at: number;
  is_admin: number;
};

function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export async function membersListCommand(options: { profile?: string } = {}) {
  const config = await requireOwnerProfile(
    options.profile,
    'Error: No toss connection found. Run "toss admin deploy" first.'
  );

  try {
    const res = await fetch(`${config.endpoint}/tokens`, {
      headers: { Authorization: `Bearer ${config.token || config.ownerToken}` },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Failed: ${res.status} ${text}`);
      process.exit(1);
    }

    const members = await res.json() as MemberRow[];
    if (members.length === 0) {
      console.log('No members found.');
      return;
    }

    console.log('MEMBER               ROLE    TOKEN (first 16)    CREATED');
    for (const member of members) {
      const label = member.label.slice(0, 20).padEnd(20);
      const role = (member.is_admin ? 'owner' : 'member').padEnd(7);
      const tokenPrefix = member.token_hash.slice(0, 16).padEnd(18);
      const created = formatDate(member.created_at);
      console.log(`${label} ${role} ${tokenPrefix} ${created}`);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
