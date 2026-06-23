import { readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

// Mirror comments.ts: resolve a secret from an env var NAME (never the value),
// falling back to ./.env — the agent passes only the KEY.
function readEnvKey(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=(.*)$/);
      if (m && m[1] === key) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        return v;
      }
    }
  } catch { /* no .env present */ }
  return undefined;
}

// toss versions <id-or-slug>
//   List an artifact's versions (seq, date, hash, comment count, current marker).
//   Pass a seq to `toss comments <id-or-slug> --version <seq>` to read that version.
export async function versionsCommand(
  idOrSlug: string,
  options: { profile?: string; json?: boolean; passwordEnv?: string } = {}
) {
  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('Error: No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
    process.exit(1);
  }

  const api = new TossAPI(config);

  // Resolve a slug to its artifact id (mirrors `comments`/`revoke`).
  let id = idOrSlug;
  if (/[g-z]/i.test(idOrSlug) || (idOrSlug.includes('-') && !/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(idOrSlug))) {
    try {
      const artifacts = await api.list();
      const match = artifacts.find((a) => a.slug === idOrSlug);
      if (!match) {
        console.error(`Error: No artifact found with slug "${idOrSlug}"`);
        process.exit(1);
      }
      id = match.id;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  let password: string | undefined;
  if (options.passwordEnv) {
    password = readEnvKey(options.passwordEnv);
    if (!password) {
      console.error(`Error: env key "${options.passwordEnv}" is not set (checked the environment and ./.env).`);
      process.exit(1);
    }
  }

  let data: Awaited<ReturnType<typeof api.getVersions>>;
  try {
    data = await api.getVersions(id, { password });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const versions = data.versions || [];
  if (options.json) {
    console.log(JSON.stringify({ artifactId: id, versions }, null, 2));
    return;
  }
  if (!versions.length) {
    console.log(`No versions for ${idOrSlug}.`);
    return;
  }
  console.log('SEQ  CREATED      HASH      COMMENTS');
  for (const v of versions) {
    const seq = String(v.seq).padEnd(4);
    const created = new Date((v.created_at || 0) * 1000).toISOString().slice(0, 10).padEnd(12);
    const hash = String(v.content_hash || '').slice(0, 8).padEnd(9);
    const count = String(v.comment_count);
    console.log(`${seq} ${created} ${hash} ${count}${v.is_current ? '  (current)' : ''}`);
  }
}
