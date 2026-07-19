import { expect, test, type Page } from '@playwright/test';

const now = Math.floor(Date.now() / 1000);
const labels = [
  { key: 'blocker', label: 'Blocker', description: 'Stops release', color: '#9f3826', enabled: true, position: 1 },
  { key: 'concern', label: 'Concern', description: 'Needs discussion', color: '#9a5b13', enabled: true, position: 2 },
  { key: 'question', label: 'Question', description: 'Needs an answer', color: '#285e8e', enabled: true, position: 3 },
  { key: 'action', label: 'Action', description: 'Follow-up work', color: '#4d568c', enabled: true, position: 4 },
  { key: 'risk', label: 'Release risk', description: 'Release confidence', color: '#b42318', enabled: true, position: 5 },
  { key: 'security', label: 'Security', description: 'Security review', color: '#6941c6', enabled: true, position: 6 },
  { key: 'docs', label: 'Docs', description: 'Documentation request', color: '#175cd3', enabled: true, position: 7 },
  { key: 'old', label: 'Historical', description: 'Disabled label', color: '#667085', enabled: false, position: 8 },
  { key: 'resolution', label: 'Resolution', description: '', color: '#14795c', enabled: true, position: 9 },
];
const threads = [
  { id: 'one', status: 'open', scope_type: 'artifact', created_at: now, created_by_label: 'Reviewer', messages: [{ id: 'm1', author_label: 'Reviewer', body: 'Typed root', kind: 'blocker', created_at: now }, { id: 'm2', author_label: 'Reply', body: 'Untyped reply', kind: null, created_at: now }] },
  { id: 'two', status: 'open', scope_type: 'artifact', created_at: now, created_by_label: 'Reviewer', messages: [{ id: 'm3', author_label: 'Reviewer', body: 'Historical root', kind: 'old', created_at: now }, { id: 'm4', author_label: 'Reply', body: 'Question reply', kind: 'question', created_at: now }] },
];

async function boot(page: Page, response = { commentLabelRevision: 3, commentLabels: labels, threads }) {
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
  await page.goto('/');
  const root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  await expect(root.locator('#panel')).toBeVisible();
  return root;
}

test('renders enabled label surfaces, nullable messages, historical badges, and aggregate disclosure', async ({ page }) => {
  const root = await boot(page);
  await expect(root.locator('#kindFilter option')).toHaveText(['All labels', 'Blocker', 'Concern', 'Question', 'Action', 'Release risk', 'Security', 'Docs']);
  await expect(root.locator('#list .kindBadge')).toHaveText(['Blocker', 'Historical', 'Question']);
  await expect(root.locator('.summaryTotal')).toHaveText('2');
  const toggle = root.locator('#labelSummaryToggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(root.locator('.summaryPopover')).toBeVisible();
  await expect(root.locator('.scrim')).toBeVisible();
});

test('uses a searchable, keyboard-selectable enabled-only reply picker', async ({ page }) => {
  const root = await boot(page);
  await root.locator('.replyToggle').first().click();
  const replyForm = root.locator('.replyForm:visible');
  await replyForm.locator('.typeAdd').click();
  const search = replyForm.locator('.typeSearch');
  await expect(search).toHaveAttribute('role', 'combobox');
  await search.fill('documentation');
  await expect(search).toBeFocused();
  await expect(replyForm.locator('.typeOption')).toHaveText(['Docs']);
  await expect(search).toHaveAttribute('aria-activedescendant', /option-0$/);
  await search.press('Enter');
  await expect(replyForm.locator('.typeChipLabel')).toHaveText('Docs');
  await expect(replyForm.locator('.typeChip .tdot')).toHaveCSS('background-color', 'rgb(23, 92, 211)');
  await replyForm.locator('.typeChipRemove').click();
  await expect(replyForm.locator('.typeAdd')).toHaveText('+Add label');
});

test('offers the same optional untyped label interaction in the root composer', async ({ page }) => {
  const root = await boot(page);
  await root.locator('#panelClose').click();
  await root.locator('#launcher').click();
  await page.locator('#target').click();
  await expect(root.locator('#composer')).toBeVisible();
  await expect(root.locator('#rootLabelZone .typeAdd')).toHaveText('+Add label');
  await root.locator('#rootLabelZone .typeAdd').click();
  await root.locator('#rootLabelZone .typeSearch').fill('release confidence');
  await root.locator('#rootLabelZone .typeSearch').press('Enter');
  await expect(root.locator('#rootLabelZone .typeChipLabel')).toHaveText('Release risk');
});

test('polling clears a disabled draft label/filter while preserving reply text, focus, and caret', async ({ page }) => {
  let response = { commentLabelRevision: 3, commentLabels: labels, threads };
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    (window as any).__runWidgetPoll = null;
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 15000 && typeof handler === 'function') { (window as any).__runWidgetPoll = handler; return 1; }
      return original(handler, timeout, ...args);
    }) as typeof window.setInterval;
  });
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
  await page.goto('/');
  const root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  await root.locator('.replyToggle').nth(1).click();
  const form = root.locator('.replyForm:visible');
  const textarea = form.locator('.replyInput');
  await textarea.fill('Preserve this draft');
  await textarea.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(4, 8); });
  await form.locator('.typeAdd').click();
  await form.locator('.typeSearch').fill('question');
  await form.locator('.typeSearch').press('Enter');
  await root.locator('#kindFilter').selectOption('question');
  await textarea.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(4, 8); });
  response = { commentLabelRevision: 4, commentLabels: labels.map((label) => label.key === 'question' ? { ...label, enabled: false } : label), threads };
  await page.evaluate(() => (window as any).__runWidgetPoll());
  await expect(root.locator('#kindFilter')).toHaveValue('all');
  await expect(form.locator('.typeAdd')).toHaveText('+Add label');
  await expect(form.locator('.typeAdd')).toBeFocused();
  await expect(root.locator('#status')).toContainText('Reply label “Question” is no longer available; selection removed.');
  await expect(textarea).toHaveValue('Preserve this draft');
  await expect.poll(() => textarea.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([4, 8]);
});

test('survives unavailable storage and isolates the approved preference by stable instance scope', async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    (window as any).__disableStorage = () => {
      Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    };
    (window as any).__restoreStorage = () => { Storage.prototype.getItem = getItem; Storage.prototype.setItem = setItem; };
  });
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ commentLabelRevision: 3, commentLabels: labels, threads }) }));
  await page.goto('/?instance=blocked');
  await page.evaluate(() => (window as any).__disableStorage());
  await page.reload();
  let root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  await expect(root.locator('#labelSummaryToggle')).toHaveAttribute('aria-expanded', 'false');
  await root.locator('#labelSummaryToggle').click();
  await expect(root.locator('#labelSummaryToggle')).toHaveAttribute('aria-expanded', 'true');

  await page.evaluate(() => (window as any).__restoreStorage());
  await page.goto('/?instance=instance-a&artifact=artifact-one');
  root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  await root.locator('#labelSummaryToggle').click();
  await page.goto('/?instance=instance-a&artifact=artifact-two');
  root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  await expect(root.locator('#labelSummaryToggle')).toHaveAttribute('aria-expanded', 'true');
  await page.goto('/?instance=instance-b&artifact=artifact-one');
  root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  await expect(root.locator('#labelSummaryToggle')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('toss:comment-widget:instance-a:open-feedback-expanded'))).toBe('true');
});

test('summary disclosure retains focus for pointer, Enter, Space, and polling replacement', async ({ page }) => {
  let response = { commentLabelRevision: 3, commentLabels: labels, threads };
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 15000 && typeof handler === 'function') { (window as any).__runWidgetPoll = handler; return 1; }
      return original(handler, timeout, ...args);
    }) as typeof window.setInterval;
  });
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
  await page.goto('/?instance=toggle-focus');
  const root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  const toggle = root.locator('#labelSummaryToggle');
  await toggle.click();
  await expect(toggle).toBeFocused();
  await toggle.press('Enter');
  await expect(toggle).toBeFocused();
  await toggle.press('Space');
  await expect(toggle).toBeFocused();
  response = { ...response, commentLabelRevision: 4 };
  await page.evaluate(() => (window as any).__runWidgetPoll());
  await expect(toggle).toBeFocused();
});

test('supports full keyboard navigation, selection, escape focus return, and empty announcements in large and small pickers', async ({ page }) => {
  const root = await boot(page);
  await root.locator('.replyToggle').first().click();
  let form = root.locator('.replyForm:visible');
  await form.locator('.typeAdd').click();
  let search = form.locator('.typeSearch');
  await search.press('End');
  await expect(search).toHaveAttribute('aria-activedescendant', /option-6$/);
  await search.press('Home');
  await expect(search).toHaveAttribute('aria-activedescendant', /option-0$/);
  await search.press('ArrowUp');
  await expect(search).toHaveAttribute('aria-activedescendant', /option-6$/);
  await expect(search).toBeFocused();
  await search.press('Space');
  await expect(form.locator('.typeChipLabel')).toHaveText('Docs');
  await form.locator('.typeChipLabel').click();
  search = form.locator('.typeSearch');
  await search.fill('no-such-label');
  await expect(form.locator('.typeEmpty')).toHaveText('No labels match your search.');
  await expect(search).not.toHaveAttribute('aria-activedescendant', /.+/);
  await search.press('Escape');
  await expect(form).toBeVisible();
  await expect(form.locator('.typeChipLabel')).toBeFocused();

  const small = labels.filter((label) => ['blocker', 'concern', 'question'].includes(label.key));
  await page.unrouteAll({ behavior: 'wait' });
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ commentLabelRevision: 5, commentLabels: small, threads }) }));
  await page.reload();
  const smallRoot = page.locator('#toss-comments-root');
  await smallRoot.locator('#panelBtn').click();
  await smallRoot.locator('.replyToggle').first().click();
  form = smallRoot.locator('.replyForm:visible');
  await form.locator('.typeAdd').click();
  let option = form.locator('.typeOption.active');
  await option.press('End');
  option = form.locator('.typeOption.active');
  await expect(option).toHaveText('Question');
  await option.press('Home');
  option = form.locator('.typeOption.active');
  await expect(option).toHaveText('Blocker');
  await option.press('ArrowDown');
  option = form.locator('.typeOption.active');
  await expect(option).toHaveText('Concern');
  await option.press('Enter');
  await expect(form.locator('.typeChipLabel')).toHaveText('Concern');
  await form.locator('.typeChipLabel').click();
  await form.locator('.typeOption.active').press('Space');
  await expect(form.locator('.typeChipLabel')).toHaveText('Blocker');
  await form.locator('.typeChipLabel').click();
  await form.locator('.typeOption.active').press('Escape');
  await expect(form.locator('.typeChipLabel')).toBeFocused();
  await expect(form).toBeVisible();
});

test('hides all label UI when no labels are enabled and has no 360/390 overflow', async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const root = await boot(page, { commentLabelRevision: 4, commentLabels: labels.map((label) => ({ ...label, enabled: false })), threads });
    await expect(root.locator('#labelSummary')).toBeEmpty();
    await expect(root.locator('#labelFilterWrap')).toBeHidden();
    await root.locator('.replyToggle').first().click();
    await expect(root.locator('.typeZone:visible')).toHaveCount(0);
    const overflow = await root.locator('#panel').evaluate((panel) => panel.scrollWidth > panel.clientWidth);
    expect(overflow).toBe(false);
    await page.reload();
  }
});

test('persists aggregate preference while zero counts temporarily hide the bar', async ({ page }) => {
  let response = { commentLabelRevision: 3, commentLabels: labels, threads };
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
  await page.goto('/');
  const root = page.locator('#toss-comments-root');
  await root.locator('#panelBtn').click();
  await root.locator('#labelSummaryToggle').click();
  response = { ...response, commentLabelRevision: 4, threads: [] };
  await page.reload();
  await root.locator('#panelBtn').click();
  await expect(root.locator('#labelSummary')).toBeEmpty();
  response = { ...response, commentLabelRevision: 5, threads };
  await page.reload();
  await root.locator('#panelBtn').click();
  await expect(root.locator('#labelSummaryToggle')).toHaveAttribute('aria-expanded', 'true');
});

test('omits kind from untyped root and reply POST payloads', async ({ page }) => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  await page.addInitScript(() => localStorage.setItem('toss-comment-name', 'Piyush'));
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      posts.push({ url: request.url(), body: request.postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ commentLabelRevision: 3, commentLabels: labels, threads }) });
  });
  await page.goto('/?instance=payloads');
  const root = page.locator('#toss-comments-root');
  await root.locator('#launcher').click();
  await page.locator('#target').click();
  await root.locator('#cText').fill('Untyped root');
  await root.locator('#cAdd').click();
  await expect(root.locator('#panel')).toBeVisible();
  await root.locator('.replyToggle').first().click();
  await root.locator('.replyForm:visible .replyInput').fill('Untyped reply');
  await root.locator('.replyForm:visible .replyBtn').click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[0].body).not.toHaveProperty('kind');
  expect(posts[1].body).not.toHaveProperty('kind');
});

test('keeps badge and chip chrome neutral for white, black, and near-background configured colors', async ({ page }) => {
  const colorLabels = [
    { key: 'white', label: 'White', description: '', color: '#ffffff', enabled: true, position: 1 },
    { key: 'black', label: 'Black', description: '', color: '#000000', enabled: true, position: 2 },
    { key: 'near', label: 'Near', description: '', color: '#f8fafc', enabled: true, position: 3 },
  ];
  const colorThreads = colorLabels.map((label, index) => ({ id: `color-${index}`, status: 'open', scope_type: 'artifact', created_at: now, created_by_label: 'Reviewer', messages: [{ id: `cm-${index}`, author_label: 'Reviewer', body: label.label, kind: label.key, created_at: now }] }));
  const root = await boot(page, { commentLabelRevision: 7, commentLabels: colorLabels, threads: colorThreads });
  for (const badge of await root.locator('#list .kindBadge').all()) {
    await expect(badge).toHaveCSS('color', 'rgb(82, 96, 111)');
    await expect(badge).toHaveCSS('background-color', 'rgb(248, 250, 252)');
    await expect(badge).toHaveCSS('border-color', 'rgb(216, 221, 228)');
  }
  await root.locator('.replyToggle').first().click();
  const form = root.locator('.replyForm:visible');
  await form.locator('.typeAdd').click();
  await form.getByRole('option', { name: 'White' }).click();
  await expect(form.locator('.typeChip')).toHaveCSS('color', 'rgb(82, 96, 111)');
  await expect(form.locator('.typeChip')).toHaveCSS('background-color', 'rgb(248, 250, 252)');
  await expect(form.locator('.typeChip')).toHaveCSS('border-color', 'rgb(216, 221, 228)');
  await expect(form.locator('.tdot')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('ignores stale out-of-order poll responses', async ({ page }) => {
  const pending: import('@playwright/test').Route[] = [];
  let requests = 0;
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 15000 && typeof handler === 'function') { (window as any).__runWidgetPoll = handler; return 1; }
      return original(handler, timeout, ...args);
    }) as typeof window.setInterval;
  });
  await page.route('https://api.example.test/**', async (route) => {
    requests += 1;
    if (requests === 1) await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ commentLabelRevision: 1, commentLabels: labels, threads }) });
    else pending.push(route);
  });
  await page.goto('/?instance=stale');
  const root = page.locator('#toss-comments-root');
  await expect.poll(() => requests).toBe(1);
  await root.evaluate((host: HTMLElement) => { (host.shadowRoot!.querySelector('#panel') as HTMLElement).hidden = false; });
  await page.evaluate(() => { void (window as any).__runWidgetPoll(); void (window as any).__runWidgetPoll(); });
  await expect.poll(() => pending.length).toBe(2);
  const newestLabels = labels.map((label) => label.key === 'blocker' ? { ...label, label: 'Newest blocker' } : label);
  await pending[1].fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ commentLabelRevision: 3, commentLabels: newestLabels, threads }) });
  await expect(root.locator('#kindFilter option').nth(1)).toHaveText('Newest blocker');
  await pending[0].fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ commentLabelRevision: 2, commentLabels: labels, threads: [] }) });
  await expect(root.locator('#kindFilter option').nth(1)).toHaveText('Newest blocker');
  await expect(root.locator('.item')).toHaveCount(2);
});

test('announces root label invalidation and focuses its documented fallback', async ({ page }) => {
  let response = { commentLabelRevision: 3, commentLabels: labels, threads };
  await page.addInitScript(() => {
    const original = window.setInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: any[]) => {
      if (timeout === 15000 && typeof handler === 'function') { (window as any).__runWidgetPoll = handler; return 1; }
      return original(handler, timeout, ...args);
    }) as typeof window.setInterval;
  });
  await page.route('https://api.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
  await page.goto('/?instance=root-invalidation');
  const root = page.locator('#toss-comments-root');
  await root.locator('#launcher').click();
  await page.locator('#target').click();
  await root.locator('#rootLabelZone .typeAdd').click();
  await root.locator('#rootLabelZone .typeSearch').fill('question');
  await root.locator('#rootLabelZone .typeSearch').press('Enter');
  response = { commentLabelRevision: 4, commentLabels: labels.filter((label) => label.key !== 'question'), threads };
  await page.evaluate(() => (window as any).__runWidgetPoll());
  await expect(root.locator('#composer')).toBeVisible();
  await expect(root.locator('#rootLabelZone .typeAdd')).toBeFocused();
  await expect(root.locator('#status')).toContainText('Comment label “Question” is no longer available; selection removed.');
});

test('contains the exact 390x844 document, reaches long-list actions, and bounds the aggregate popover', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const longThreads = Array.from({ length: 24 }, (_, index) => ({ id: `long-${index}`, status: 'open', scope_type: 'artifact', created_at: now - index, created_by_label: `Reviewer ${index}`, messages: [{ id: `long-message-${index}`, author_label: 'Reviewer', body: `Long thread ${index} with reachable actions`, kind: labels[index % 7].key, created_at: now - index }] }));
  const root = await boot(page, { commentLabelRevision: 8, commentLabels: labels, threads: longThreads });
  expect(await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth <= document.documentElement.clientWidth, vertical: document.documentElement.scrollHeight <= document.documentElement.clientHeight }))).toEqual({ horizontal: true, vertical: true });
  await root.locator('#labelSummaryToggle').click();
  const counts = root.locator('.allCounts');
  expect(await counts.evaluate((element) => ({ verticalScroll: element.scrollHeight > element.clientHeight, horizontalOverflow: element.scrollWidth > element.clientWidth }))).toEqual({ verticalScroll: true, horizontalOverflow: false });
  await root.locator('#labelSummaryToggle').click();
  const lastResolve = root.locator('.item').last().locator('.resolve');
  await lastResolve.scrollIntoViewIfNeeded();
  await expect(lastResolve).toBeVisible();
  await lastResolve.focus();
  await expect(lastResolve).toBeFocused();
  expect(await root.locator('#panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
});
