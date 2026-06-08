import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// toss keeps its dotfiles under ~/.toss (mirrors src/lib/config.ts).
function tossDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.toss');
}
function cacheFile(): string {
  return join(tossDir(), 'update-check.json');
}

const REPO = 'piyush0609/toss';
const TTL_MS = 24 * 60 * 60 * 1000; // hit GitHub at most once a day
const FETCH_TIMEOUT_MS = 1500; // never hang a command on a slow network

interface Cache {
  checkedAt: number;
  latest: string | null;
}

/**
 * Compare two semver strings. Returns <0 when a<b, 0 when equal, >0 when a>b.
 * Build metadata (+...) is ignored; a prerelease (x.y.z-foo) sorts below its
 * release (x.y.z). Tolerant of non-numeric junk (treated as 0).
 */
export function compareSemver(a: string, b: string): number {
  const core = (v: string) =>
    v.split('+')[0].split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [a0, a1, a2] = core(a);
  const [b0, b1, b2] = core(b);
  if (a0 !== b0) return a0 - b0;
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  const preA = a.includes('-');
  const preB = b.includes('-');
  if (preA !== preB) return preA ? -1 : 1; // release > prerelease
  return 0;
}

async function readCache(): Promise<Cache | null> {
  try {
    return JSON.parse(await readFile(cacheFile(), 'utf-8')) as Cache;
  } catch {
    return null;
  }
}

async function writeCache(cache: Cache): Promise<void> {
  try {
    await mkdir(tossDir(), { recursive: true });
    await writeFile(cacheFile(), JSON.stringify(cache), 'utf-8');
  } catch {
    /* the cache is best-effort */
  }
}

async function fetchLatestTag(): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=20`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'toss-cli' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const tags = (await res.json()) as Array<{ name?: string }>;
    const versions = tags
      .map((t) => (t.name || '').replace(/^v/, ''))
      .filter((v) => /^\d+\.\d+\.\d+/.test(v))
      .sort(compareSemver);
    return versions.length ? versions[versions.length - 1] : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Print a one-line "update available" banner to stderr when a newer tag exists
 * on GitHub. Deliberately side-effect-light and fail-open:
 *  - skips unless stderr is a TTY, so piped/JSON output and agents are never
 *    touched and never pay the network cost,
 *  - opt out with TOSS_NO_UPDATE_CHECK=1,
 *  - queries GitHub at most once per TTL (cached in ~/.toss/update-check.json),
 *  - swallows every error — an update check must never break a command.
 */
export async function maybeNotifyUpdate(current: string): Promise<void> {
  try {
    if (process.env.TOSS_NO_UPDATE_CHECK === '1') return;
    if (!process.stderr.isTTY) return;

    let latest: string | null = null;
    const cached = await readCache();
    if (cached && Date.now() - cached.checkedAt < TTL_MS) {
      latest = cached.latest;
    } else {
      latest = await fetchLatestTag();
      await writeCache({ checkedAt: Date.now(), latest });
    }

    if (latest && compareSemver(current, latest) < 0) {
      process.stderr.write(
        `\n  ⬆ toss ${latest} is available (you have ${current}).\n` +
          `    https://github.com/${REPO}/releases  ·  silence: TOSS_NO_UPDATE_CHECK=1\n\n`,
      );
    }
  } catch {
    /* fail-open: never block the CLI on an update check */
  }
}
