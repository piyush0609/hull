import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMENT_LABEL_SCHEMA,
  CommentLabelValidationError,
  codePointLength,
  commentLabelDocument,
  emptyCommentLabelDocument,
  normalizeCommentLabelColor,
  parseCommentLabelDocument,
  serializeCommentLabelDocument,
  validateCommentLabelDocument,
} from '../../src/lib/comment-labels.js';
import {
  commentLabelsApplyCommand,
  commentLabelsClearCommand,
  commentLabelsCreateCommand,
  commentLabelsDeleteCommand,
  commentLabelsEditCommand,
  commentLabelsExportCommand,
  commentLabelsListCommand,
  commentLabelsReorderCommand,
  commentLabelsSetEnabledCommand,
  commentLabelsTemplateCommand,
} from '../../src/commands/comment-labels.js';
import * as config from '../../src/lib/config.js';

const row = {
  key: 'release-risk',
  label: 'Release risk',
  description: 'Worth another look',
  color: '#d97706',
  enabled: true,
  position: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

describe('comment-label document contract', () => {
  it('creates a deterministic empty v1 template with label terminology', () => {
    expect(serializeCommentLabelDocument(emptyCommentLabelDocument())).toBe(
      '{\n  "$schema": "toss/comment-labels@v1",\n  "version": 1,\n  "commentLabels": []\n}\n'
    );
  });

  it('round trips unlimited labels and canonicalizes colors', () => {
    const labels = Array.from({ length: 100 }, (_, index) => ({
      ...row,
      key: `label-${index}`,
      label: `Label ${index}`,
      position: index + 1,
    }));
    const document = commentLabelDocument(labels);
    expect(document.commentLabels).toHaveLength(100);
    expect(document.commentLabels[0].color).toBe('#D97706');
    expect(parseCommentLabelDocument(serializeCommentLabelDocument(document))).toEqual(document);
  });

  it.each(['d97706', '#d97706', '#D97706'])('normalizes %s to uppercase #RRGGBB', (color) => {
    expect(normalizeCommentLabelColor(color)).toBe('#D97706');
  });

  it.each(['red', '#fff', '#12345678', '#GG0000', ''])('rejects invalid color %j', (color) => {
    expect(() => normalizeCommentLabelColor(color)).toThrow(CommentLabelValidationError);
  });

  it('counts Unicode code points rather than UTF-16 code units', () => {
    expect(codePointLength('😀'.repeat(50))).toBe(50);
    expect(codePointLength('😀'.repeat(81))).toBe(81);
  });

  it('accepts 50 emoji labels and rejects labels above 80 code points', () => {
    const base = { $schema: COMMENT_LABEL_SCHEMA, version: 1, commentLabels: [{ ...row, label: '😀'.repeat(50) }] };
    expect(validateCommentLabelDocument(base).commentLabels[0].label).toBe('😀'.repeat(50));
    expect(() => validateCommentLabelDocument({
      ...base,
      commentLabels: [{ ...row, label: '😀'.repeat(81) }],
    })).toThrowError(expect.objectContaining({ problems: expect.arrayContaining([
      'commentLabels[0].label must be between 1 and 80 characters',
    ]) }));
  });

  it('uses code-point boundaries for non-BMP descriptions', () => {
    const base = { $schema: COMMENT_LABEL_SCHEMA, version: 1, commentLabels: [{ ...row, description: '𐐷'.repeat(240) }] };
    expect(validateCommentLabelDocument(base).commentLabels[0].description).toBe('𐐷'.repeat(240));
    expect(() => validateCommentLabelDocument({
      ...base,
      commentLabels: [{ ...row, description: '𐐷'.repeat(241) }],
    })).toThrowError(expect.objectContaining({ problems: expect.arrayContaining([
      'commentLabels[0].description must be a string of at most 240 characters',
    ]) }));
  });

  it('rejects unknown fields, unsupported envelopes, reserved and duplicate keys, and bad positions together', () => {
    expect(() => validateCommentLabelDocument({
      $schema: 'toss/comment-types@v1',
      version: 2,
      commentLabels: [
        { ...row, key: 'resolution', position: 2, blocking: true },
        { ...row, key: 'resolution', position: 2 },
      ],
      types: [],
    })).toThrowError(expect.objectContaining({
      problems: expect.arrayContaining([
        'unknown field "types"',
        `$schema must be "${COMMENT_LABEL_SCHEMA}"`,
        'version must be 1',
        'commentLabels[0].key "resolution" is reserved',
        'commentLabels[0]: unknown field "blocking"',
        'commentLabels[1].key "resolution" is reserved',
        'commentLabels[1].position duplicates commentLabels[0].position',
      ]),
    }));
  });

  it('rejects malformed fields', () => {
    expect(() => validateCommentLabelDocument({
      $schema: COMMENT_LABEL_SCHEMA,
      version: 1,
      commentLabels: [{ key: 'Bad Key', label: ' '.repeat(2), description: 1, color: 'red', enabled: 'yes', position: 3 }],
    })).toThrowError(expect.objectContaining({ problems: expect.arrayContaining([
      'commentLabels[0].key must match ^[a-z0-9][a-z0-9-]{0,31}$',
      'commentLabels[0].label must be between 1 and 80 characters',
      'commentLabels[0].description must be a string of at most 240 characters',
      'commentLabels[0].color must be a hex color like #9F3826',
      'commentLabels[0].enabled must be a boolean',
    ]) }));
  });

  it('allows sparse unique positions in merge documents because omitted rows fill gaps', () => {
    expect(validateCommentLabelDocument({
      $schema: COMMENT_LABEL_SCHEMA,
      version: 1,
      commentLabels: [{ ...row, position: 4 }],
    }).commentLabels[0].position).toBe(4);
  });

  it('sorts exports by position and excludes owner-only usage data', () => {
    const document = commentLabelDocument([
      { ...row, key: 'second', position: 2, usageCount: 4 } as any,
      { ...row, key: 'first', position: 1, usageCount: 9 } as any,
    ]);
    expect(document.commentLabels.map((label) => label.key)).toEqual(['first', 'second']);
    expect(document.commentLabels[0]).not.toHaveProperty('usageCount');
  });
});

describe('comment-label owner commands', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => { throw new Error(`process.exit(${code})`); });
    vi.spyOn(config, 'loadConfig').mockResolvedValue({ endpoint: 'https://example.com', token: 'owner', subdomain: 'test', role: 'owner', backend: 'vercel' });
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates with the revision read immediately before mutation and canonical color', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"commentLabelRevision":11,"commentLabels":[]}' } as Response)
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '{"commentLabelRevision":12,"commentLabels":[]}' } as Response);
    await commentLabelsCreateCommand({ key: 'risk', label: 'Risk', description: '', color: 'aabbcc', enabled: 'true', json: true });
    expect(JSON.parse(String((global.fetch as any).mock.calls[1][1].body))).toEqual({
      expectedRevision: 11,
      commentLabel: { key: 'risk', label: 'Risk', description: '', color: '#AABBCC', enabled: true },
    });
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ commentLabelRevision: 12, commentLabels: [] });
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('applies code-point limits at create and edit command validation boundaries', async () => {
    const accepted = { ...row, label: '😀'.repeat(50), description: '𐐷'.repeat(240), color: '#D97706', usageCount: 0 };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ revision: 1, commentLabels: [] }))
      .mockResolvedValueOnce(jsonResponse({ revision: 2, commentLabels: [accepted] }, 201));
    await commentLabelsCreateCommand({
      key: accepted.key,
      label: accepted.label,
      description: accepted.description,
      color: accepted.color,
      enabled: true,
      json: true,
    });
    expect(log).toHaveBeenCalledTimes(1);

    log.mockClear();
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 2, commentLabels: [accepted] }));
    await expect(commentLabelsEditCommand(accepted.key, { label: '😀'.repeat(81), json: true })).rejects.toThrow('process.exit(1)');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('label must be between 1 and 80 characters'));

    error.mockClear();
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 2, commentLabels: [accepted] }));
    await expect(commentLabelsEditCommand(accepted.key, { description: '𐐷'.repeat(241), json: true })).rejects.toThrow('process.exit(1)');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('description must be a string of at most 240 characters'));
  });

  it('never prompts in JSON mode and rejects incomplete CRUD usage before network access', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    global.fetch = vi.fn();
    try {
      await expect(commentLabelsCreateCommand({ json: true })).rejects.toThrow('process.exit(1)');
      await expect(commentLabelsEditCommand('risk', { json: true })).rejects.toThrow('process.exit(1)');
      await expect(commentLabelsReorderCommand([], { json: true })).rejects.toThrow('process.exit(1)');
      await expect(commentLabelsDeleteCommand('risk', { json: true })).rejects.toThrow('process.exit(1)');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain('--json delete requires --yes');
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
    }
  });

  it('emits exactly one parseable JSON value for list, edit, enable, disable, delete, and reorder', async () => {
    const label = { ...row, color: '#D97706', usageCount: 0 };
    const current = { revision: 4, commentLabels: [label] };
    const updated = { revision: 5, commentLabels: [label] };
    const cases: Array<() => Promise<void>> = [
      () => commentLabelsListCommand({ json: true }),
      () => commentLabelsEditCommand(row.key, { label: 'Updated', json: true }),
      () => commentLabelsSetEnabledCommand(row.key, true, { json: true }),
      () => commentLabelsSetEnabledCommand(row.key, false, { json: true }),
      () => commentLabelsDeleteCommand(row.key, { yes: true, json: true }),
      () => commentLabelsReorderCommand([row.key], { json: true }),
    ];
    for (const [index, run] of cases.entries()) {
      log.mockClear();
      error.mockClear();
      global.fetch = index === 0
        ? vi.fn().mockResolvedValueOnce(jsonResponse(current))
        : vi.fn().mockResolvedValueOnce(jsonResponse(current)).mockResolvedValueOnce(jsonResponse(updated));
      await run();
      expect(log).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(String(log.mock.calls[0][0]))).not.toThrow();
      expect(error).not.toHaveBeenCalled();
    }
  });

  it('does not enter readline for complete JSON CRUD even when stdin is a TTY', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const label = { ...row, color: '#D97706', usageCount: 0 };
    try {
      global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 1, commentLabels: [] })).mockResolvedValueOnce(jsonResponse({ revision: 2, commentLabels: [label] }, 201));
      await commentLabelsCreateCommand({ key: row.key, label: row.label, description: row.description, color: row.color, enabled: true, json: true });
      log.mockClear();
      global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 2, commentLabels: [label] })).mockResolvedValueOnce(jsonResponse({ revision: 3, commentLabels: [label] }));
      await commentLabelsEditCommand(row.key, { description: 'Updated', json: true });
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
      else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
    }
  });

  it('rejects member and Cloudflare profiles before network access', async () => {
    vi.mocked(config.loadConfig).mockResolvedValueOnce({ endpoint: 'https://example.com', token: 'member', subdomain: 'test', role: 'member', backend: 'vercel' });
    global.fetch = vi.fn();
    await expect(commentLabelsCreateCommand({})).rejects.toThrow('process.exit(1)');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('owner-only'));
    expect(global.fetch).not.toHaveBeenCalled();

    vi.mocked(config.loadConfig).mockResolvedValueOnce({ endpoint: 'https://example.com', token: 'owner', subdomain: 'test', role: 'owner', backend: 'cloudflare' });
    await expect(commentLabelsClearCommand({ yes: true })).rejects.toThrow('process.exit(1)');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('only available on Vercel'));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('writes an empty template offline and protects existing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toss-comment-labels-'));
    const file = join(dir, 'labels.json');
    try {
      await commentLabelsTemplateCommand(file);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(emptyCommentLabelDocument());
      await expect(commentLabelsTemplateCommand(file)).rejects.toThrow('process.exit(1)');
      expect(config.loadConfig).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps template and export stdout to one JSON document and sends file diagnostics to stderr', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await commentLabelsTemplateCommand();
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0][0]))).toEqual(emptyCommentLabelDocument());
    expect(log).not.toHaveBeenCalled();

    write.mockClear();
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 2, commentLabels: [{ ...row, color: '#D97706', usageCount: 3 }] }));
    await commentLabelsExportCommand(undefined, {});
    expect(write).toHaveBeenCalledTimes(1);
    const exported = JSON.parse(String(write.mock.calls[0][0]));
    expect(exported.commentLabels).toHaveLength(1);
    expect(exported.commentLabels[0]).not.toHaveProperty('usageCount');
    expect(log).not.toHaveBeenCalled();
  });

  it('uses the preview revision for merge apply and clear without a blind retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'toss-comment-labels-'));
    const file = join(dir, 'labels.json');
    await writeFile(file, serializeCommentLabelDocument({ ...emptyCommentLabelDocument(), commentLabels: [{ ...row, color: '#D97706' }] }));
    try {
      global.fetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"commentLabelRevision":20,"creates":1}' } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"commentLabelRevision":21,"commentLabels":[]}' } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"commentLabelRevision":21,"deletes":0,"disables":0}' } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{"commentLabelRevision":21,"commentLabels":[]}' } as Response);
      await commentLabelsApplyCommand(file, { yes: true, json: true });
      expect(log).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(String(log.mock.calls[0][0]))).not.toThrow();
      expect(error).not.toHaveBeenCalled();
      expect(JSON.parse(String((global.fetch as any).mock.calls[1][1].body)).expectedRevision).toBe(20);
      log.mockClear();
      await commentLabelsClearCommand({ yes: true, json: true });
      expect(log).toHaveBeenCalledTimes(1);
      expect(() => JSON.parse(String(log.mock.calls[0][0]))).not.toThrow();
      expect(error).not.toHaveBeenCalled();
      expect(JSON.parse(String((global.fetch as any).mock.calls[3][1].body)).expectedRevision).toBe(21);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('enforces safe noninteractive and JSON apply modes before mutation', async () => {
    const file = join(tmpdir(), `toss-labels-${Date.now()}.json`);
    await writeFile(file, serializeCommentLabelDocument(emptyCommentLabelDocument()));
    global.fetch = vi.fn();
    try {
      await expect(commentLabelsApplyCommand(file, { json: true })).rejects.toThrow('process.exit(1)');
      await expect(commentLabelsClearCommand({ dryRun: true, yes: true })).rejects.toThrow('process.exit(1)');
      expect(global.fetch).not.toHaveBeenCalled();
    } finally { await rm(file, { force: true }); }
  });

  it('prints JSON dry-run previews once and routes non-JSON previews to stderr', async () => {
    const file = join(tmpdir(), `toss-labels-${Date.now()}.json`);
    await writeFile(file, serializeCommentLabelDocument(emptyCommentLabelDocument()));
    try {
      global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 8, creates: [], updates: [], reorders: [], unchanged: [], result: [] }));
      await commentLabelsApplyCommand(file, { json: true, dryRun: true });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0][0])).revision).toBe(8);
      expect(error).not.toHaveBeenCalled();

      log.mockClear();
      global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ revision: 8, deletes: [], disables: [], result: [] }));
      await commentLabelsClearCommand({ dryRun: true });
      expect(log).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Clear preview:'));
    } finally { await rm(file, { force: true }); }
  });

  it('keeps backend structured comment-label errors exact and on stderr', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      error: 'stale_comment_label_registry',
      message: 'The comment label registry changed.',
      expectedRevision: 4,
      actualRevision: 5,
      hint: 'Read or preview the registry again.',
    }, 409));
    await expect(commentLabelsListCommand({ json: true })).rejects.toThrow('process.exit(1)');
    expect(log).not.toHaveBeenCalled();
    const output = error.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('The comment label registry changed. (stale_comment_label_registry)');
    expect(output).toContain('Expected revision: 4');
    expect(output).toContain('Actual revision: 5');
    expect(output).toContain('Read or preview the registry again.');
  });

  it('keeps SKILL schema documentation consistent with generated templates', async () => {
    const skill = await readFile(join(process.cwd(), 'SKILL.md'), 'utf8');
    expect(skill).toContain('top-level\n`commentLabels`');
    expect(skill).not.toContain('top-level\n`labels`');
    expect(emptyCommentLabelDocument()).toHaveProperty('commentLabels');
    expect(emptyCommentLabelDocument()).not.toHaveProperty('labels');
  });
});
