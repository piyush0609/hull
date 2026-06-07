#!/usr/bin/env node
import { Command } from 'commander';
import { shareCommand } from './commands/share.js';
import { listCommand } from './commands/list.js';
import { revokeCommand } from './commands/revoke.js';
import { commentsCommand } from './commands/comments.js';
import { doctorCommand } from './commands/doctor.js';
import { infoCommand } from './commands/info.js';
import { skillInstallCommand, skillUninstallCommand, skillListCommand, skillUpdateCommand } from './commands/skill.js';
import { tokenCreateCommand, tokenListCommand, tokenRevokeCommand, tokenRotateCommand } from './commands/token.js';
import { joinCommand } from './commands/join.js';
import { profileListCommand, profileSwitchCommand, profileShowCommand, profileDeleteCommand, profileDefaultCommand, profileRenameCommand } from './commands/profile.js';
import { loadConfig } from './lib/config.js';
import { getCommandOptions } from './lib/cli-options.js';
import { whoamiCommand } from './commands/whoami.js';
import { membersListCommand } from './commands/members.js';
import { cleanupCommand } from './commands/cleanup.js';
import { BackendValidationError, getBackendHandler, resolveBackendForCommand, resolveBackendForSetup } from './lib/backend-router.js';

async function withBackendErrors<T>(fn: () => Promise<T>): Promise<T | void> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BackendValidationError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

async function routeDeploy(options: any) {
  await withBackendErrors(async () => {
    const backend = resolveBackendForCommand(options.backend, (await loadConfig(options.profile))?.backend);
    await getBackendHandler(backend).deploy({ ...options, backend });
  });
}

async function routeSetup(options: any) {
  await withBackendErrors(async () => {
    const profileBackend = (await loadConfig(options.profile))?.backend;
    const backend = await resolveBackendForSetup({
      requestedBackend: options.backend,
      profileBackend,
      promptOnMissing: process.stdin.isTTY && !options.yes,
    });
    await getBackendHandler(backend).setup({ ...options, backend });
  });
}

async function routeDestroy(options: any) {
  await withBackendErrors(async () => {
    const backend = resolveBackendForCommand(options.backend, (await loadConfig(options.profile))?.backend);
    await getBackendHandler(backend).destroy({ ...options, backend });
  });
}

type PublishOptions = {
  expires?: string;
  id?: string;
  clipboard?: boolean;
  json?: boolean;
  password?: string | true;
  profile?: string;
  comments?: boolean;
};

async function routePublish(file = '.', options: PublishOptions = {}) {
  // Pass `expires` through unchanged: undefined = permanent, per main's contract.
  // Do NOT silently default to '24h' here — that would silently shorten links.
  await shareCommand(file, {
    expires: options.expires,
    id: options.id,
    clipboard: options.clipboard,
    json: options.json,
    password: options.password,
    profile: options.profile,
    comments: options.comments,
  });
}

const program = new Command();

program
  .name('toss')
  .description('Publish HTML files and folders with a simple share link')
  .version('0.1.0')
  .argument('[path]', 'File or folder to publish', '.')
  // No default for --expires: omitted means permanent (matches `toss publish` /
  // `toss share` semantics). The CLI must NOT silently shorten links to 24h.
  .option('-e, --expires <duration>', 'Link lifetime: 1h, 24h, 7d, 30d (omit for permanent)')
  .option('--id <slug>', 'Stable URL slug — re-running with same id replaces the content (single file only)')
  .option('-c, --clipboard', 'Copy link to clipboard')
  .option('-j, --json', 'Output JSON')
  .option('-p, --password [password]', 'Password-protect this publish (omit value for secure prompt)')
  .option('--comments', 'Enable comments on this share (off by default)')
  .option('--profile <name>', 'Use a specific profile')
  .action((path, ...args) => routePublish(path, getCommandOptions(args, ['expires', 'id', 'clipboard', 'json', 'password', 'comments', 'profile'])));

program.addHelpText('after', `
Quick start:
  User on an existing toss service:
    toss login https://share.example.com --token <your-token>
    toss ./report.html
    toss list

  Owner deploying a new toss service:
    toss admin setup
    toss admin deploy
    toss admin token create --label alice

  Local repo usage before install:
    ./toss --help
    ./toss ./report.html
`);

program
  .command('publish [path]')
  .alias('share')
  .description('Publish an HTML file or folder')
  .option('-e, --expires <duration>', 'Link lifetime: 1h, 24h, 7d, 30d (omit for permanent)')
  .option('--id <slug>', 'Stable URL slug — re-running with same id replaces the content (single file only)')
  .option('-c, --clipboard', 'Copy link to clipboard')
  .option('-j, --json', 'Output JSON')
  .option('-p, --password [password]', 'Password-protect this publish (omit value for secure prompt)')
  .option('--comments', 'Enable comments on this share (off by default)')
  .option('--profile <name>', 'Use a specific profile')
  .action((path, ...args) => routePublish(path, getCommandOptions(args, ['expires', 'id', 'clipboard', 'json', 'password', 'comments', 'profile'])));

program
  .command('login <endpoint>')
  .alias('join')
  .description('Connect toss to an existing deployed service')
  .requiredOption('-t, --token <token>', 'Your upload token')
  .option('--profile <name>', 'Save as named profile')
  .action((endpoint, ...args) => {
    const options = getCommandOptions(args, ['token', 'profile']);
    return joinCommand(endpoint, { token: options.token, profile: options.profile });
  });

program
  .command('list')
  .description('List your published artifacts')
  .option('--profile <name>', 'Use a specific profile')
  .action((...args) => listCommand(getCommandOptions(args, ['profile'])));

program
  .command('revoke <id>')
  .description('Revoke access to a published artifact')
  .option('--profile <name>', 'Use a specific profile')
  .action((id, ...args) => revokeCommand(id, getCommandOptions(args, ['profile'])));

program
  .command('comments <id> <state>')
  .description('Enable or disable comments on a share (state: on|off)')
  .option('--profile <name>', 'Use a specific profile')
  .action((id, state, ...args) => commentsCommand(id, state, getCommandOptions(args, ['profile'])));

program
  .command('info')
  .description('Show toss connection details and artifact count')
  .option('--profile <name>', 'Use a specific profile')
  .action((...args) => infoCommand(getCommandOptions(args, ['profile'])));

program
  .command('whoami')
  .description('Show the current profile, role, and endpoint')
  .option('--profile <name>', 'Use a specific profile')
  .action((...args) => whoamiCommand(getCommandOptions(args, ['profile'])));

program
  .command('doctor')
  .description('Check owner-side setup prerequisites')
  .action(doctorCommand);

const profile = program
  .command('profile')
  .description('Manage toss profiles');

profile
  .command('list')
  .description('List all profiles')
  .action(profileListCommand);

profile
  .command('switch <name>')
  .description('Switch active profile')
  .action(profileSwitchCommand);

profile
  .command('show')
  .description('Show current profile')
  .action(profileShowCommand);

profile
  .command('default [name]')
  .description('Show or set the active profile')
  .action(profileDefaultCommand);

profile
  .command('rename <old> <new>')
  .description('Rename a profile')
  .action(profileRenameCommand);

profile
  .command('delete <name>')
  .description('Delete a profile')
  .action(profileDeleteCommand);

const admin = program
  .command('admin')
  .description('Owner-only deployment and infrastructure commands');

admin
  .command('deploy')
  .description('Create or update the shared toss service')
  .option('-d, --domain <domain>', 'Custom domain')
  .option('--multi-tenant', 'Enable multi-user team mode')
  .option('--profile <name>', 'Deploy to a specific profile')
  .option('--subdomain <name>', 'Deployment suffix (overrides TOSS_SUBDOMAIN env)')
  .option('--backend <backend>', 'Deployment backend: cloudflare or vercel')
  .option('--postgres-url <url>', 'Postgres connection string (Vercel only)')
  .option('--blob-token <token>', 'Vercel Blob read-write token (Vercel only)')
  .option('-y, --yes', 'Skip interactive prompts')
  .option('--skip-migrate', 'Skip DB migrations — only when the schema is already applied or the DB is unreachable')
  .action((...args) => routeDeploy(getCommandOptions(args, ['domain', 'multiTenant', 'profile', 'subdomain', 'backend', 'postgresUrl', 'blobToken', 'yes', 'skipMigrate'])));

admin
  .command('setup')
  .description('One-time owner setup: login and verify prerequisites')
  .option('--profile <name>', 'Configure auth for a specific profile')
  .option('--subdomain <name>', 'Set the deployment suffix (overrides TOSS_SUBDOMAIN env)')
  .option('-y, --yes', 'Auto-accept defaults (non-interactive)')
  .option('--backend <backend>', 'Target backend: cloudflare or vercel')
  .action((...args) => routeSetup(getCommandOptions(args, ['profile', 'subdomain', 'yes', 'backend'])));

admin
  .command('destroy')
  .description('Delete the shared toss service')
  .option('--profile <name>', 'Use a specific profile')
  .option('--backend <backend>', 'Target backend: cloudflare or vercel')
  .option('-y, --yes', 'Skip confirmation')
  .action((...args) => routeDestroy(getCommandOptions(args, ['profile', 'backend', 'yes'])));

admin
  .command('members')
  .description('List members on the shared toss service')
  .option('--profile <name>', 'Use a specific owner profile')
  .action((...args) => membersListCommand(getCommandOptions(args, ['profile'])));

admin
  .command('cleanup')
  .description('Delete expired artifacts from the shared toss service')
  .option('--profile <name>', 'Use a specific owner profile')
  .option('-y, --yes', 'Skip confirmation')
  .action((...args) => cleanupCommand(getCommandOptions(args, ['profile', 'yes'])));

const token = admin
  .command('token')
  .description('Manage upload tokens for teammates');

token
  .command('create')
  .description('Create a new user token')
  .requiredOption('-l, --label <label>', 'Name for the token (e.g. teammate name)')
  .option('--profile <name>', 'Use a specific owner profile')
  .action((...args) => {
    const options = getCommandOptions(args, ['label', 'profile']);
    return tokenCreateCommand({ label: options.label, profile: options.profile });
  });

token
  .command('list')
  .description('List all authorized tokens')
  .option('--profile <name>', 'Use a specific owner profile')
  .action((...args) => tokenListCommand(getCommandOptions(args, ['profile'])));

token
  .command('revoke <hash>')
  .description('Revoke a user token by hash prefix')
  .option('--profile <name>', 'Use a specific owner profile')
  .action((hash, ...args) => tokenRevokeCommand(hash, getCommandOptions(args, ['profile'])));

token
  .command('rotate')
  .description('Regenerate admin token (invalidates old one)')
  .option('--profile <name>', 'Use a specific owner profile')
  .action((...args) => tokenRotateCommand(getCommandOptions(args, ['profile'])));

const skill = program
  .command('skill')
  .description('Install toss skills for AI assistants');

skill
  .command('install [tool]')
  .description('Install skill for an AI tool (or --all for all detected)')
  .option('-a, --all', 'Install to all detected tools')
  .option('-l, --level <level>', 'Install level: user (default) or project', 'user')
  .action(skillInstallCommand);

skill
  .command('uninstall <tool>')
  .description('Remove toss skill from an AI tool')
  .option('-l, --level <level>', 'Uninstall level: user (default) or project', 'user')
  .action(skillUninstallCommand);

skill
  .command('list')
  .description('Show skill installation status across tools')
  .action(skillListCommand);

skill
  .command('update [tool]')
  .description('Update outdated skills (or all if no tool specified)')
  .action(skillUpdateCommand);

program
  .command('deploy', { hidden: true })
  .option('-d, --domain <domain>')
  .option('--multi-tenant')
  .option('--profile <name>')
  .option('--subdomain <name>')
  .option('--backend <backend>', 'Deployment backend: cloudflare or vercel')
  .option('--postgres-url <url>')
  .option('--blob-token <token>')
  .option('-y, --yes')
  .action((...args) => routeDeploy(getCommandOptions(args, ['domain', 'multiTenant', 'profile', 'subdomain', 'backend', 'postgresUrl', 'blobToken', 'yes'])));

program
  .command('setup', { hidden: true })
  .option('--profile <name>')
  .option('--subdomain <name>')
  .option('-y, --yes')
  .option('--backend <backend>', 'Target backend: cloudflare or vercel')
  .action((...args) => routeSetup(getCommandOptions(args, ['profile', 'subdomain', 'yes', 'backend'])));

program
  .command('destroy', { hidden: true })
  .option('--profile <name>')
  .option('--backend <backend>', 'Target backend: cloudflare or vercel')
  .option('-y, --yes')
  .action((...args) => routeDestroy(getCommandOptions(args, ['profile', 'backend', 'yes'])));

const legacyToken = program
  .command('token', { hidden: true });

legacyToken
  .command('create', { hidden: true })
  .requiredOption('-l, --label <label>')
  .option('--profile <name>')
  .action(tokenCreateCommand);

legacyToken
  .command('list', { hidden: true })
  .option('--profile <name>')
  .action(tokenListCommand);

legacyToken
  .command('revoke <hash>', { hidden: true })
  .option('--profile <name>')
  .action(tokenRevokeCommand);

legacyToken
  .command('rotate', { hidden: true })
  .option('--profile <name>')
  .action(tokenRotateCommand);

program.parse();
