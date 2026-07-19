import { createServer } from 'node:http';
import vercelApi from '../../../src/templates/vercel/api/index.js';
import type { VercelCommentWidgetConfig } from '../../../src/templates/vercel/api/index.js';

// The deploy template is a CommonJS package boundary, so tsx exposes its named
// exports on the default namespace. This is still a direct module import: no
// source parsing or test-only widget copy.
const { injectCommentsUI } = vercelApi as unknown as {
  injectCommentsUI: (html: string, config: VercelCommentWidgetConfig) => string;
};

const apiOrigin = process.env.WIDGET_API_ORIGIN || 'https://api.example.test';
const now = Math.floor(Date.now() / 1000);
const previewResponse = {
  commentLabelRevision: 1,
  commentLabels: [
    { key: 'blocker', label: 'Blocker', description: 'Stops release', color: '#9f3826', enabled: true, position: 1 },
    { key: 'question', label: 'Question', description: 'Needs an answer', color: '#285e8e', enabled: true, position: 2 },
  ],
  threads: [{ id: 'preview-thread', status: 'open', scope_type: 'artifact', created_at: now, created_by_label: 'Reviewer', messages: [{ id: 'preview-message', author_label: 'Reviewer', body: 'Preview of configurable comment labels', kind: 'blocker', created_at: now }] }],
};

createServer((request, response) => {
  if (request.url?.includes('/comment-threads')) {
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    response.end(JSON.stringify(previewResponse));
    return;
  }
  const url = new URL(request.url || '/', 'http://widget.test');
  const instanceScope = url.searchParams.get('instance') || 'browser-instance';
  const artifactId = url.searchParams.get('artifact') || 'browser-test';
  const page = injectCommentsUI('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>Widget host</h1><p id="target">Deterministic production widget host</p></main></body></html>', {
    artifactId,
    viewerToken: 'token',
    origin: apiOrigin,
    artifactBasePath: `/a/${artifactId}/`,
    currentPagePath: 'index.html',
    instanceScope,
  });
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(page);
}).listen(4179, '0.0.0.0');
