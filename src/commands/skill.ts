import { readFile, writeFile, mkdir, access, rm, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { VERSION } from '../version.js';
import { createHash } from 'node:crypto';

const GITHUB_SKILL_URL = 'https://raw.githubusercontent.com/piyush0609/toss/main/SKILL.md';

interface ToolConfig {
  user?: string;
  project?: string;
  description: string;
}

const TOOL_CONFIGS: Record<string, ToolConfig> = {
  'claude-code': {
    user: join(homedir(), '.claude/skills/toss'),
    project: '.claude/skills/toss',
    description: 'Claude Code CLI and Desktop',
  },
  'cursor': {
    user: join(homedir(), '.cursor/skills/toss'),
    project: '.cursor/skills/toss',
    description: 'Cursor AI editor',
  },
  'codex': {
    user: join(homedir(), '.codex/skills/toss'),
    project: '.codex/skills/toss',
    description: 'OpenAI Codex CLI',
  },
  'kimi': {
    user: join(homedir(), '.kimi/skills/toss'),
    project: '.kimi/skills/toss',
    description: 'Kimi Code CLI',
  },
  'opencode': {
    user: join(homedir(), '.config/opencode/skills/toss'),
    project: '.opencode/skills/toss',
    description: 'OpenCode AI assistant',
  },
  'cline': {
    user: join(homedir(), '.cline/skills/toss'),
    project: '.cline/skills/toss',
    description: 'Cline VS Code extension',
  },
  'gemini': {
    user: join(homedir(), '.gemini/antigravity/skills/toss'),
    project: '.gemini/antigravity/skills/toss',
    description: 'Gemini CLI / Antigravity',
  },
  'agents': {
    user: join(homedir(), '.agents/skills/toss'),
    project: '.agents/skills/toss',
    description: 'Generic agents (cross-compatible: Kimi, Gemini, Codex)',
  },
};

function prompt(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(q, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function getSkillContent(): Promise<string> {
  // Try local file first (works for npm/source installs)
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const localPaths = [
    join(scriptDir, '../../../SKILL.md'),
    join(scriptDir, '../../../../SKILL.md'),
  ];
  for (const p of localPaths) {
    try {
      return await readFile(p, 'utf-8');
    } catch {}
  }

  // Fallback to GitHub (works for binary installs)
  try {
    const res = await fetch(GITHUB_SKILL_URL);
    if (res.ok) return res.text();
  } catch {}

  throw new Error(
    'Could not find SKILL.md locally or fetch from GitHub. ' +
    'Ensure you have internet connectivity or install from source.'
  );
}

// --- Skill stamping & content hashing -------------------------------------
// The installed SKILL.md carries two managed frontmatter fields: `version` (a
// human label) and `toss-hash` (the staleness signal). Updates are gated on the
// hash, not the version — so a content change with no version bump still syncs,
// and a version bump with no content change does not rewrite every install.

// Frontmatter fields toss owns: stripped before hashing, re-written on stamp.
const STAMP_FIELDS = ['version', 'toss-hash'];

// Split "---<fm>---<body>" into its parts, or null when there is no frontmatter.
function splitFrontmatter(content: string): { fm: string; body: string } | null {
  if (!content.startsWith('---')) return null;
  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return null;
  return { fm: content.slice(3, endIdx), body: content.slice(endIdx + 3) };
}

function stripFields(frontmatter: string, fields: string[]): string {
  return fields.reduce((fm, f) => fm.replace(new RegExp(`\\n${f}:.*`, 'g'), ''), frontmatter);
}

// Canonical content with toss-managed fields removed — the thing we hash.
// Stripping our own stamp is what keeps the hash stable across the install
// round-trip (source hash === re-read installed hash).
export function normalizeSkill(content: string): string {
  const parts = splitFrontmatter(content);
  if (!parts) return content;
  return `---${stripFields(parts.fm, STAMP_FIELDS).trimEnd()}\n---${parts.body}`;
}

export function hashSkill(content: string): string {
  return createHash('sha256').update(normalizeSkill(content), 'utf-8').digest('hex').slice(0, 16);
}

// Stamp version + content hash into the frontmatter (replacing any prior stamp).
export function stampSkill(content: string): string {
  const stamp = `\nversion: "${VERSION}"\ntoss-hash: "${hashSkill(content)}"\n`;
  const parts = splitFrontmatter(content);
  if (!parts) return `---${stamp}---\n\n${content}`;
  return `---${stripFields(parts.fm, STAMP_FIELDS).trimEnd()}${stamp}---${parts.body}`;
}

function extractField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`${field}:\\s*"([^"]+)"`));
  return match ? match[1] : null;
}

async function getInstalledVersion(skillFile: string): Promise<string | null> {
  try {
    return extractField(await readFile(skillFile, 'utf-8'), 'version');
  } catch {
    return null;
  }
}

async function getInstalledHash(skillFile: string): Promise<string | null> {
  try {
    return extractField(await readFile(skillFile, 'utf-8'), 'toss-hash');
  } catch {
    return null;
  }
}

async function installToPath(installPath: string, source: string): Promise<void> {
  await mkdir(installPath, { recursive: true });
  await writeFile(join(installPath, 'SKILL.md'), stampSkill(source), 'utf-8');
}

// Fetch the canonical SKILL.md once and hash it, so a command compares and
// installs against a single fetch instead of re-reading the source per tool.
async function loadSource(): Promise<{ source: string; hash: string }> {
  const source = await getSkillContent();
  return { source, hash: hashSkill(source) };
}

async function isInstalled(tool: string, level: 'user' | 'project'): Promise<boolean> {
  const config = TOOL_CONFIGS[tool];
  if (!config) return false;
  const path = level === 'user' ? config.user : config.project;
  if (!path) return false;
  return fileExists(join(path, 'SKILL.md'));
}

export async function skillInstallCommand(tool: string | null, options: { all?: boolean; level?: string }) {
  const level = (options.level || 'user') as 'user' | 'project';

  if (options.all) {
    const tools = Object.keys(TOOL_CONFIGS);
    let installed = 0;
    let skipped = 0;
    const { source, hash: sourceHash } = await loadSource();

    for (const t of tools) {
      const config = TOOL_CONFIGS[t];
      const path = level === 'user' ? config.user : config.project;
      if (!path) {
        console.log(`  ${t}: skipped (no ${level}-level support)`);
        skipped++;
        continue;
      }

      // Check if parent directory exists (tool likely installed)
      const parent = dirname(path);
      const parentExists = await fileExists(parent);
      if (!parentExists && level === 'user') {
        console.log(`  ${t}: skipped (tool not detected)`);
        skipped++;
        continue;
      }

      const alreadyInstalled = await isInstalled(t, level);
      if (alreadyInstalled) {
        const installedHash = await getInstalledHash(join(path, 'SKILL.md'));
        if (installedHash === sourceHash) {
          console.log(`  ${t}: already up to date (v${VERSION})`);
          skipped++;
          continue;
        }
        console.log(`  ${t}: updating skill content...`);
      } else {
        console.log(`  ${t}: installing...`);
      }

      try {
        await installToPath(path, source);
        installed++;
      } catch (err) {
        console.error(`  ${t}: failed — ${(err as Error).message}`);
      }
    }

    console.log(`\nInstalled/updated ${installed} tool(s), skipped ${skipped}.`);
    return;
  }

  if (!tool) {
    console.error('Error: specify a tool or use --all');
    console.log(`Valid tools: ${Object.keys(TOOL_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  if (!(tool in TOOL_CONFIGS)) {
    console.error(`Error: unknown tool '${tool}'`);
    console.log(`Valid tools: ${Object.keys(TOOL_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  const config = TOOL_CONFIGS[tool];
  const path = level === 'user' ? config.user : config.project;

  if (!path) {
    console.error(`Error: ${tool} does not support ${level}-level installation`);
    process.exit(1);
  }

  // Warn if parent dir doesn't exist
  const parent = dirname(path);
  if (level === 'user' && !(await fileExists(parent))) {
    console.log(`Warning: ${parent} does not exist. ${tool} may not be installed.`);
    const ans = await prompt('Install anyway? (y/N) ');
    if (ans.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }
  }

  const { source, hash: sourceHash } = await loadSource();
  const alreadyInstalled = await isInstalled(tool, level);
  if (alreadyInstalled) {
    const installedHash = await getInstalledHash(join(path, 'SKILL.md'));
    if (installedHash === sourceHash) {
      console.log(`Skill for ${tool} is already up to date (v${VERSION}).`);
      return;
    }
    const ans = await prompt(`Update ${tool} skill to the latest content (v${VERSION})? (Y/n) `);
    if (ans.toLowerCase() === 'n') {
      console.log('Cancelled.');
      return;
    }
  }

  await installToPath(path, source);
  console.log(`✓ Installed toss skill for ${tool} at ${path}`);
}

export async function skillUninstallCommand(tool: string, options: { level?: string }) {
  const level = (options.level || 'user') as 'user' | 'project';

  if (!(tool in TOOL_CONFIGS)) {
    console.error(`Error: unknown tool '${tool}'`);
    process.exit(1);
  }

  const config = TOOL_CONFIGS[tool];
  const path = level === 'user' ? config.user : config.project;

  if (!path) {
    console.error(`Error: ${tool} does not support ${level}-level uninstall`);
    process.exit(1);
  }

  const skillFile = join(path, 'SKILL.md');
  if (!(await fileExists(skillFile))) {
    console.log(`Skill for ${tool} is not installed at ${level} level.`);
    return;
  }

  const ans = await prompt(`Remove toss skill from ${path}? (y/N) `);
  if (ans.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    return;
  }

  await rm(path, { recursive: true, force: true });
  console.log(`✓ Removed toss skill for ${tool}`);
}

export async function skillListCommand() {
  console.log('Toss skill installation status:\n');
  console.log(`${'Tool'.padEnd(12)} ${'User'.padEnd(10)} ${'Project'.padEnd(10)} Description`);
  console.log('-'.repeat(70));

  for (const [tool, config] of Object.entries(TOOL_CONFIGS)) {
    const userStatus = config.user
      ? (await isInstalled(tool, 'user')
        ? `v${await getInstalledVersion(join(config.user, 'SKILL.md')) || '?'}`
        : '-')
      : 'N/A';

    const projectStatus = config.project
      ? (await isInstalled(tool, 'project')
        ? `v${await getInstalledVersion(join(config.project, 'SKILL.md')) || '?'}`
        : '-')
      : 'N/A';

    console.log(
      `${tool.padEnd(12)} ${userStatus.padEnd(10)} ${projectStatus.padEnd(10)} ${config.description}`
    );
  }

  console.log('\nInstall a skill: toss skill install <tool>');
  console.log('Install to current project: toss skill install <tool> --level project');
  console.log('Install to all detected tools: toss skill install --all');
}

export async function skillUpdateCommand(tool?: string) {
  const toolsToCheck = tool ? [tool] : Object.keys(TOOL_CONFIGS);
  let updated = 0;
  let current = 0;
  const { source, hash: sourceHash } = await loadSource();

  for (const t of toolsToCheck) {
    if (!(t in TOOL_CONFIGS)) {
      console.error(`Unknown tool: ${t}`);
      continue;
    }

    for (const level of ['user', 'project'] as const) {
      const path = level === 'user' ? TOOL_CONFIGS[t].user : TOOL_CONFIGS[t].project;
      if (!path) continue;

      const skillFile = join(path, 'SKILL.md');
      if (!(await fileExists(skillFile))) continue;

      const installedHash = await getInstalledHash(skillFile);
      if (installedHash === sourceHash) {
        current++;
        continue;
      }

      console.log(`Updating ${t} (${level}) to latest skill content (v${VERSION})`);
      try {
        await installToPath(path, source);
        updated++;
      } catch (err) {
        console.error(`  Failed: ${(err as Error).message}`);
      }
    }
  }

  if (updated > 0) {
    console.log(`\n✓ Updated ${updated} skill(s) to v${VERSION}`);
  } else {
    console.log(`\nAll installed skills are at v${VERSION}.`);
  }
}
