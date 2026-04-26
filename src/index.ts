#!/usr/bin/env node
import { Command } from 'commander';
import { deployCommand } from './commands/deploy.js';
import { shareCommand } from './commands/share.js';
import { listCommand } from './commands/list.js';
import { revokeCommand } from './commands/revoke.js';
import { destroyCommand } from './commands/destroy.js';
import { doctorCommand } from './commands/doctor.js';
import { infoCommand } from './commands/info.js';
import { setupCommand } from './commands/setup.js';
import { skillInstallCommand, skillUninstallCommand, skillListCommand, skillUpdateCommand } from './commands/skill.js';
import { tokenCreateCommand, tokenListCommand, tokenRevokeCommand, tokenRotateCommand } from './commands/token.js';
import { joinCommand } from './commands/join.js';
import { profileListCommand, profileSwitchCommand, profileShowCommand, profileDeleteCommand } from './commands/profile.js';

const program = new Command();

program
  .name('toss')
  .description('Share HTML artifacts with access-controlled links')
  .version('0.1.0');

program
  .command('deploy')
  .description('Deploy your toss infrastructure to Cloudflare')
  .option('-d, --domain <domain>', 'Custom domain (must be on Cloudflare)')
  .option('--multi-tenant', 'Enable multi-user team mode')
  .option('--profile <name>', 'Deploy to a specific profile (uses stored API token)')
  .action(deployCommand);

program
  .command('share <file>')
  .description('Share an HTML file')
  .requiredOption('-e, --expires <duration>', 'Link lifetime: 1h, 24h, 7d, 30d')
  .option('-c, --clipboard', 'Copy link to clipboard')
  .option('-j, --json', 'Output JSON')
  .option('-p, --password <password>', 'Password-protect this share')
  .option('--profile <name>', 'Use a specific profile')
  .action(shareCommand);

program
  .command('list')
  .description('List your shared artifacts')
  .option('--profile <name>', 'Use a specific profile')
  .action(listCommand);

program
  .command('revoke <id>')
  .description('Revoke access to an artifact')
  .option('--profile <name>', 'Use a specific profile')
  .action(revokeCommand);

program
  .command('destroy')
  .description('Destroy your toss infrastructure')
  .option('--profile <name>', 'Use a specific profile')
  .action(destroyCommand);

program
  .command('setup')
  .description('One-time setup: install wrangler, login, check subdomain')
  .action(setupCommand);

program
  .command('doctor')
  .description('Check prerequisites for toss')
  .action(doctorCommand);

program
  .command('info')
  .description('Show toss configuration and artifact count')
  .option('--profile <name>', 'Use a specific profile')
  .action(infoCommand);

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

const token = program
  .command('token')
  .description('Manage upload tokens (admin only)');

token
  .command('create')
  .description('Create a new user token')
  .requiredOption('-l, --label <label>', 'Name for the token (e.g. teammate name)')
  .action(tokenCreateCommand);

token
  .command('list')
  .description('List all authorized tokens')
  .action(tokenListCommand);

token
  .command('revoke <hash>')
  .description('Revoke a user token by hash prefix')
  .action(tokenRevokeCommand);

token
  .command('rotate')
  .description('Regenerate admin token (invalidates old one)')
  .action(tokenRotateCommand);

program
  .command('join <endpoint>')
  .description('Join a shared toss instance (one-line setup)')
  .requiredOption('-t, --token <token>', 'Your upload token')
  .option('-p, --profile <name>', 'Save as named profile')
  .action(joinCommand);

program.parse();
