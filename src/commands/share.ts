import { readFile, stat, readdir, lstat } from 'fs/promises';
import { spawn } from 'child_process';
import { basename, join, relative } from 'path';
import { loadConfig } from '../lib/config.js';
import { TossAPI } from '../lib/api.js';
import { promptPassword } from '../lib/prompt.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB KV limit
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build', 'target', '.next', '.vercel', '.turbo', '.cache', 'out']);

// 0 = permanent (no expiry).
function parseDuration(d: string | undefined): number {
  if (!d || d === 'never' || d === 'permanent') return 0;
  const map: Record<string, number> = {
    '1h': 3600,
    '24h': 86400,
    '7d': 604800,
    '30d': 2592000,
  };
  if (!map[d]) throw new Error(`Invalid duration: ${d}. Use: 1h, 24h, 7d, 30d, or omit for permanent.`);
  return map[d];
}

async function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve) => {
    const platform = process.platform;
    let proc: ReturnType<typeof spawn>;
    if (platform === 'darwin') {
      proc = spawn('pbcopy');
    } else if (platform === 'linux') {
      proc = spawn('xclip', ['-selection', 'clipboard']);
    } else if (platform === 'win32') {
      proc = spawn('clip');
    } else {
      resolve();
      return;
    }
    if (!proc.stdin) {
      resolve();
      return;
    }
    proc.on('error', () => resolve());
    proc.on('close', () => resolve());
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

async function walkDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip hidden files/directories
    if (entry.name.startsWith('.')) continue;
    // Skip common dev/build directories
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    // Skip symlinks to avoid infinite loops and unexpected traversal
    const linkStat = await lstat(fullPath);
    if (linkStat.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      files.push(...await walkDir(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

export async function shareCommand(file: string, options: { expires?: string; id?: string; clipboard?: boolean; json?: boolean; password?: string | true; profile?: string; comments?: boolean; force?: boolean } = {}) {
  const config = await loadConfig(options.profile);
  if (!config) {
    console.error('Error: No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
    process.exit(1);
  }

  const api = new TossAPI(config);
  const expires = parseDuration(options.expires);

  // Handle password: --password with no value triggers interactive prompt
  let password: string | undefined = undefined;
  if (options.password === true) {
    password = await promptPassword('Enter password: ');
    if (!password) {
      console.error('Error: Password cannot be empty.');
      process.exit(1);
    }
  } else if (options.password) {
    // Password provided via CLI arg — warn about shell history
    if (process.stdin.isTTY) {
      console.warn('⚠️  Warning: Passing passwords via command line exposes them in shell history.');
      console.warn('   Use --password (no value) for secure interactive entry next time.\n');
    }
    password = options.password;
  }

  let result: { id: string; slug: string; url: string; legacyUrl: string; updated?: boolean };

  const fileStat = await stat(file).catch(() => null);
  if (!fileStat) {
    console.error(`Error: Could not read "${file}"`);
    process.exit(1);
  }

  if (fileStat.isDirectory() && options.id) {
    console.error('Error: --id is not yet supported for folder shares.');
    process.exit(1);
  }

  if (fileStat.isDirectory()) {
    // Folder share
    const allFiles = await walkDir(file);
    const htmlFiles = allFiles.filter(f => f.endsWith('.html'));
    if (htmlFiles.length === 0) {
      console.error('Error: No .html file found in directory.');
      process.exit(1);
    }

    // Check total size
    let totalSize = 0;
    for (const f of allFiles) {
      const s = await stat(f);
      totalSize += s.size;
    }
    if (totalSize > MAX_FILE_SIZE) {
      console.error(`Error: Total folder size (${(totalSize / 1024 / 1024).toFixed(1)}MB) exceeds 25MB KV limit.`);
      process.exit(1);
    }

    // Pick entry point: index.html if present, otherwise first html file
    let entryFile = htmlFiles.find(f => f.endsWith('/index.html') || f.endsWith('\\index.html'));
    if (!entryFile) entryFile = htmlFiles[0];

    // Upload entry point to create artifact.
    // We send the *folder* basename as the display name (not the entry HTML's
    // relative path) so `toss list` shows a meaningful identifier and we don't
    // leak the user's local path/structure.
    const entryName = basename(file);
    const entryHtml = await readFile(entryFile);
    try {
      result = await api.upload(entryHtml, entryName, expires, password, undefined, options.comments);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Upload remaining files
    const otherFiles = allFiles.filter(f => f !== entryFile);
    if (otherFiles.length > 0) {
      console.log(`Uploading ${otherFiles.length} additional files...`);
      for (const f of otherFiles) {
        const relPath = relative(file, f).replace(/\\/g, '/');
        const data = await readFile(f);
        try {
          await api.uploadFile(result.id, relPath, data);
        } catch (err) {
          console.error(`Failed to upload ${relPath}:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
  } else {
    // Single file share
    if (fileStat.size > MAX_FILE_SIZE) {
      console.error(`Error: File size (${(fileStat.size / 1024 / 1024).toFixed(1)}MB) exceeds 25MB KV limit.`);
      process.exit(1);
    }
    let html: Buffer;
    try {
      html = await readFile(file);
    } catch {
      console.error(`Error: Could not read file "${file}"`);
      process.exit(1);
    }
    // Send only the basename — never the user's full local path.
    const name = basename(file);
    try {
      result = await api.upload(html, name, expires, password, options.id, options.comments, options.force);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  if (options.clipboard) {
    await copyToClipboard(result.url);
  }

  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`\nLink:     ${result.url}${result.updated ? '  (updated in place)' : ''}`);
    if (result.legacyUrl) console.log(`Legacy:   ${result.legacyUrl}`);
    if (password) console.log(`Password: ${password}`);
    console.log(`Expires:  ${expires === 0 ? 'never (permanent)' : options.expires}`);
    if (options.clipboard) console.log('Copied to clipboard.');
    console.log(`Revoke:   toss revoke ${result.slug || result.id}\n`);
  }
}
