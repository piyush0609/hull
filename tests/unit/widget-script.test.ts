import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ScriptTarget, transpileModule } from 'typescript';

describe('Vercel comment widget script', () => {
  async function widgetSource() {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    return source.slice(source.indexOf('function injectCommentsUI'), source.indexOf('// --- Serve artifact ---'));
  }

  async function widgetScript() {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const shell = source.match(/const shell = `([\s\S]*?)\n`;/)?.[1];
    return shell
      ?.replace('${payload}', JSON.stringify({ artifactId: 'test', viewerToken: 'token', origin: 'https://example.test', artifactBasePath: '/a/test/', currentPagePath: 'index.html', instanceScope: 'vercel-project-test' }))
      .match(/<script>([\s\S]*)<\/script>/)?.[1];
  }

  async function embeddedFunction(name: string, dependencies: string[], values: unknown[]) {
    const script = await widgetScript();
    const declaration = script?.match(new RegExp(`  function ${name}\\([\\s\\S]*?\\n  }`))?.[0];
    expect(declaration).toBeTruthy();
    return new Function(...dependencies, `${declaration}; return ${name};`)(...values);
  }

  async function reviewHelpers() {
    const widget = await widgetSource();
    const declarations = widget.match(/  const visibleMessages = .*\n  const labelCount = .*\n  const threadMatchesKind = .*$/m)?.[0];
    expect(declarations).toBeTruthy();
    return new Function(`${declarations}; return { visibleMessages, labelCount, threadMatchesKind };`)();
  }

  async function mintVersionFunction(getSQL: () => unknown, generateId: () => string) {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const declaration = source.match(/async function mintVersion[\s\S]*?\n}\n\nfunction normalizeThreadInput/)?.[0]
      .replace(/\n\nfunction normalizeThreadInput$/, '');
    expect(declaration).toBeTruthy();
    const javascript = transpileModule(declaration!, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
    return new Function('getSQL', 'generateId', `${javascript}; return mintVersion;`)(getSQL, generateId);
  }

  function versionDatabase() {
    const state = {
      pointer: 'version-1',
      versions: [{ id: 'version-1', seq: 1 }],
      snapshots: new Map([['version-1', ['root', 'reply']]]),
    };
    let queue = Promise.resolve();
    let failAfterCopy = false;
    const sql: any = () => { throw new Error('mintVersion must use sql.transaction'); };
    sql.transaction = async (build: (tx: any) => any[]) => {
      const tx = (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join('?'), values });
      const queries = build(tx);
      expect(queries).toHaveLength(3);
      expect(queries[0].text).toContain('FOR UPDATE');
      expect(queries[1].text).toContain('inserted_version');
      expect(queries[2].text).toContain('SET current_version_id');

      let release!: () => void;
      const previous = queue;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const draft = {
          pointer: state.pointer,
          versions: state.versions.map((version) => ({ ...version })),
          snapshots: new Map(Array.from(state.snapshots, ([id, messages]) => [id, [...messages]])),
        };
        const versionId = queries[2].values[0] as string;
        const seq = Math.max(...draft.versions.map((version) => version.seq)) + 1;
        draft.versions.push({ id: versionId, seq });
        draft.snapshots.set(versionId, [...(draft.snapshots.get(draft.pointer) || [])]);
        if (failAfterCopy) throw new Error('injected copy failure');
        draft.pointer = versionId;
        state.pointer = draft.pointer;
        state.versions = draft.versions;
        state.snapshots = draft.snapshots;
        return [[{ id: 'artifact' }], [{ id: versionId, seq }], [{ id: 'artifact' }]];
      } finally {
        release();
      }
    };
    return { state, sql, setFailure(value: boolean) { failAfterCopy = value; } };
  }

  it('keeps the embedded STYLE declaration valid JavaScript', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const declaration = source.match(/^  const STYLE = '<style>.*<\/style>';$/m)?.[0];

    expect(declaration).toBeTruthy();
    expect(() => new Function(declaration!)).not.toThrow();
  });

  it('emits a syntactically valid widget script', async () => {
    const script = await widgetScript();

    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });

  it('exports the production injector and uses instance-scoped failure-safe preference storage', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const widget = await widgetSource();

    expect(source).toContain('export interface VercelCommentWidgetConfig');
    expect(source).toContain('export function injectCommentsUI');
    expect(source).toContain('instanceScope: process.env.VERCEL_PROJECT_ID || new URL(request.url).hostname');
    expect(widget).toContain("'toss:comment-widget:' + cfg.instanceScope + ':open-feedback-expanded'");
    expect(widget).toContain('try { return localStorage.getItem(key); } catch (e) { return null; }');
    expect(widget).toContain('try { localStorage.setItem(key, value); } catch (e) {}');
  });

  it('escapes config values that could terminate the inline script', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const declaration = source.match(/function serializeInlineScriptValue\([\s\S]*?\n}/)?.[0];
    expect(declaration).toBeTruthy();
    const javascript = transpileModule(declaration!, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
    const serialize = new Function(`${javascript}; return serializeInlineScriptValue;`)();
    const pagePath = '</script><script>globalThis.injected=true</script>\u2028line\u2029paragraph';
    const serialized = serialize({ currentPagePath: pagePath });

    expect(serialized).not.toContain('</script>');
    expect(serialized).toContain('\\u003c/script>\\u003cscript>');
    expect(serialized).toContain('\\u2028');
    expect(serialized).toContain('\\u2029');
    expect(JSON.parse(serialized).currentPagePath).toBe(pagePath);
  });

  it('includes registry-driven comment-label and resolution controls', async () => {
    const widget = await widgetSource();

    expect(widget).toContain('commentLabelRevision');
    expect(widget).toContain('commentLabels');
    expect(widget).toContain('Add label');
    expect(widget).toContain('Search comment labels');
    expect(widget).toContain('Filter by thread status');
    expect(widget).toContain('Filter by comment label');
    expect(widget).toContain('All comment label counts');
    expect(widget).toContain('Resolution note');
    expect(widget).toContain('id="resolveContext"');
    expect(widget).toContain('id="resolveAvatar"');
    expect(widget).toContain('id="resolveAttribution"');
    expect(widget).toContain('This resolution will be attributed to');
    expect(widget).toContain("updateResolveAttribution();");
    expect(widget).toContain("resolved ? ' resolvedHead' : ''");
    expect(widget).toContain('class="messageBadges"');
    expect(widget).toContain('.meta .agox{color:#9ca3af;font-weight:400;font-size:11px;margin-left:6px;flex:0 0 auto}');
    expect(widget).toContain('@media(max-width:430px)');
    expect(widget).toContain('.panel{left:0;right:auto;max-width:100vw;width:100vw;border:0;box-shadow:none}');
    expect(widget).toContain("kindBadge(r.kind)");
    expect(widget).toContain('withOptionalKind({ name: name, body: body, pagePath: PAGE');
    expect(widget).toContain('withOptionalKind({ name: snapshot.name, body: snapshot.body }, snapshot.kind)');
    expect(widget).toContain("body: JSON.stringify({ name: name, body: body })");
    expect(widget).not.toContain('Anonymous');
  });

  it('emits progressively disclosed per-thread composers with compact identity editing', async () => {
    const widget = await widgetSource();

    expect(widget).toContain("expandedThreadId: null, replyOriginThreadId: null");
    expect(widget).toContain("state.replyDrafts[threadId] = { name: committed, body: '', kind: null, labelPickerOpen: false");
    expect(widget).toContain("const composerId = 'reply-composer-' + key, editorId = 'reply-identity-editor-' + key, nameId = 'reply-name-' + key, replyId = 'reply-body-' + key");
    expect(widget).toContain('aria-controls="' + "' + composerId + '");
    expect(widget).toContain('class="identityAvatar" aria-hidden="true"');
    expect(widget).toContain('Replying as <strong>');
    expect(widget).toContain('class="identityChange" aria-controls="');
    expect(widget).toContain('class="replyName" type="text" autocomplete="name" maxlength="80" required');
    expect(widget).toContain('class="btn ghost identityCancel">Cancel</button><button type="button" class="btn primary identitySave">Save');
    expect(widget).toContain("focusReplyControl(threadId, draft.name && !draft.identityEditing ? '.replyInput' : '.replyName')");
    expect(widget).toContain("focusReplyControl(threadId, fallback ? '.identityChange' : '.replyName')");
  });

  it('uses optional enabled-only label pickers and searchable comboboxes for large registries', async () => {
    const widget = await widgetSource();

    expect(widget).toContain("label.enabled && label.key !== 'resolution'");
    expect(widget).toContain('enabledLabels().length > 6');
    expect(widget).toContain('role="combobox"');
    expect(widget).toContain('aria-activedescendant="');
    expect(widget).toContain("label.key + ' ' + label.label + ' ' + (label.description || '')");
    expect(widget).toContain("if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectActive(); return true; }");
    expect(widget).not.toContain("if (e.key === 'Enter' && !e.shiftKey)");
    expect(widget).toContain('<textarea id="' + "' + replyId + '");
  });

  it('propagates committed identity without overwriting divergent editor text or draft work', async () => {
    const state = {
      name: 'Old Name',
      replyDrafts: {
        a: { name: 'Old Name', body: 'body a', kind: 'blocker', identityEditing: false, identityEditorValue: 'Old Name', priorIdentity: 'Old Name', extra: 'a' },
        b: { name: 'Old Name', body: 'body b', kind: 'question', identityEditing: true, identityEditorValue: 'Unconfirmed B', priorIdentity: 'Old Name', extra: 'b' },
        c: { name: 'Different', body: 'body c', kind: 'nit', identityEditing: false, identityEditorValue: 'Different', priorIdentity: 'Different' },
      },
    };
    const cName = { value: '' };
    const storage = new Map<string, string>();
    const commit = await embeddedFunction('commitGlobalIdentity', ['state', 'cName', 'safeStorageSet', 'NAME_KEY'], [state, cName, (key: string, value: string) => storage.set(key, value), 'toss-comment-name']);

    commit('Old Name', 'New Name');

    expect(state.name).toBe('New Name');
    expect(cName.value).toBe('New Name');
    expect(storage.get('toss-comment-name')).toBe('New Name');
    expect(state.replyDrafts.a).toMatchObject({ name: 'New Name', body: 'body a', kind: 'blocker', identityEditorValue: 'New Name', priorIdentity: 'New Name', extra: 'a' });
    expect(state.replyDrafts.b).toMatchObject({ name: 'New Name', body: 'body b', kind: 'question', identityEditing: true, identityEditorValue: 'Unconfirmed B', priorIdentity: 'New Name', extra: 'b' });
    expect(state.replyDrafts.c).toMatchObject({ name: 'Different', body: 'body c', kind: 'nit', priorIdentity: 'Different' });
  });

  it('propagates an initially empty identity to every empty seeded draft', async () => {
    const state = {
      name: '',
      replyDrafts: {
        a: { name: '', body: 'a', kind: 'note', identityEditing: true, identityEditorValue: 'Reviewer A', priorIdentity: '' },
        b: { name: '', body: 'b', kind: 'action', identityEditing: true, identityEditorValue: '', priorIdentity: '' },
      },
    };
    const commit = await embeddedFunction('commitGlobalIdentity', ['state', 'cName', 'safeStorageSet', 'NAME_KEY'], [state, { value: '' }, () => undefined, 'toss-comment-name']);

    commit('', 'Saved Reviewer');

    expect(state.replyDrafts.a).toMatchObject({ name: 'Saved Reviewer', body: 'a', kind: 'note', identityEditorValue: 'Reviewer A', priorIdentity: 'Saved Reviewer' });
    expect(state.replyDrafts.b).toMatchObject({ name: 'Saved Reviewer', body: 'b', kind: 'action', identityEditorValue: 'Saved Reviewer', priorIdentity: 'Saved Reviewer' });
  });

  it('discards only confirmed missing or resolved drafts during successful reconciliation', async () => {
    const state = {
      replyDrafts: { open: { body: 'keep' }, filtered: { body: 'also keep' }, resolved: { body: 'drop' }, missing: { body: 'drop' } },
      expandedThreadId: 'resolved',
      replyOriginThreadId: null,
      replyFocusAfterRender: null,
    };
    const queueReplyCollapseFocus = (threadId: string) => {
      state.replyOriginThreadId = threadId;
      state.replyFocusAfterRender = { threadId, fallback: true };
      state.expandedThreadId = null;
    };
    const reconcile = await embeddedFunction('reconcileReplyDrafts', ['state', 'queueReplyCollapseFocus'], [state, queueReplyCollapseFocus]);

    reconcile([
      { id: 'open', status: 'open' },
      { id: 'filtered', status: 'open' },
      { id: 'resolved', status: 'resolved' },
    ]);

    expect(state.replyDrafts).toEqual({ open: { body: 'keep' }, filtered: { body: 'also keep' } });
    expect(state.expandedThreadId).toBeNull();
    expect(state.replyOriginThreadId).toBe('resolved');
    expect(state.replyFocusAfterRender).toEqual({ threadId: 'resolved', fallback: true });
  });

  it('digests authoritative thread and message edits, deletions, and kinds', async () => {
    const digest = await embeddedFunction('threadsDigest', [], []);
    const baseline = [{ id: 'thread', status: 'open', updated_at: 1, messages: [{ id: 'message', author_label: 'A', body: 'Before', kind: 'note', updated_at: 1 }] }];

    const values = [
      baseline,
      [{ ...baseline[0], status: 'resolved' }],
      [{ ...baseline[0], resolved_by_label: 'Reviewer', resolved_at: 2 }],
      [{ ...baseline[0], messages: [{ ...baseline[0].messages[0], body: 'After' }] }],
      [{ ...baseline[0], messages: [{ ...baseline[0].messages[0], kind: 'blocker' }] }],
      [{ ...baseline[0], messages: [{ ...baseline[0].messages[0], updated_at: 2 }] }],
      [{ ...baseline[0], messages: [{ ...baseline[0].messages[0], deleted_at: 2 }] }],
    ].map((threads) => digest(threads));

    expect(new Set(values).size).toBe(values.length);
  });

  it('uses monotonic load generations so only the newest response can apply', async () => {
    const script = await widgetScript();
    const declarations = script?.match(/  function beginThreadLoad\(\).*\n  function isLatestThreadLoad\(generation\).*$/m)?.[0];
    expect(declarations).toBeTruthy();
    const state = { threadLoadGeneration: 0 };
    const helpers = new Function('state', `${declarations}; return { beginThreadLoad, isLatestThreadLoad };`)(state);

    const older = helpers.beginThreadLoad();
    const newer = helpers.beginThreadLoad();

    expect(helpers.isLatestThreadLoad(older)).toBe(false);
    expect(helpers.isLatestThreadLoad(newer)).toBe(true);
    expect(state.threadLoadGeneration).toBe(2);
  });

  it('captures composer control and selection without retaining a DOM node', async () => {
    const state = { expandedThreadId: 'thread-a' };
    const item = { getAttribute: (name: string) => name === 'data-id' ? 'thread-a' : null };
    const composer = { closest: (selector: string) => selector === '.item' ? item : null };
    const active = {
      classList: { contains: (name: string) => name === 'replyInput' },
      closest: (selector: string) => selector === '.replyForm' ? composer : null,
      selectionStart: 3,
      selectionEnd: 7,
    };
    const capture = await embeddedFunction('captureReplyFocus', ['state', 'sr'], [state, { activeElement: active }]);

    expect(capture()).toEqual({ threadId: 'thread-a', selector: '.replyInput', selectionStart: 3, selectionEnd: 7 });
    expect(capture()).not.toHaveProperty('element');
  });

  it('restores focus after successful rerenders and uses the collapse fallback ladder', async () => {
    const widget = await widgetSource();

    expect(widget).toContain('replyFocusAfterRender: null');
    expect(widget).toContain('state.replyFocusAfterRender = { threadId: threadId, fallback: true }');
    expect(widget).toContain('else if (preserveReplyFocus && !state.replyFocusAfterRender) state.replyFocusAfterRender = captureReplyFocus();');
    expect(widget).toContain("if (intent.selectionStart !== null && typeof control.setSelectionRange === 'function') control.setSelectionRange(intent.selectionStart, intent.selectionEnd)");
    expect(widget).toContain('const activeFilter = sr.activeElement === kindFilter ? kindFilter : (sr.activeElement === statusFilter ? statusFilter : null);');
    expect(widget).toContain('restoreQueuedReplyFocus();');
    expect(widget).toContain('render(true);');
  });

  it('guards polling order, ignores stale failures, and protects composer regions from card navigation', async () => {
    const widget = await widgetSource();

    expect(widget).toContain('const generation = beginThreadLoad();');
    expect(widget).toContain('if (!isLatestThreadLoad(generation)) return;');
    expect(widget).toContain("if (isLatestThreadLoad(generation) && !state.loaded) setStatus(e.message || 'Failed to load.');");
    expect(widget).toContain("ev.target.closest('.replyForm,.threadActions,button,input,textarea,select,label,[role=group]')");
    expect(widget).toContain("resolved' + (who ? ' by ' + esc(who) : '')");
    expect(widget).not.toContain("'resolved by ' + esc(who)");
  });

  it('retains the complete post-propagation reply snapshot on failure and clears only success', async () => {
    const widget = await widgetSource();

    expect(widget).toContain('const snapshot = { threadId: threadId, name: draft.name, body: draft.body, kind: draft.kind, labelPickerOpen: draft.labelPickerOpen');
    expect(widget).toContain('state.replyDrafts[threadId] = snapshot;');
    expect(widget).toContain('state.expandedThreadId = threadId;');
    expect(widget).toContain("focusReplyControl(threadId, snapshot.name ? '.replyInput' : '.replyName')");
    expect(widget).toContain('delete state.replyDrafts[threadId];');
    expect(widget).not.toContain("commitGlobalIdentity(snapshot.name");
  });

  it('does not revive a failed reply draft after authoritative resolution, deletion, or removal', async () => {
    const canRestore = await embeddedFunction('canRestoreReplyDraft', [], []);

    expect(canRestore('thread', [{ id: 'thread', status: 'open' }])).toBe(true);
    expect(canRestore('thread', [{ id: 'thread', status: 'resolved' }])).toBe(false);
    expect(canRestore('thread', [{ id: 'thread', status: 'open', deleted_at: 123 }])).toBe(false);
    expect(canRestore('thread', [{ id: 'other', status: 'open' }])).toBe(false);
    expect(canRestore('thread', [])).toBe(false);
  });

  it('lets authoritative poll state win when a concurrent reply request rejects', async () => {
    const widget = await widgetSource();

    expect(widget).toContain('if (canRestoreReplyDraft(threadId, state.threads)) {');
    expect(widget).toContain('state.replyDrafts[threadId] = snapshot;');
    expect(widget).toContain('} else {\n        delete state.replyDrafts[threadId];');
    expect(widget).toContain('state.replyFocusAfterRender = { threadId: threadId, fallback: true };');
    expect(widget).toContain('state.expandedThreadId = null;\n        render(true);');
  });

  it('keeps desktop and mobile panel sizing, two filter columns, and contained composer controls', async () => {
    const widget = await widgetSource();

    expect(widget).toContain('.panel{position:fixed;z-index:2147483645;top:0;right:0;width:360px;max-width:360px');
    expect(widget).toContain('@media(max-width:430px)');
    expect(widget).toContain('.panel{left:0;right:auto;max-width:100vw;width:100vw;border:0;box-shadow:none}');
    expect(widget).toContain('.filters{position:relative;z-index:2;display:grid;grid-template-columns:1fr 1fr;gap:6px;');
    expect(widget).toContain('.filters.single{grid-template-columns:1fr}');
    expect(widget).toContain('.typePickerList{max-height:128px;overflow-y:auto;overflow-x:hidden}');
    expect(widget).toContain('.replyInput{height:64px;min-height:64px;resize:none');
  });

  it('stages immutable version content and publishes artifact metadata with the pointer', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    expect(source).toContain('versionEntryBlobPath(existingId, candidateVersionId)');
    expect(source).toContain("await blobPut(stagedPath, html, 'text/html')");
    expect(source).toContain('await blobDelete(stagedPath).catch(() => {})');
    expect(source).toContain('contentPath = versionEntryBlobPath(meta.id, String(currentVersionId))');
    expect(source).toContain('password_epoch = password_epoch + CASE WHEN password_hash IS DISTINCT FROM ${artifactUpdate.passwordHash} THEN 1 ELSE 0 END, password_hash = ${artifactUpdate.passwordHash}, current_version_id = ${versionId}');
    expect(source.indexOf('await blobPut(stagedPath, html')).toBeLessThan(source.indexOf('await mintVersion(existingId, newHash'));
    expect(source).not.toContain("blobPut(`artifacts/${existingId}/files/index.html`");
  });

  it('counts blocker replies from all non-deleted messages in open threads', async () => {
    const { labelCount } = await reviewHelpers();
    const threads = [
      { status: 'open', messages: [{ kind: 'note' }, { kind: 'blocker' }, { kind: 'blocker', deleted_at: 123 }] },
      { status: 'resolved', messages: [{ kind: 'blocker' }] },
    ];

    expect(labelCount(threads, 'blocker')).toBe(1);
  });

  it('does not match a type filter when only a deleted message has that type', async () => {
    const { threadMatchesKind } = await reviewHelpers();
    const thread = { messages: [{ kind: 'note' }, { kind: 'question', deleted_at: 123 }] };

    expect(threadMatchesKind(thread, 'question')).toBe(false);
    expect(threadMatchesKind(thread, 'note')).toBe(true);
    expect(threadMatchesKind(thread, 'all')).toBe(true);
  });

  it('keeps the prior pointer and complete snapshot visible after a copy failure', async () => {
    const database = versionDatabase();
    database.setFailure(true);
    const mintVersion = await mintVersionFunction(() => database.sql, () => 'version-failed');

    await expect(mintVersion('artifact', 'hash-failed', 2)).rejects.toThrow('injected copy failure');
    expect(database.state.pointer).toBe('version-1');
    expect(database.state.versions).toEqual([{ id: 'version-1', seq: 1 }]);
    expect(database.state.snapshots.get(database.state.pointer)).toEqual(['root', 'reply']);
    expect(database.state.snapshots.has('version-failed')).toBe(false);
  });

  it('serializes concurrent version allocation and publishes complete snapshots', async () => {
    const database = versionDatabase();
    let nextId = 2;
    const mintVersion = await mintVersionFunction(() => database.sql, () => `version-${nextId++}`);

    const published = await Promise.all([
      mintVersion('artifact', 'hash-2', 2),
      mintVersion('artifact', 'hash-3', 3),
    ]);

    expect(published.sort()).toEqual(['version-2', 'version-3']);
    expect(database.state.versions.map((version) => version.seq)).toEqual([1, 2, 3]);
    expect(database.state.snapshots.get('version-2')).toEqual(['root', 'reply']);
    expect(database.state.snapshots.get('version-3')).toEqual(['root', 'reply']);
    expect(database.state.snapshots.get(database.state.pointer)).toEqual(['root', 'reply']);
  });
});
