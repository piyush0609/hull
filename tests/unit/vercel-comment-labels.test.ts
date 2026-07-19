import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';
import { codePointLength } from '../../src/templates/vercel/api/index.ts';

describe('Vercel comment labels backend', () => {
  it('uses the authoritative public comment-label terminology and reserves the route namespace', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    expect(source).toContain("url.pathname.startsWith('/comment-labels')");
    expect(source).toContain("'toss/comment-labels@v1'");
    expect(source).toContain('commentLabelRevision');
    expect(source).toContain('commentLabels: snapshot.comment_labels');
    expect(source).toContain("'stale_comment_label_registry'");
    expect(source).toContain("'comment_label_in_use'");
    expect(source).toContain("'comment-labels', 'health'");
  });

  it('accepts omitted and explicit null kinds and rejects malformed or reserved values', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const declaration = source.match(/function normalizeMessageKind\([\s\S]*?\n}/)?.[0];
    expect(declaration).toBeTruthy();
    const javascript = transpileModule(declaration!, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
    const normalize = new Function(`${javascript}; return normalizeMessageKind;`)();
    expect(normalize({})).toBeNull();
    expect(normalize({ kind: null })).toBeNull();
    expect(normalize({ kind: 'design-review' })).toBe('design-review');
    expect(normalize({ kind: 'resolution' })).toBeInstanceOf(Response);
    expect(normalize({ kind: 'UPPER' })).toBeInstanceOf(Response);
  });

  it('normalizes colors to uppercase and keeps user-facing metadata descriptive only', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const declaration = source.match(/function normalizeCommentLabel\([\s\S]*?\n}/)?.[0];
    expect(declaration).toBeTruthy();
    const javascript = transpileModule(declaration!, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
    const normalize = new Function('commentLabelError', 'codePointLength', `${javascript}; return normalizeCommentLabel;`)((status: number, error: string, message: string, extra: object) => ({ status, error, message, ...extra }), codePointLength);
    expect(normalize({ key: 'review', label: ' Review ', description: ' Helpful ', color: '#a1b2c3', enabled: true, position: 1 })).toEqual({
      key: 'review', label: 'Review', description: 'Helpful', color: '#A1B2C3', enabled: true, position: 1,
    });
    expect(normalize({ key: 'resolution', label: 'No', description: '', color: '#000000', enabled: true, position: 1 })).toMatchObject({ status: 400, error: 'reserved_comment_label' });
    expect(normalize({ key: 'review', label: 'Review', description: '', color: '#abc', enabled: true, position: 1 })).toMatchObject({ status: 400, field: 'commentLabel.color' });
    expect(normalize({ key: 'review', label: 'Review', color: '#AABBCC', enabled: true, position: 1 })).toMatchObject({ status: 400, field: 'commentLabel.description' });
    expect(normalize({ key: 'review', label: 'Review', description: null, color: '#AABBCC', enabled: true, position: 1 })).toMatchObject({ status: 400, field: 'commentLabel.description' });
    const interfaceBody = source.match(/interface CommentLabel \{([\s\S]*?)\n}/)?.[1] || '';
    for (const field of ['key:', 'label:', 'description:', 'color:', 'enabled:', 'position:']) expect(interfaceBody).toContain(field);
    for (const forbidden of ['blocking', 'approval', 'readiness', 'notification']) expect(interfaceBody).not.toContain(forbidden);
  });

  it('counts label and description limits by Unicode code point for create, patch, and apply validation', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const error = (status: number, error: string, message: string, extra: object) => ({ status, error, message, ...extra });
    const labelDeclaration = source.match(/function normalizeCommentLabel\([\s\S]*?\n}/)?.[0];
    const changesDeclaration = source.match(/function normalizeCommentLabelChanges\([\s\S]*?\n}/)?.[0];
    expect(labelDeclaration).toBeTruthy();
    expect(changesDeclaration).toBeTruthy();
    const normalize = new Function('commentLabelError', 'codePointLength', `${transpileModule(labelDeclaration!, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText}; return normalizeCommentLabel;`)(error, codePointLength);
    const normalizeChanges = new Function('commentLabelError', 'codePointLength', `${transpileModule(changesDeclaration!, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText}; return normalizeCommentLabelChanges;`)(error, codePointLength);
    const emoji = '😀';
    const base = { key: 'emoji', description: '', color: '#AABBCC', enabled: true, position: 1 };

    expect(codePointLength(emoji.repeat(50))).toBe(50);
    expect(normalize({ ...base, label: emoji.repeat(50) })).toMatchObject({ label: emoji.repeat(50) });
    expect(normalize({ ...base, label: emoji.repeat(80) })).toMatchObject({ label: emoji.repeat(80) });
    expect(normalize({ ...base, label: emoji.repeat(81) })).toMatchObject({ status: 400, field: 'commentLabel.label' });
    expect(normalize({ ...base, label: 'Emoji', description: emoji.repeat(240) })).toMatchObject({ description: emoji.repeat(240) });
    expect(normalize({ ...base, label: 'Emoji', description: emoji.repeat(241) })).toMatchObject({ status: 400, field: 'commentLabel.description' });
    expect(normalizeChanges({ label: emoji.repeat(50), description: emoji.repeat(240) })).toEqual({ label: emoji.repeat(50), description: emoji.repeat(240) });
    expect(normalizeChanges({ label: emoji.repeat(81) })).toMatchObject({ status: 400, field: 'changes.label' });
    expect(normalizeChanges({ description: emoji.repeat(241) })).toMatchObject({ status: 400, field: 'changes.description' });

    expect(source).toContain('normalizeCommentLabel(input.commentLabels[index], `commentLabels[${index}]`)');
    expect(labelDeclaration).not.toMatch(/label\.length|description\.length/);
    expect(changesDeclaration).not.toMatch(/label\.length|description\.length/);
  });

  it('assembles latest and historical comment envelopes with one snapshot statement', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const getBranch = source.slice(source.indexOf("if (commentListMatch && request.method === 'GET')"), source.indexOf("if (commentListMatch && request.method === 'POST')"));
    const helper = source.slice(source.indexOf('export async function readCommentSnapshot'), source.indexOf('// --- Main handler ---'));
    expect(getBranch).toContain('await readCommentSnapshot(sql,');
    expect(helper.match(/return sql`/g)).toHaveLength(1);
    expect(helper).toContain('WITH registry AS MATERIALIZED');
    expect(helper).toContain('selected_threads AS MATERIALIZED');
    expect(helper).toContain('labels AS MATERIALIZED');
    expect(helper).toContain('registry.contract_ready');
  });

  it('guards typed inserts under the singleton state lock while allowing null', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    expect(source.match(/SELECT contract_ready FROM comment_label_registry_state WHERE singleton = true FOR UPDATE/g)).toHaveLength(2);
    expect(source.match(/::text IS NULL OR \(contract_ready AND EXISTS/g)).toHaveLength(2);
    expect(source).toContain("key <> 'resolution'");
  });

  it('locks the target thread and rejects direct or racing replies after resolution', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const replyRoute = source.slice(source.indexOf('const threadMessageMatch'), source.indexOf('const threadResolveMatch'));
    const helper = source.slice(source.indexOf('export async function insertCommentReply'), source.indexOf('export async function readCommentSnapshot'));
    expect(replyRoute).toContain('await insertCommentReply(sql,');
    expect(helper).toContain('target_thread AS MATERIALIZED');
    expect(helper).toContain('WHERE id = ${threadId} AND deleted_at IS NULL');
    expect(helper).toContain('FOR UPDATE');
    expect(helper).toContain("FROM valid_kind, target_thread WHERE target_thread.status <> 'resolved'");
    expect(replyRoute).toContain("return new Response('Resolved comments cannot receive replies', { status: 409 })");
  });

  it('fails closed for empty owner credentials and returns structured private auth errors', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    expect(source).toContain("const OWNER_TOKEN = (process.env.OWNER_TOKEN || '').trim();");
    expect(source).toContain('if (!token) return null;');
    expect(source).toContain('if (OWNER_TOKEN) {');
    expect(source).toContain("authJson({ error: 'unauthorized', message: 'Owner authentication is required.' }, { status: 401 })");
    expect(source).toContain("authJson({ error: 'forbidden', message: 'Owner access is required.' }, { status: 403 })");
    expect(source).toContain("headers.set('Cache-Control', 'private, no-store, max-age=0')");
  });

  it('returns every mutation result from the transaction final statement', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const routes = source.slice(source.indexOf('async function handleCommentLabelRoutes'), source.indexOf('// --- Main handler ---'));
    expect(routes.match(/return authJson\(await readOwnerCommentLabels\(sql\)\)/g)).toHaveLength(1); // GET only
    expect(routes.match(/ownerCommentLabelListFromRows\(results\[/g)).toHaveLength(5);
    expect(routes).toContain('ownerCommentLabelListFromRows(list), { status: 201 }');
    expect(routes.match(/sql\.transaction/g)).toHaveLength(6);
  });

  it('keeps PATCH target writes disjoint and CLEAR delete/update classifications non-overlapping', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const patch = source.slice(source.indexOf("if (keyMatch && request.method === 'PATCH')"), source.indexOf("if (keyMatch && request.method === 'DELETE')"));
    expect(patch).toContain('row.key <> ${key}');
    expect(patch).toContain('position = target.new_position');
    expect(patch.match(/UPDATE comment_labels row/g)).toHaveLength(2);
    const clear = source.slice(source.indexOf("if (request.method === 'POST' && url.pathname === '/comment-labels/clear')"), source.indexOf("return new Response('Method not allowed'"));
    expect(clear).toContain('usage AS MATERIALIZED');
    expect(clear).toContain('NOT usage.in_use');
    expect(clear).toContain('usage.in_use');
    expect(clear).toContain('row_number() OVER (ORDER BY label.position, label.key)');
  });
});
