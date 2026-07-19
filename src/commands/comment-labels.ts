import { readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { loadConfig } from '../lib/config.js';
import { TossAPI, TossAPIError } from '../lib/api.js';
import {
  CommentLabelValidationError,
  commentLabelDocument,
  emptyCommentLabelDocument,
  normalizeCommentLabelColor,
  parseCommentLabelDocument,
  serializeCommentLabelDocument,
  validateCommentLabelDocument,
  validateCommentLabelKey,
  type CommentLabel,
  type CommentLabelRegistry,
} from '../lib/comment-labels.js';
import { promptConfirm, promptDefault, promptValidated } from '../lib/prompt.js';

type CommonOptions = { profile?: string; json?: boolean; yes?: boolean; force?: boolean; dryRun?: boolean };
export type CommentLabelCreateOptions = CommonOptions & Partial<Omit<CommentLabel, 'enabled' | 'position'>> & { enabled?: boolean | string; position?: number | string };
export type CommentLabelEditOptions = CommonOptions & Partial<Omit<CommentLabel, 'key' | 'enabled' | 'position'>> & { enabled?: boolean | string; position?: number | string };

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
  throw new Error(message);
}

function formatError(error: unknown): string {
  if (error instanceof CommentLabelValidationError) return error.problems.join('\n  ');
  if (error instanceof TossAPIError) {
    const details = error.details;
    const code = typeof details.error === 'string' ? ` (${details.error})` : '';
    const message = typeof details.message === 'string' ? details.message : error.message;
    const context = [
      typeof details.field === 'string' ? `Field: ${details.field}` : '',
      typeof details.key === 'string' ? `Key: ${details.key}` : '',
      Number.isInteger(details.expectedRevision) ? `Expected revision: ${details.expectedRevision}` : '',
      Number.isInteger(details.actualRevision) ? `Actual revision: ${details.actualRevision}` : '',
      typeof details.hint === 'string' ? details.hint : '',
    ].filter(Boolean);
    return `${message}${code}${context.length ? `\n  ${context.join('\n  ')}` : ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function ownerApi(profile?: string): Promise<TossAPI> {
  const config = await loadConfig(profile);
  if (!config) fail('No toss connection found. Run "toss login <endpoint> --token <token>" or "toss admin deploy" first.');
  if (config.role === 'member') fail('Comment labels are owner-only. Select an owner profile.');
  if (config.backend !== 'vercel') fail(`Comment labels are only available on Vercel deployments.${profile ? ` Profile "${profile}" is not Vercel-backed.` : ''}`);
  return new TossAPI(config);
}

function parseBoolean(value: boolean | string | undefined, field: string): boolean | undefined {
  if (typeof value === 'boolean' || value === undefined) return value;
  if (value === 'true' || value === 'yes' || value === '1') return true;
  if (value === 'false' || value === 'no' || value === '0') return false;
  fail(`${field} must be true or false.`);
}

function parsePosition(value: number | string | undefined, field = '--position'): number | undefined {
  if (value === undefined) return undefined;
  const position = Number(value);
  if (!Number.isInteger(position) || position < 1) fail(`${field} must be a positive integer.`);
  return position;
}

function validateLabelFields(label: CommentLabel): void {
  const { key, label: text, description, color, enabled, position } = label;
  validateCommentLabelDocument({
    $schema: 'toss/comment-labels@v1',
    version: 1,
    commentLabels: [{ key, label: text, description, color, enabled, position: Math.max(1, position) }],
  });
}

function isInteractive(options: CommonOptions): boolean {
  return process.stdin.isTTY === true && !options.json;
}

function hasEditChanges(options: CommentLabelEditOptions): boolean {
  return options.label !== undefined
    || options.description !== undefined
    || options.color !== undefined
    || options.enabled !== undefined
    || options.position !== undefined;
}

function printPreview(name: string, preview: Record<string, any>, json = false): void {
  const output = JSON.stringify(preview, null, 2);
  if (json) console.log(output);
  else console.error(`${name} preview:\n${output}`);
}

function printRegistry(registry: CommentLabelRegistry, json = false): void {
  if (json) {
    console.log(JSON.stringify({ commentLabelRevision: registry.revision, commentLabels: registry.labels }, null, 2));
    return;
  }
  if (!registry.labels.length) {
    console.log('No comment labels configured — comments are unlabeled until you add labels.');
    console.log('  Create one:           toss admin comment-labels create');
    console.log('  Scaffold a template:  toss admin comment-labels template');
    return;
  }
  console.log('POS  KEY                  LABEL                 COLOR     ENABLED  COMMENTS');
  for (const row of registry.labels.slice().sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))) {
    console.log(`${String(row.position).padEnd(5)}${row.key.padEnd(21)}${row.label.padEnd(22)}${row.color.padEnd(10)}${(row.enabled ? 'yes' : 'no').padEnd(9)}${row.usageCount ?? 0}`);
  }
  console.log(`\nRevision ${registry.revision} · ${registry.labels.length} label(s) · ${registry.labels.filter((row) => row.enabled).length} enabled`);
}

async function writeOutput(file: string | undefined, content: string, force = false): Promise<void> {
  if (!file) { process.stdout.write(content); return; }
  if (!force) {
    try { await access(file, constants.F_OK); fail(`${file} already exists. Use --force to overwrite it.`); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  await writeFile(file, content, 'utf8');
}

async function readInput(file: string): Promise<string> {
  if (file !== '-') return readFile(file, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

export async function commentLabelsListCommand(options: CommonOptions = {}): Promise<void> {
  try { printRegistry(await (await ownerApi(options.profile)).getCommentLabels(), options.json); }
  catch (error) { fail(formatError(error)); }
}

export async function commentLabelsCreateCommand(options: CommentLabelCreateOptions = {}): Promise<void> {
  try {
    if (options.json && (!options.key || !options.label || options.description === undefined || !options.color || options.enabled === undefined)) {
      fail('--json create requires --key, --label, --description, --color, and --enabled; --position is optional and appends when omitted.');
    }
    const api = await ownerApi(options.profile);
    const current = await api.getCommentLabels();
    let key = options.key;
    let label = options.label;
    let description = options.description;
    let color = options.color;
    let enabled = parseBoolean(options.enabled, '--enabled');
    let position = parsePosition(options.position);
    if (isInteractive(options)) {
      label = label ?? await promptDefault('Label', '');
      key = key ?? await promptValidated('Key', (value) => { validateCommentLabelKey(value); return value; }, label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32));
      color = color ?? await promptValidated('Color (#RRGGBB)', normalizeCommentLabelColor, '#667085');
      description = description ?? await promptDefault('Description (optional)', '');
      position = position ?? Number(await promptValidated('Position', (value) => { const parsed = parsePosition(value, 'Position'); return String(parsed); }, String(current.labels.length + 1)));
      enabled = enabled ?? true;
    }
    if (!key || !label || description === undefined || !color || enabled === undefined) fail('non-interactive create requires --key, --label, --description, --color, and --enabled.');
    validateCommentLabelKey(key);
    color = normalizeCommentLabelColor(color);
    const candidate = { key, label: label.trim(), description: description.trim(), color, enabled, position: position ?? current.labels.length + 1 };
    validateLabelFields(candidate);
    const { position: candidatePosition, ...withoutPosition } = candidate;
    const result = await api.createCommentLabel(current.revision, { ...withoutPosition, ...(position ? { position: candidatePosition } : {}) });
    if (options.json) printRegistry(result, true);
    else console.log(`Created comment label "${key}" at revision ${result.revision}.`);
  } catch (error) { fail(formatError(error)); }
}

export async function commentLabelsEditCommand(key: string, options: CommentLabelEditOptions = {}): Promise<void> {
  try {
    validateCommentLabelKey(key);
    if (options.json && !hasEditChanges(options)) fail('--json edit requires at least one of --label, --description, --color, --enabled, or --position.');
    const api = await ownerApi(options.profile);
    const current = await api.getCommentLabels();
    const row = current.labels.find((label) => label.key === key);
    if (!row) fail(`Comment label "${key}" was not found.`);
    const changes: Partial<Omit<CommentLabel, 'key'>> = {};
    if (isInteractive(options)) {
      changes.label = options.label ?? await promptDefault('Label', row.label);
      changes.description = options.description ?? await promptDefault('Description', row.description);
      changes.color = normalizeCommentLabelColor(options.color ?? await promptDefault('Color', row.color));
      changes.enabled = parseBoolean(options.enabled, '--enabled') ?? row.enabled;
      changes.position = parsePosition(options.position) ?? parsePosition(await promptDefault('Position', String(row.position)), 'Position');
    } else {
      if (options.label !== undefined) changes.label = options.label.trim();
      if (options.description !== undefined) changes.description = options.description.trim();
      if (options.color !== undefined) changes.color = normalizeCommentLabelColor(options.color);
      if (options.enabled !== undefined) changes.enabled = parseBoolean(options.enabled, '--enabled');
      if (options.position !== undefined) changes.position = parsePosition(options.position);
      if (!Object.keys(changes).length) fail('non-interactive edit requires at least one change flag.');
    }
    validateLabelFields({ ...row, ...changes });
    const result = await api.updateCommentLabel(key, current.revision, changes);
    if (options.json) printRegistry(result, true); else console.log(`Updated comment label "${key}" at revision ${result.revision}.`);
  } catch (error) { fail(formatError(error)); }
}

export async function commentLabelsSetEnabledCommand(key: string, enabled: boolean, options: CommonOptions = {}): Promise<void> {
  try {
    validateCommentLabelKey(key);
    const api = await ownerApi(options.profile);
    const current = await api.getCommentLabels();
    if (!current.labels.some((label) => label.key === key)) fail(`Comment label "${key}" was not found.`);
    const result = await api.updateCommentLabel(key, current.revision, { enabled });
    if (options.json) printRegistry(result, true); else console.log(`${enabled ? 'Enabled' : 'Disabled'} comment label "${key}".`);
  } catch (error) { fail(formatError(error)); }
}

export async function commentLabelsDeleteCommand(key: string, options: CommonOptions = {}): Promise<void> {
  try {
    validateCommentLabelKey(key);
    if (options.json && !options.yes) fail('--json delete requires --yes.');
    const api = await ownerApi(options.profile);
    const current = await api.getCommentLabels();
    const row = current.labels.find((label) => label.key === key);
    if (!row) fail(`Comment label "${key}" was not found.`);
    if (row.usageCount > 0) fail(`Cannot delete "${key}" — ${row.usageCount} comment(s) use this label. Disable it to preserve historical comments.`);
    if (!options.yes) {
      if (!isInteractive(options)) fail('non-interactive delete requires --yes.');
      if (!await promptConfirm(`Delete comment label "${key}"? This cannot be undone.`, false)) { console.error('Cancelled.'); return; }
    }
    const result = await api.deleteCommentLabel(key, current.revision);
    if (options.json) printRegistry(result, true); else console.log(`Deleted comment label "${key}".`);
  } catch (error) { fail(formatError(error)); }
}

export async function commentLabelsReorderCommand(keys: string[], options: CommonOptions = {}): Promise<void> {
  try {
    if (options.json && !keys.length) fail('--json reorder requires every configured label key as an argument.');
    const api = await ownerApi(options.profile);
    const current = await api.getCommentLabels();
    if (!keys.length && isInteractive(options)) keys = (await promptDefault('Order (space-separated keys)', current.labels.map((row) => row.key).join(' '))).split(/\s+/).filter(Boolean);
    const expected = current.labels.map((row) => row.key).sort();
    if (keys.length !== expected.length || new Set(keys).size !== keys.length || keys.slice().sort().some((key, i) => key !== expected[i])) fail('reorder requires every configured label key exactly once.');
    if (isInteractive(options)) {
      console.error(`New order: ${keys.join(', ')}`);
      if (!await promptConfirm('Apply this comment-label order?', true)) { console.error('Cancelled.'); return; }
    }
    const result = await api.reorderCommentLabels(current.revision, keys);
    if (options.json) printRegistry(result, true); else console.log(`Reordered ${keys.length} comment label(s).`);
  } catch (error) { fail(formatError(error)); }
}

export async function commentLabelsTemplateCommand(file?: string, options: CommonOptions = {}): Promise<void> {
  try {
    await writeOutput(file, serializeCommentLabelDocument(emptyCommentLabelDocument()), options.force);
    if (file) console.error(`Wrote ${file} — an empty, valid comment-label template.`);
  } catch (error) { fail(formatError(error)); }
}

export async function commentLabelsExportCommand(file?: string, options: CommonOptions = {}): Promise<void> {
  try {
    const current = await (await ownerApi(options.profile)).getCommentLabels();
    await writeOutput(file, serializeCommentLabelDocument(commentLabelDocument(current.labels)), options.force);
    if (file) console.error(`Exported ${current.labels.length} comment label(s) to ${file}.`);
  } catch (error) { fail(formatError(error)); }
}

function revisionFromPreview(preview: Record<string, any>): number {
  const revision = preview.commentLabelRevision ?? preview.revision;
  if (!Number.isInteger(revision)) fail('The server preview did not include a comment-label revision.');
  return revision;
}

function validateMutationMode(options: CommonOptions): void {
  if (options.dryRun && options.yes) fail('--dry-run and --yes are mutually exclusive.');
  if (options.json && !options.dryRun && !options.yes) fail('--json requires --dry-run or --yes.');
  if (!isInteractive(options) && !options.dryRun && !options.yes) fail('non-interactive mutation requires --yes (or use --dry-run).');
}

export async function commentLabelsApplyCommand(file: string, options: CommonOptions = {}): Promise<void> {
  try {
    validateMutationMode(options);
    const document = parseCommentLabelDocument(await readInput(file));
    const api = await ownerApi(options.profile);
    const preview = await api.previewCommentLabelApply(document);
    if (options.dryRun) { printPreview('Merge', preview, options.json); return; }
    if (!options.json) printPreview('Merge', preview);
    if (!options.yes && !await promptConfirm('Apply these merge changes?', true)) { console.error('Cancelled.'); return; }
    const result = await api.applyCommentLabels(revisionFromPreview(preview), document);
    if (options.json) printRegistry(result, true); else console.log(`Applied comment-label changes at revision ${result.revision}.`);
  } catch (error) { fail(formatError(error)); }
}

export async function commentLabelsClearCommand(options: CommonOptions = {}): Promise<void> {
  try {
    validateMutationMode(options);
    const api = await ownerApi(options.profile);
    const preview = await api.previewCommentLabelClear();
    if (options.dryRun) { printPreview('Clear', preview, options.json); return; }
    if (!options.json) printPreview('Clear', preview);
    if (!options.yes && !await promptConfirm('Clear all configured comment labels?', false)) { console.error('Cancelled.'); return; }
    const result = await api.clearCommentLabels(revisionFromPreview(preview));
    if (options.json) printRegistry(result, true); else console.log(`Clear complete at revision ${result.revision}. No selectable labels remain.`);
  } catch (error) { fail(formatError(error)); }
}
