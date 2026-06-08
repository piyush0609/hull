import { readFileSync } from 'node:fs';
import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';

// Resolve a secret from an env var NAME, falling back to ./.env — so the agent
// passes only the KEY (e.g. --password-env REVIEW_PW), never the value.
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

// toss comments <id-or-slug> [on|off]
//   no state  -> list the share's comments on the latest version (--json for raw output)
//   on|off    -> owner-only per-share comment toggle
export async function commentsCommand(
  idOrSlug: string,
  state: string | undefined,
  options: { profile?: string; json?: boolean; passwordEnv?: string } = {}
) {
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

  // No state -> retrieve comments (programmatic read).
  if (state === undefined) {
    let password: string | undefined;
    if (options.passwordEnv) {
      password = readEnvKey(options.passwordEnv);
      if (!password) {
        console.error(`Error: env key "${options.passwordEnv}" is not set (checked the environment and ./.env).`);
        process.exit(1);
      }
    }
    let data: any;
    try {
      data = await api.getComments(id, { password });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const threads: any[] = (data && (data.activityThreads || data.threads)) || [];
    if (options.json) {
      console.log(JSON.stringify({ artifactId: id, threads }, null, 2));
      return;
    }
    if (!threads.length) {
      console.log(`No comments on ${idOrSlug}.`);
      return;
    }
    console.log(`${threads.length} comment thread(s) on ${idOrSlug} (latest version):\n`);
    for (const t of threads) {
      const scope = t.scope_type === 'artifact' ? 'page' : t.scope_type;
      const anchorText =
        (t.anchor && t.anchor.state && t.anchor.state.text) ||
        (t.anchor && t.anchor.quote && t.anchor.quote.exact) ||
        (t.anchor && t.anchor.selector) ||
        '';
      console.log(
        `• [${scope}] ${t.page_path || ''}` +
        (anchorText ? ` — ${String(anchorText).slice(0, 60)}` : '') +
        (t.status === 'resolved' ? '  (resolved)' : '')
      );
      for (const m of (t.messages || [])) {
        const when = new Date((m.created_at || 0) * 1000).toISOString().slice(0, 16).replace('T', ' ');
        console.log(`    ${m.author_label || 'anon'} · ${when}${m.deleted_at ? ' (deleted)' : ''}`);
        if (!m.deleted_at) console.log(`      ${String(m.body || '').replace(/\s+/g, ' ').trim()}`);
      }
      console.log('');
    }
    return;
  }

  // state given -> owner-only toggle.
  if (state !== 'on' && state !== 'off') {
    console.error('Error: usage: toss comments <id-or-slug> [on|off]');
    process.exit(1);
  }
  const enabled = state === 'on';
  try {
    await api.setComments(id, enabled);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`Comments ${enabled ? 'enabled' : 'disabled'} for ${idOrSlug}.`);
}
