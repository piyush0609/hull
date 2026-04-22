import { readFile, writeFile, mkdir, access, rm, readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const VERSION = '0.1.0';
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

function injectVersion(content: string): string {
  if (content.startsWith('---')) {
    const endIdx = content.indexOf('---', 3);
    if (endIdx !== -1) {
      const frontmatter = content.slice(3, endIdx);
      const cleaned = frontmatter.replace(/\nversion:.*/g, '');
      const updated = cleaned.trimEnd() + `\nversion: "${VERSION}"\n`;
      return '---' + updated + '---' + content.slice(endIdx + 3);
    }
  }
  return `---\nversion: "${VERSION}"\n---\n\n${content}`;
}

function extractVersion(content: string): string | null {
  const match = content.match(/version:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function getInstalledVersion(skillFile: string): Promise<string | null> {
  try {
    const content = await readFile(skillFile, 'utf-8');
    return extractVersion(content);
  } catch {
    return null;
  }
}

async function installToPath(installPath: string): Promise<void> {
  const content = await getSkillContent();
  const versioned = injectVersion(content);

  await mkdir(installPath, { recursive: true });
  const skillFile = join(installPath, 'SKILL.md');
  await writeFile(skillFile, versioned, 'utf-8');
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
        const installedVer = await getInstalledVersion(join(path, 'SKILL.md'));
        if (installedVer === VERSION) {
          console.log(`  ${t}: already at v${VERSION}`);
          skipped++;
          continue;
        }
        console.log(`  ${t}: updating v${installedVer} → v${VERSION}`);
      } else {
        console.log(`  ${t}: installing...`);
      }

      try {
        await installToPath(path);
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

  const alreadyInstalled = await isInstalled(tool, level);
  if (alreadyInstalled) {
    const installedVer = await getInstalledVersion(join(path, 'SKILL.md'));
    if (installedVer === VERSION) {
      console.log(`Skill for ${tool} is already at v${VERSION}.`);
      return;
    }
    const ans = await prompt(`Update ${tool} skill from v${installedVer} → v${VERSION}? (Y/n) `);
    if (ans.toLowerCase() === 'n') {
      console.log('Cancelled.');
      return;
    }
  }

  await installToPath(path);
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

      const installedVer = await getInstalledVersion(skillFile);
      if (installedVer === VERSION) {
        current++;
        continue;
      }

      console.log(`Updating ${t} (${level}): v${installedVer || '?'} → v${VERSION}`);
      try {
        await installToPath(path);
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
