// @ts-nocheck
import { neon } from '@neondatabase/serverless';

export const config = { runtime: 'edge' };

// JWT helpers (pure Web Crypto, edge-compatible)
function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str: string): string {
  const padLen = (4 - (str.length % 4)) % 4;
  str += new Array(padLen + 1).join('=');
  return atob(str.replace(/\-/g, '+').replace(/\_/g, '/'));
}

async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
  const sigStr = b64urlEncode(String.fromCharCode(...new Uint8Array(sig)));
  return `${header}.${body}.${sigStr}`;
}

async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown>> {
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) throw new Error('Invalid token format');
  let payload: string, sigData: string;
  try {
    payload = b64urlDecode(b);
    sigData = b64urlDecode(s);
  } catch { throw new Error('Invalid token format'); }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sig = new Uint8Array([...sigData].map((c) => c.charCodeAt(0)));
  const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(`${h}.${b}`));
  if (!valid) throw new Error('Invalid signature');
  return JSON.parse(payload);
}

// --- Artifact expiry primitives ---
// Single source of truth for "permanent vs time-bound" logic. Every place that
// looks at expires_at, builds an artifact JWT, or sets a session cookie's
// max-age routes through these helpers — keeps the permanent sentinel from
// drifting across handlers.

// expires_at = 0 in the DB and JWT payloads (alongside `permanent: true`) means
// "never expires". Time-bound rows store a unix-seconds deadline.
const PERMANENT = 0;
// Session cookies for permanent shares can't borrow `expires_at - now`, so we
// cap them at 30 days. Recipients re-auth after this window.
const PERMANENT_COOKIE_MAX_AGE = 30 * 86400;

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

function isArtifactExpired(expiresAt: number, now = nowSeconds()): boolean {
  return expiresAt > PERMANENT && expiresAt < now;
}

function artifactCookieMaxAge(expiresAt: number, now = nowSeconds()): number {
  return expiresAt === PERMANENT
    ? PERMANENT_COOKIE_MAX_AGE
    : Math.max(0, expiresAt - now);
}

// Sign a JWT that scopes access to a single artifact. Permanent artifacts get
// `permanent: true` plus a far-future `exp` (some clients require it); time-
// bound artifacts get a real `exp`.
async function issueArtifactJWT(artifactId: string, expiresAt: number, secret: string): Promise<string> {
  const now = nowSeconds();
  const payload = expiresAt === PERMANENT
    ? { sub: artifactId, iat: now, permanent: true, exp: now + 100 * 365 * 86400 }
    : { sub: artifactId, iat: now, exp: expiresAt };
  return signJWT(payload, secret);
}

// A comment grant authorizes commenting on one artifact. Distinct aud:"comment"
// (so a plain viewer/legacy token can't be replayed on comment routes) and it
// carries pwd_epoch, so a password change invalidates outstanding grants.
async function issueCommentGrant(artifactId: string, expiresAt: number, secret: string, epoch: number): Promise<string> {
  const now = nowSeconds();
  const cap = now + 24 * 3600;
  const exp = expiresAt === PERMANENT ? cap : Math.min(cap, expiresAt);
  return signJWT({ sub: artifactId, aud: 'comment', pwd_epoch: epoch, iat: now, exp }, secret);
}

// Parse a previously-issued artifact JWT payload. Returns the normalized
// expires_at (PERMANENT for permanent tokens, the original exp otherwise), or
// null if the time-bound token has expired. Caller has already verified the
// JWT signature and the `sub` field.
function readArtifactJWT(payload: Record<string, unknown>, now = nowSeconds()): { expiresAt: number } | null {
  if (payload.permanent === true) return { expiresAt: PERMANENT };
  if (typeof payload.exp === 'number') {
    if (payload.exp < now) return null;
    return { expiresAt: payload.exp };
  }
  return null;
}

// --- Config from env ---
const JWT_SECRET = process.env.JWT_SECRET || '';
const OWNER_TOKEN = process.env.OWNER_TOKEN || '';
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';

// --- Neon client ---
function getSQL() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL not configured');
  return neon(DATABASE_URL);
}

// --- Blob helpers (REST API, edge-compatible) ---
const BLOB_API_URL = 'https://blob.vercel-storage.com';

function getBlobStoreId(): string {
  const parts = BLOB_TOKEN.split('_');
  return parts[3] || '';
}

function blobUrl(pathname: string): string {
  const storeId = getBlobStoreId();
  return `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com/${pathname}`;
}

function blobHeaders(): Record<string, string> {
  return { authorization: `Bearer ${BLOB_TOKEN}` };
}

async function blobPut(pathname: string, body: string | ArrayBuffer | ReadableStream, contentType?: string) {
  const headers: Record<string, string> = {
    ...blobHeaders(),
    'x-vercel-blob-access': 'private',
    'x-add-random-suffix': '0',
  };
  if (contentType) headers['x-content-type'] = contentType;
  const res = await fetch(`${BLOB_API_URL}/${pathname}`, { method: 'PUT', headers, body });
  if (!res.ok) throw new Error(`Blob put failed: ${res.status}`);
  return res.json();
}

async function blobGet(pathname: string): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const res = await fetch(blobUrl(pathname), { headers: blobHeaders() });
    if (!res.ok) return null;
    return res.body as ReadableStream<Uint8Array>;
  } catch {
    return null;
  }
}

async function blobList(prefix: string): Promise<string[]> {
  const res = await fetch(`${BLOB_API_URL}?prefix=${encodeURIComponent(prefix)}`, { headers: blobHeaders() });
  if (!res.ok) throw new Error(`Blob list failed: ${res.status}`);
  const data = await res.json();
  return (data.blobs || []).map((b: { pathname: string }) => b.pathname);
}

async function blobDelete(pathname: string) {
  const url = blobUrl(pathname);
  const res = await fetch(`${BLOB_API_URL}/delete`, {
    method: 'POST',
    headers: { ...blobHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ urls: [url] }),
  });
  if (!res.ok) throw new Error(`Blob delete failed: ${res.status}`);
}

// --- Crypto helpers ---
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// --- Auth ---
interface AuthUser {
  tokenHash: string;
  isAdmin: boolean;
  label: string;
}

function authJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('Vary', 'Authorization, Cookie');
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function resolveUser(request: Request): Promise<AuthUser | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const tokenHash = await sha256(token);

  const adminHash = await sha256(OWNER_TOKEN);
  if (constantTimeEqual(tokenHash, adminHash)) {
    return { tokenHash, isAdmin: true, label: 'admin' };
  }

  if (MULTI_TENANT) {
    const sql = getSQL();
    const rows = await sql`SELECT is_admin, label FROM users WHERE token_hash = ${tokenHash}`;
    if (rows[0]) {
      return { tokenHash, isAdmin: rows[0].is_admin === 1, label: rows[0].label || 'member' };
    }
  }
  return null;
}

function requireUser(request: Request): Promise<AuthUser | Response> {
  return resolveUser(request).then((u) => u ?? new Response('Unauthorized', { status: 401 }));
}

function requireAdmin(request: Request): Promise<AuthUser | Response> {
  return resolveUser(request).then((u) => {
    if (!u) return new Response('Unauthorized', { status: 401 });
    if (!u.isAdmin) return new Response('Forbidden', { status: 403 });
    return u;
  });
}

// --- Reserved slugs (route namespace) ---
// Caller-supplied --id values matching any of these are rejected so they
// can't shadow built-in routes.
const RESERVED_SLUGS = new Set([
  's', 'a', 'tokens', 'artifacts', 'health', 'api', 'status',
]);

// --- ID / Slug generation ---
function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Opaque random slug — 12 chars of [a-z0-9] (~62 bits) from a CSPRNG.
// Never derived from the user's filename or path (those leak local structure).
// Long-lived/permanent bearer URLs need real entropy, not Math.random().
const SLUG_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const SLUG_LEN = 12;
function generateSlug(): string {
  // Reject-sample so the modulus skew is zero. With a 36-char alphabet, bytes
  // < 252 (= 36*7) are unbiased; the rest are discarded.
  const out: string[] = [];
  while (out.length < SLUG_LEN) {
    const buf = crypto.getRandomValues(new Uint8Array(SLUG_LEN * 2));
    for (let i = 0; i < buf.length && out.length < SLUG_LEN; i++) {
      if (buf[i] < 252) out.push(SLUG_CHARS[buf[i] % 36]);
    }
  }
  return out.join('');
}

// --- MIME ---
function mimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    html: 'text/html', htm: 'text/html', js: 'application/javascript',
    jsx: 'application/javascript', ts: 'application/typescript',
    tsx: 'application/typescript', css: 'text/css', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    txt: 'text/plain', xml: 'application/xml', pdf: 'application/pdf',
    md: 'text/markdown',
  };
  return map[ext] || 'application/octet-stream';
}

function passwordForm(slug: string, error: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Password Required</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); width: 100%; max-width: 360px; }
    h1 { font-size: 1.25rem; margin: 0 0 1rem; color: #333; }
    p { color: #666; margin: 0 0 1.5rem; font-size: 0.875rem; }
    input[type="password"] { width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; box-sizing: border-box; margin-bottom: 0.75rem; }
    input[type="password"]:focus { outline: none; border-color: #0066ff; }
    button { width: 100%; padding: 0.75rem; background: #0066ff; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #0052cc; }
    .error { color: #d32f2f; font-size: 0.875rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Password Required</h1>
    <p>This link is password-protected.</p>
    ${error ? '<div class="error">Incorrect password. Please try again.</div>' : ''}
    <form method="POST" action="/s/${slug}">
      <input type="password" name="password" placeholder="Enter password" autofocus required />
      <button type="submit">View Content</button>
    </form>
  </div>
</body>
</html>`;
}

// The gate is returned for ANY unauthenticated path under a protected slug —
// including sub-resource assets (config.js, styles.css, …). Those asset URLs are
// otherwise served `public, max-age=0, must-revalidate`, so a shared cache could
// store this 200 gate HTML keyed to e.g. /s/<slug>/config.js and replay it even
// after the viewer authenticates — the browser then runs HTML as JS. `no-store`
// keeps the gate out of every cache; `Vary: Cookie` marks it as session-dependent.
function passwordFormResponse(slug: string, error: boolean, status: number): Response {
  return new Response(passwordForm(slug, error), {
    status,
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-store',
      'Vary': 'Cookie',
    },
  });
}

async function requireViewerForArtifact(request: Request, artifactId: string): Promise<true | Response> {
  const token = request.headers.get('X-Toss-Viewer');
  if (!token) return new Response('Missing viewer token', { status: 401 });
  try {
    const payload = await verifyJWT(token, JWT_SECRET);
    if (payload.sub !== artifactId) return new Response('Forbidden', { status: 403 });
    // readArtifactJWT handles both permanent (no exp check) and time-bound tokens uniformly.
    if (!readArtifactJWT(payload)) return new Response('Link expired', { status: 410 });
    return true;
  } catch {
    return new Response('Invalid viewer token', { status: 401 });
  }
}

// A viewer JWT can outlive the artifact (revoke leaves a still-valid token).
// Every comment route runs this after the viewer check so a leaked URL can't
// keep reading/posting against a deleted or expired artifact.
async function requireLiveArtifact(artifactId: string): Promise<true | Response> {
  const sql = getSQL();
  const rows = await sql`SELECT expires_at FROM artifacts WHERE id = ${artifactId}`;
  if (!rows[0]) return new Response('Not found', { status: 404 });
  if (isArtifactExpired(rows[0].expires_at)) return new Response('Link expired', { status: 410 });
  return true;
}

// Comment-API contract: the artifact must have comments enabled (per-share
// opt-in) AND still be live (not revoked/expired) AND the caller must present
// either a valid comment grant (a distinct aud:"comment" token issued at serve
// time — the plain viewer/legacy token has no aud and is rejected here) OR the
// owner token (Bearer) for programmatic/cloud access. Returns true | Response.
async function requireCommentAccess(request: Request, artifactId: string, opts: { requireEnabled?: boolean } = {}): Promise<true | Response> {
  const sql = getSQL();
  const rows = await sql`SELECT comments_enabled, expires_at, password_epoch, token_hash, password_hash FROM artifacts WHERE id = ${artifactId}`;
  const row = rows[0];
  // A null row also covers a missing/revoked artifact.
  if (!row) return new Response('Not found', { status: 404 });
  // Version listing reads artifact metadata (not comment bodies), so it stays
  // available when comments are toggled off; callers pass requireEnabled:false.
  if (opts.requireEnabled !== false && !row.comments_enabled) return new Response('Not found', { status: 404 });
  if (isArtifactExpired(row.expires_at)) return new Response('Link expired', { status: 410 });

  // Admin OR the artifact's own owner is a first-class reader/writer
  // (programmatic/cloud access). Multi-tenant: a tenant reads/writes comments on
  // the artifacts they own with just their token — no grant needed.
  const user = await resolveUser(request);
  if (user?.isAdmin) return true;
  if (user && row.token_hash && user.tokenHash === row.token_hash) return true;

  // Programmatic collaborative access: the document password, sent out-of-band via
  // X-Toss-Password (e.g. `toss comments --password-env KEY` — the agent passes the
  // KEY, never the value). Same salt as the page gate; constant-time compare.
  const pw = request.headers.get('X-Toss-Password');
  if (pw && row.password_hash) {
    const h = await sha256(pw + artifactId);
    if (constantTimeEqual(h, String(row.password_hash))) return true;
  }

  // Otherwise require the comment grant; the distinct aud breaks the conflation
  // with the plain viewer token and pwd_epoch ties it to the current password.
  const token = request.headers.get('X-Toss-Viewer');
  if (!token) return new Response('Missing comment grant', { status: 401 });
  try {
    const payload = await verifyJWT(token, JWT_SECRET);
    if (payload.aud !== 'comment') return new Response('Forbidden', { status: 403 });
    if (payload.sub !== artifactId) return new Response('Forbidden', { status: 403 });
    if (typeof payload.exp !== 'number' || payload.exp < nowSeconds()) return new Response('Grant expired', { status: 401 });
    if ((Number(payload.pwd_epoch) || 0) !== (Number(row.password_epoch) || 0)) return new Response('Grant expired', { status: 401 });
    return true;
  } catch {
    return new Response('Invalid comment grant', { status: 401 });
  }
}

// Shape comment rows into the API response (threads with nested messages, token
// hashes stripped). Used by both the latest-version and the ?version=<seq> reads.
function hydrateCommentThreads(threadRows: any[], messageRows: any[]) {
  const grouped = new Map();
  for (const row of messageRows) {
    const items = grouped.get(row.thread_id) || [];
    const out = { ...row, can_edit: !row.deleted_at && row.thread_status !== 'resolved', can_delete: !row.deleted_at };
    delete out.author_token_hash;
    items.push(out);
    grouped.set(row.thread_id, items);
  }
  return threadRows.map((thread) => {
    const out = { ...thread, anchor: thread.anchor_json ? JSON.parse(thread.anchor_json) : null, can_delete: true, can_resolve: true, messages: grouped.get(thread.id) || [] };
    delete out.created_by_token_hash;
    return out;
  });
}

type CommentScope = 'artifact' | 'element' | 'selection';

function normalizePagePath(value: unknown): string | Response {
  if (typeof value !== 'string') return new Response('Page path is required', { status: 400 });
  let pagePath = value.trim().replace(/\\/g, '/');
  if (!pagePath) pagePath = 'index.html';
  if (pagePath.endsWith('/')) pagePath += 'index.html';
  const parts = pagePath.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    return new Response('Invalid page path', { status: 400 });
  }
  pagePath = parts.join('/') || 'index.html';
  if (pagePath.length > 512) return new Response('Page path is too long', { status: 400 });
  return pagePath;
}

// The commenter's display name — a self-entered claim (not verified), stored
// immutably as author_label and HTML-escaped on render. No toss token/password.
function normalizeName(body: unknown): string | Response {
  const raw = body && typeof body === 'object' && typeof (body as { name?: unknown }).name === 'string'
    ? (body as { name: string }).name.trim()
    : '';
  if (!raw) return new Response('Name is required', { status: 400 });
  if (raw.length > 80) return new Response('Name is too long', { status: 400 });
  return raw;
}

// Legacy token columns are NOT NULL but identity is now author_label; write a
// sentinel so old (token-based) and new (name-based) rows coexist, no migration.
const NO_TOKEN = '';

// Append-only immutable version record. Mints seq N+1, advances the artifact's
// current_version_id pointer, carries forward all non-deleted threads
// (open or resolved) from the previous version, and on the first version
// grandfathers any pre-versioning threads (version_id NULL) to it so the
// latest-only filter shows them.
async function mintVersion(artifactId: string, contentHash: string, now: number): Promise<string> {
  const sql = getSQL();
  const last = await sql`SELECT id, seq FROM artifact_versions WHERE artifact_id = ${artifactId} ORDER BY seq DESC LIMIT 1`;
  const seq = (last[0] && last[0].seq ? Number(last[0].seq) : 0) + 1;
  const versionId = generateId();
  await sql`INSERT INTO artifact_versions (id, artifact_id, seq, content_hash, created_at) VALUES (${versionId}, ${artifactId}, ${seq}, ${contentHash}, ${now})`;
  await sql`UPDATE artifacts SET current_version_id = ${versionId} WHERE id = ${artifactId}`;
  if (seq > 1) {
    const prevVersionId = last[0]?.id;
    // Copy every non-deleted thread (open or resolved) and its
    // non-deleted messages onto the new version with fresh IDs.
    // Only soft-deleted threads are excluded.
    const threads = await sql`SELECT id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, created_at, updated_at FROM comment_threads WHERE artifact_id = ${artifactId} AND version_id = ${prevVersionId} AND deleted_at IS NULL`;
    for (const thread of threads) {
      const newThreadId = generateId();
      await sql`INSERT INTO comment_threads (id, artifact_id, version_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, created_at, updated_at) VALUES (${newThreadId}, ${artifactId}, ${versionId}, ${thread.page_path}, ${thread.created_by_token_hash}, ${thread.created_by_label}, ${thread.scope_type}, ${thread.anchor_json}, ${thread.status}, ${thread.created_at}, ${thread.updated_at})`;
      const messages = await sql`SELECT author_token_hash, author_label, body, created_at, updated_at FROM comment_messages WHERE thread_id = ${thread.id} AND deleted_at IS NULL ORDER BY created_at ASC`;
      for (const msg of messages) {
        await sql`INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, created_at, updated_at) VALUES (${generateId()}, ${newThreadId}, ${msg.author_token_hash}, ${msg.author_label}, ${msg.body}, ${msg.created_at}, ${msg.updated_at})`;
      }
    }
  } else if (seq === 1) {
    await sql`UPDATE comment_threads SET version_id = ${versionId} WHERE artifact_id = ${artifactId} AND version_id IS NULL`;
  }
  return versionId;
}

function normalizeThreadInput(body: unknown): { body: string; scopeType: CommentScope; anchorJson: string | null; pagePath: string } | Response {
  if (!body || typeof body !== 'object') return new Response('Invalid payload', { status: 400 });
  const payload = body as { body?: unknown; scopeType?: unknown; anchor?: unknown; pagePath?: unknown };
  const message = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!message) return new Response('Comment body is required', { status: 400 });
  if (message.length > 4000) return new Response('Comment is too long', { status: 400 });
  const pagePath = normalizePagePath(payload.pagePath ?? 'index.html');
  if (pagePath instanceof Response) return pagePath;

  const scopeType = payload.scopeType === 'element' || payload.scopeType === 'selection' || payload.scopeType === 'artifact'
    ? payload.scopeType
    : null;
  if (!scopeType) return new Response('Invalid scope type', { status: 400 });

  if (scopeType === 'artifact') {
    return { body: message, scopeType, anchorJson: null, pagePath };
  }

  if (!payload.anchor || typeof payload.anchor !== 'object') {
    return new Response('Anchor is required', { status: 400 });
  }

  const anchorJson = JSON.stringify(payload.anchor);
  if (anchorJson.length > 6000) return new Response('Anchor is too large', { status: 400 });
  return { body: message, scopeType, anchorJson, pagePath };
}

function normalizeMessageInput(body: unknown): string | Response {
  if (!body || typeof body !== 'object') return new Response('Invalid payload', { status: 400 });
  const message = typeof (body as { body?: unknown }).body === 'string' ? (body as { body: string }).body.trim() : '';
  if (!message) return new Response('Comment body is required', { status: 400 });
  if (message.length > 4000) return new Response('Comment is too long', { status: 400 });
  return message;
}

function injectCommentsUI(html: string, config: {
  artifactId: string;
  viewerToken: string;
  origin: string;
  artifactBasePath: string;
  currentPagePath: string;
}): string {
  const payload = JSON.stringify(config);
  const shell = `
<div id="toss-comments-root"></div>
<script>
(() => {
  const cfg = ${payload};
  const NAME_KEY = 'toss-comment-name';
  const PAGE = cfg.currentPagePath || 'index.html';
  const state = { mode: 'browse', threads: [], name: localStorage.getItem(NAME_KEY) || '', pending: null, hoverEl: null, loaded: false };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const txt = (el) => (el && (el.innerText || el.textContent) || '').trim();
  const ago = (ts) => { const s = Math.floor(Date.now() / 1000 - ts); if (s < 60) return 'just now'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago'; };

  const host = document.getElementById('toss-comments-root');
  const sr = host.attachShadow({ mode: 'open' });
  const STYLE = '<style>:host{all:initial}*{box-sizing:border-box;font-family:-apple-system,system-ui,sans-serif}[hidden]{display:none!important}.launcher,.panelBtn{position:fixed;z-index:2147483640;border:0;cursor:pointer;border-radius:999px;font-size:14px;font-weight:600;color:#fff;background:#d9654a;box-shadow:0 6px 20px rgba(0,0,0,.18);padding:11px 18px}.launcher{right:20px;bottom:20px}.launcher.active{background:#111827}.panelBtn{right:20px;bottom:72px;background:#fff;color:#374151;padding:9px 14px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.14)}#count{display:inline-block;min-width:18px;padding:0 6px;margin-left:4px;background:#d9654a;color:#fff;border-radius:999px;font-size:11px;line-height:18px;text-align:center}.hint{position:fixed;z-index:2147483641;top:16px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 16px;border-radius:999px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.25)}#hl{position:fixed;z-index:2147483630;pointer-events:none;border-radius:6px}#hl.hover{outline:2px solid #d9654a;outline-offset:1px;background:rgba(217,101,74,.08)}#hl.flash{outline:2px solid #d9654a;background:rgba(217,101,74,.14);animation:tcp .5s ease-in-out 0s 3}@keyframes tcp{0%,100%{background:rgba(217,101,74,.05)}50%{background:rgba(217,101,74,.22)}}.panel{position:fixed;z-index:2147483645;top:0;right:0;width:360px;max-width:92vw;height:100vh;background:#fff;box-shadow:-8px 0 30px rgba(0,0,0,.16);display:flex;flex-direction:column}.panel header{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid #eef0f2}.panel header h3{margin:0;font-size:15px;color:#111827}.panel header button{border:0;background:none;font-size:16px;cursor:pointer;color:#9ca3af}#status{padding:0 18px;font-size:12px;color:#9a3412}#list{overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px}.empty{color:#9ca3af;text-align:center;padding:40px 16px;font-size:13px;line-height:1.7}.item{border:1px solid #eef0f2;border-radius:12px;padding:12px;cursor:pointer}.item:hover{box-shadow:0 4px 14px rgba(0,0,0,.1)}.ctxline{font-size:12px;color:#6b7280;margin-bottom:6px}.ctxline .sel{color:#d9654a}.meta{font-size:13px;color:#111827}.meta .agox{color:#9ca3af;font-weight:400;font-size:12px;margin-left:6px}.body{font-size:13px;color:#374151;line-height:1.5;margin-top:2px}.orphan{margin-top:8px;padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:12px;color:#9a3412;line-height:1.5}.composer{position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.3);width:520px;max-width:100%}.pad{padding:18px}.pad h3{margin:0 0 12px;font-size:15px;color:#111827}#ctx{background:#f8fafc;border:1px solid #eef0f2;border-radius:10px;padding:10px 12px;margin-bottom:12px}#ctx .cr{display:flex;gap:8px;font-size:12px;line-height:1.7;color:#111827}#ctx .cr span{color:#9ca3af;min-width:80px}#ctx code{font-size:11px;color:#be4b2f;word-break:break-all}.row{margin-bottom:10px}input,textarea{width:100%;border:1px solid #d7dadf;border-radius:10px;padding:10px 12px;font-size:14px;color:#111827}textarea{min-height:84px;resize:vertical}.actions{display:flex;justify-content:flex-end;gap:8px}.btn{border:0;border-radius:10px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer}.btn.ghost{background:#f1f2f4;color:#374151}.btn.primary{background:#d9654a;color:#fff}</style>';
  const MARKUP = '<button id="launcher" class="launcher">Comment</button><button id="panelBtn" class="panelBtn">Comments <span id="count">0</span></button><div id="hint" class="hint" hidden>Comment mode &middot; click a component or select text &middot; Esc to exit</div><div id="hl" hidden></div><aside id="panel" class="panel" hidden><header><h3>Comments</h3><button id="panelClose">&times;</button></header><div id="status"></div><div id="list"></div></aside><div id="composer" class="composer" hidden><div class="card"><div class="pad"><h3>Add a comment</h3><div id="ctx"></div><div class="row"><input id="cName" type="text" placeholder="Your name" maxlength="80"></div><div class="row"><textarea id="cText" placeholder="Describe the issue or suggestion"></textarea></div><div class="actions"><button id="cCancel" class="btn ghost">Cancel</button><button id="cAdd" class="btn primary">Add comment</button></div></div></div></div>';
  sr.innerHTML = STYLE + MARKUP;
  const $ = (s) => sr.querySelector(s);
  const launcher = $('#launcher'), panelBtn = $('#panelBtn'), countEl = $('#count'), hint = $('#hint'), hl = $('#hl');
  const panel = $('#panel'), list = $('#list'), composer = $('#composer'), ctx = $('#ctx'), cName = $('#cName'), cText = $('#cText'), statusEl = $('#status');

  launcher.addEventListener('click', () => setMode(state.mode === 'comment' ? 'browse' : 'comment'));
  panelBtn.addEventListener('click', () => { if (panel.hidden) openPanel(); else panel.hidden = true; });
  $('#panelClose').addEventListener('click', () => { panel.hidden = true; });
  $('#cCancel').addEventListener('click', closeComposer);
  $('#cAdd').addEventListener('click', addComment);

  function setStatus(t) { statusEl.textContent = t || ''; }

  // ---- comment-mode capture (document-level, capture phase) ----
  function onOver(e) { if (e.target === host) { clearHover(); return; } setHover(e.target); }
  function onClick(e) {
    if (e.target === host) return;
    e.preventDefault(); e.stopPropagation();
    const selA = window.getSelection();
    if (selA && !selA.isCollapsed && selA.toString().trim()) capture(captureSelection(selA));
    else capture(captureElement(e.target));
  }
  function onUp(e) {
    if (e.target === host) return;
    const selA = window.getSelection();
    if (selA && !selA.isCollapsed && selA.toString().trim()) {
      e.preventDefault(); e.stopPropagation();
      document.addEventListener('click', function sw(ev) { ev.preventDefault(); ev.stopPropagation(); document.removeEventListener('click', sw, true); }, true);
      capture(captureSelection(selA));
    }
  }
  function onKey(e) { if (e.key === 'Escape') { if (state.mode === 'comment') setMode('browse'); closeComposer(); } }

  function setMode(m) {
    state.mode = m;
    const on = m === 'comment';
    launcher.textContent = on ? 'Exit comment mode' : 'Comment';
    launcher.classList.toggle('active', on);
    hint.hidden = !on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (on) {
      document.addEventListener('mouseover', onOver, true);
      document.addEventListener('mouseup', onUp, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    } else {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseup', onUp, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      clearHover();
    }
  }
  function openPanel() { panel.hidden = false; loadThreads(); }

  // ---- highlight ----
  function boxAt(r, cls) { hl.className = cls || ''; hl.style.left = r.left + 'px'; hl.style.top = r.top + 'px'; hl.style.width = r.width + 'px'; hl.style.height = r.height + 'px'; hl.hidden = false; }
  function setHover(el) { state.hoverEl = el; boxAt(el.getBoundingClientRect(), 'hover'); }
  function clearHover() { state.hoverEl = null; hl.hidden = true; }
  let flashT = null;
  function flash(el) { boxAt(el.getBoundingClientRect(), 'flash'); clearTimeout(flashT); flashT = setTimeout(() => { hl.hidden = true; }, 2600); }

  // ---- locator (hashed classes excluded) ----
  function hashed(c) { return /^(css|sc|jsx)-[a-z0-9]{4,}$/i.test(c) || (/^[a-z0-9_-]*[0-9a-f]{6,}[a-z0-9_-]*$/i.test(c) && !/[aeiou]{2}/i.test(c)); }
  function classesOf(n) { const v = (n.className && n.className.toString().trim()) || ''; return v ? v.split(/ +/).filter((c) => c && !hashed(c)) : []; }
  function esc2(s) { try { return CSS.escape(s); } catch (e) { return String(s); } }
  function seg(n) {
    if (n.id) return '#' + esc2(n.id);
    let s = n.tagName.toLowerCase();
    const cls = classesOf(n);
    if (cls.length) s += '.' + cls.slice(0, 2).map(esc2).join('.');
    const p = n.parentElement;
    if (p) { const same = Array.prototype.filter.call(p.children, (c) => c.tagName === n.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
    return s;
  }
  function buildLocator(el) {
    const parts = []; let n = el, d = 0;
    while (n && n.nodeType === 1 && n.tagName !== 'BODY' && d < 5) { parts.unshift(seg(n)); if (n.id) break; n = n.parentElement; d++; }
    const selector = parts.join(' > '); let ordinal = 0;
    try { const m = document.querySelectorAll(selector); ordinal = Array.prototype.indexOf.call(m, el); if (ordinal < 0) ordinal = 0; } catch (e) {}
    return { id: el.id || null, testid: el.getAttribute('data-testid') || null, aria: el.getAttribute('aria-label') || null, role: el.getAttribute('role') || null, tag: el.tagName.toLowerCase(), selector: selector, ordinal: ordinal };
  }
  function captureView() {
    const nav = document.querySelector('[aria-current],[role=tab][aria-selected=true],.tab.active,nav .active,.nav .active,.active[role=button]');
    const h1 = document.querySelector('h1');
    return { url: location.pathname + location.hash, navLabel: nav ? txt(nav).slice(0, 60) : null, heading: h1 ? txt(h1).slice(0, 80) : null };
  }
  function captureElement(el) {
    const r = el.getBoundingClientRect();
    return { kind: 'element', locator: buildLocator(el), state: { text: txt(el).slice(0, 300), outerHTML: (el.outerHTML || '').slice(0, 2000), rect: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) } }, view: captureView() };
  }
  function captureSelection(selA) {
    const range = selA.getRangeAt(0), exact = selA.toString().trim();
    const c = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const full = txt(c), i = full.indexOf(exact);
    const prefix = i >= 0 ? full.slice(Math.max(0, i - 40), i) : '', suffix = i >= 0 ? full.slice(i + exact.length, i + exact.length + 40) : '';
    const r = range.getBoundingClientRect();
    return { kind: 'selection', locator: buildLocator(c), quote: { prefix: prefix, exact: exact.slice(0, 240), suffix: suffix }, state: { text: exact.slice(0, 300), outerHTML: (c.outerHTML || '').slice(0, 2000), rect: { x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) } }, view: captureView() };
  }

  // ---- compose + POST ----
  function capture(target) {
    state.pending = target; setMode('browse'); clearHover();
    const label = target.kind === 'selection' ? target.quote.exact : (target.state.text || '(element)');
    ctx.innerHTML = '<div class="cr"><span>Screen</span><b>' + esc(target.view.navLabel || target.view.heading || 'Page') + '</b></div>' +
      '<div class="cr"><span>' + (target.kind === 'selection' ? 'Selected' : 'Component') + '</span><b>' + esc(label.slice(0, 70)) + (label.length > 70 ? '…' : '') + '</b></div>' +
      '<div class="cr"><span>Anchor</span><code>' + esc(target.locator.selector) + '</code></div>';
    cName.value = state.name || ''; cText.value = ''; composer.hidden = false;
    setTimeout(() => { (cName.value ? cText : cName).focus(); }, 30);
  }
  function closeComposer() { composer.hidden = true; state.pending = null; }

  const api = async (path, init) => {
    init = init || {};
    const headers = { 'X-Toss-Viewer': cfg.viewerToken };
    if (init.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(cfg.origin + path, { method: init.method || 'GET', headers: headers, body: init.body });
    const t = await res.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  };
  function scopeOf(kind) { return kind === 'selection' ? 'selection' : (kind === 'page' ? 'artifact' : 'element'); }

  async function addComment() {
    if (!state.pending) return;
    const name = (cName.value || '').trim() || 'Anonymous';
    const body = (cText.value || '').trim();
    if (!body) { cText.focus(); return; }
    state.name = name; localStorage.setItem(NAME_KEY, name);
    const t = state.pending; const scopeType = scopeOf(t.kind);
    const anchor = { kind: t.kind, locator: t.locator, state: t.state, view: t.view }; if (t.quote) anchor.quote = t.quote;
    closeComposer(); setStatus('Posting…');
    try {
      const data = await api('/artifacts/' + cfg.artifactId + '/comment-threads', { method: 'POST', body: JSON.stringify({ name: name, body: body, pagePath: PAGE, scopeType: scopeType, anchor: scopeType === 'artifact' ? undefined : anchor }) });
      if (data && data.thread) { state.threads.unshift(data.thread); }
      setStatus(''); openPanel();
    } catch (e) { setStatus(e.message || 'Failed to post.'); panel.hidden = false; }
  }

  function applyThreads(threads) {
    const sig = threads.length + ':' + threads.map((t) => t.id + ':' + ((t.messages && t.messages.length) || 0) + ':' + (t.status || '')).join(',');
    if (sig === state.sig) return;
    state.sig = sig; state.threads = threads; render();
  }
  async function loadThreads() {
    try {
      const data = await api('/artifacts/' + cfg.artifactId + '/comment-threads?pagePath=' + encodeURIComponent(PAGE) + '&includeActivity=1');
      state.loaded = true; setStatus(''); applyThreads((data && data.threads) || []);
    } catch (e) { if (!state.loaded) setStatus(e.message || 'Failed to load.'); }
  }

  // ---- recovery ladder ----
  function attrSel(name, val) { return '[' + name + '="' + String(val).split('"').join('') + '"]'; }
  function findByText(needle) {
    needle = (needle || '').trim().slice(0, 50); if (!needle) return null;
    const els = document.querySelectorAll('body *'); let match = null, best = Infinity;
    for (let i = 0; i < els.length; i++) { const el = els[i]; if (el.closest('#toss-comments-root')) continue; const tt = el.textContent || ''; if (tt.indexOf(needle) >= 0 && tt.length < best) { best = tt.length; match = el; } }
    return match;
  }
  function relocate(a) {
    if (!a || !a.locator) return null;
    const L = a.locator;
    if (L.id) { const e = document.getElementById(L.id); if (e) return e; }
    if (L.testid) { const e2 = document.querySelector(attrSel('data-testid', L.testid)); if (e2) return e2; }
    if (L.aria) { const e3 = document.querySelector(attrSel('aria-label', L.aria)); if (e3) return e3; }
    try { const m = document.querySelectorAll(L.selector); if (m.length) { if (a.state && a.state.text) { const key = a.state.text.slice(0, 30); for (let i = 0; i < m.length; i++) if ((m[i].textContent || '').indexOf(key) >= 0) return m[i]; } return m[Math.min(L.ordinal || 0, m.length - 1)]; } } catch (e) {}
    return findByText((a.quote && a.quote.exact) || (a.state && a.state.text));
  }

  // ---- render ----
  function render() {
    countEl.textContent = state.threads.length;
    if (!state.threads.length) { list.innerHTML = '<div class="empty">No comments yet.<br>Click <b>Comment</b>, then click a component (or select text).</div>'; return; }
    list.innerHTML = state.threads.map((th) => {
      const a = th.anchor || {}; const view = a.view || {}; const st = a.state || {};
      const label = a.quote ? ('“' + a.quote.exact + '”') : (st.text || (th.scope_type === 'artifact' ? 'Whole page' : '(element)'));
      const msg = (th.messages && th.messages[0]) || {};
      return '<div class="item" data-id="' + esc(th.id) + '">' +
        '<div class="ctxline">📍 ' + esc(view.navLabel || view.heading || 'Page') + ' · <span class="sel">' + esc(label.slice(0, 46)) + (label.length > 46 ? '…' : '') + '</span></div>' +
        '<div class="meta"><b>' + esc(th.created_by_label || msg.author_label || 'Someone') + '</b><span class="agox">' + ago(th.created_at || Math.floor(Date.now() / 1000)) + '</span></div>' +
        '<div class="body">' + esc(msg.body || '') + '</div>' +
        '<div class="orphan" hidden></div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.item'), (el) => { el.addEventListener('click', () => onItem(el.getAttribute('data-id'), el)); });
  }
  function onItem(id, el) {
    const th = state.threads.filter((x) => x.id === id)[0]; if (!th) return;
    const target = relocate(th.anchor || {}), orphan = el.querySelector('.orphan');
    if (target) { orphan.hidden = true; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => flash(target), 300); }
    else { const a = th.anchor || {}; const view = a.view || {}; const st = a.state || {}; orphan.hidden = false; orphan.innerHTML = '⚠ The page changed since this was written. It referred to <b>“' + esc((st.text || '').slice(0, 80)) + '”</b> on the <b>' + esc(view.navLabel || view.heading || 'page') + '</b> screen.'; }
  }

  cName.value = state.name;
  setMode('browse');
  loadThreads();
  setInterval(loadThreads, 15000);
})();
</script>
`;
  return html.includes('</body>') ? html.replace('</body>', shell + '</body>') : html + shell;
}

// --- Serve artifact ---
interface ArtifactMeta {
  id: string;
  expires_at: number;
}

async function serveArtifact(
  meta: ArtifactMeta,
  filePath: string,
  request: Request,
  routeConfig: { artifactBasePath: string }
): Promise<Response> {
  if (isArtifactExpired(meta.expires_at)) {
    return new Response('Link expired', { status: 410 });
  }

  const stream = await blobGet(`artifacts/${meta.id}/files/${filePath}`);
  if (!stream) {
    if (!filePath.endsWith('.html')) {
      const indexStream = await blobGet(`artifacts/${meta.id}/files/${filePath}/index.html`);
      if (indexStream) {
        return new Response(indexStream, {
          status: 200,
          headers: { 'Content-Type': 'text/html', 'X-Content-Type-Options': 'nosniff' },
        });
      }
    }
    return new Response('Not found', { status: 404 });
  }

  const headers: Record<string, string> = {
    'Content-Type': mimeType(filePath),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  if (filePath.endsWith('.html')) {
    const response = await fetch(blobUrl(`artifacts/${meta.id}/files/${filePath}`), { headers: blobHeaders() });
    if (!response.ok) return new Response('Not found', { status: 404 });
    const html = await response.text();
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; frame-ancestors 'none'; base-uri 'none';";
    // Comments are a per-share opt-in (comments_enabled), independent of MULTI_TENANT.
    const sql = getSQL();
    const commentsRows = await sql`SELECT comments_enabled, password_epoch FROM artifacts WHERE id = ${meta.id}`;
    if (!commentsRows[0] || !commentsRows[0].comments_enabled) {
      headers['Cache-Control'] = 'private, no-store, max-age=0';
      return new Response(html, { status: 200, headers });
    }
    const viewerToken = await issueCommentGrant(meta.id, meta.expires_at, JWT_SECRET, Number(commentsRows[0].password_epoch) || 0);
    const maxAge = artifactCookieMaxAge(meta.expires_at);
    headers['Set-Cookie'] = `toss_tok=${meta.id}; Path=/a/${meta.id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
    headers['Cache-Control'] = 'private, no-store, max-age=0';
    return new Response(
      injectCommentsUI(html, {
        artifactId: meta.id,
        viewerToken,
        origin: new URL(request.url).origin,
        artifactBasePath: routeConfig.artifactBasePath,
        currentPagePath: filePath,
      }),
      { status: 200, headers }
    );
  } else {
    // A slug share is mutable: `toss share --id <slug>` re-publishes new bytes
    // under the SAME filenames. `immutable` (max-age=86400) told browsers/CDNs to
    // never revalidate, so a re-share stayed invisible for up to 24h. Revalidate
    // instead — same freshness contract the HTML entry above already uses.
    headers['Cache-Control'] = 'public, max-age=0, must-revalidate';
    return new Response(stream, { status: 200, headers });
  }
}

// --- Default instance landing page (served at /). Static, domain-aware, no instance data. ---
function instancePage(origin: string, multiTenant: boolean): string {
  const cta = multiTenant
    ? `<div class="cmd"><span class="p">$</span> toss login ${origin} --token &lt;token&gt;</div>
    <p class="sub2">Need a token? Ask whoever runs this instance.</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>toss</title>
<style>
  :root{--ink:#0b0e14;--edge:#232a3a;--fg:#f3f5f7;--fg2:#c8cfda;--muted:#8b93a1;--teal:#1d9e75;--tealb:#5dcaa5;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}html,body{margin:0;height:100%}
  body{background:var(--ink);color:var(--fg);font-family:var(--sans);min-height:100vh;display:grid;place-items:center;overflow:hidden;position:relative}
  .aurora{position:fixed;inset:-25%;z-index:0;pointer-events:none;filter:blur(46px);opacity:.9;background:radial-gradient(38% 38% at 32% 30%,rgba(29,158,117,.30),transparent 62%),radial-gradient(34% 34% at 70% 62%,rgba(46,120,200,.20),transparent 62%),radial-gradient(30% 30% at 55% 48%,rgba(93,202,165,.14),transparent 60%);animation:drift 17s ease-in-out infinite alternate}
  @keyframes drift{from{transform:translate(-4%,-3%) scale(1)}to{transform:translate(5%,4%) scale(1.16)}}
  .grid{position:fixed;inset:-80px;z-index:0;pointer-events:none;background-image:radial-gradient(circle,rgba(93,202,165,.11) 1.4px,transparent 1.8px);background-size:44px 44px;-webkit-mask:radial-gradient(circle at 50% 42%,#000 28%,transparent 72%);mask:radial-gradient(circle at 50% 42%,#000 28%,transparent 72%);animation:pan 44s linear infinite}
  @keyframes pan{to{background-position:440px 320px}}
  .card{position:relative;z-index:1;max-width:460px;padding:40px 28px;text-align:center;animation:rise .9s cubic-bezier(.2,.7,.2,1) both}
  @keyframes rise{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
  .tile{width:88px;height:88px;border-radius:22px;background:#0f131c;display:inline-flex;align-items:center;justify-content:center;margin-bottom:24px;box-shadow:0 0 0 1px var(--edge),0 22px 60px rgba(0,0,0,.5);animation:float 5.5s ease-in-out infinite;position:relative}
  .tile::after{content:"";position:absolute;inset:-2px;border-radius:24px;box-shadow:0 0 36px 6px rgba(29,158,117,.35);animation:pulse 3.4s ease-in-out infinite;z-index:-1}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
  @keyframes pulse{0%,100%{opacity:.45}50%{opacity:.9}}
  .arc{stroke-dasharray:60;stroke-dashoffset:60;animation:draw 2.6s ease-in-out infinite}
  @keyframes draw{0%{stroke-dashoffset:60}45%{stroke-dashoffset:0}80%{stroke-dashoffset:0}100%{stroke-dashoffset:-60}}
  .win{animation:land 2.6s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
  @keyframes land{0%,70%{transform:scale(1)}84%{transform:scale(1.09)}94%,100%{transform:scale(1)}}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--fg2);background:rgba(20,25,37,.7);border:1px solid var(--edge);border-radius:999px;padding:6px 14px;margin-bottom:20px}
  .pill .d{width:7px;height:7px;border-radius:50%;background:var(--tealb);box-shadow:0 0 10px 1px rgba(93,202,165,.8);animation:blink 2.2s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}
  h1{font-size:34px;font-weight:600;letter-spacing:-.6px;line-height:1.12;margin:0;background:linear-gradient(100deg,#fff 10%,var(--tealb) 50%,#fff 90%);background-size:220% auto;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shine 7s linear infinite}
  @keyframes shine{to{background-position:220% center}}
  .lead{font-size:16.5px;color:var(--fg2);margin:14px 0 0;line-height:1.6}
  .hint{font-family:var(--mono);font-size:13px;color:var(--muted);margin-top:24px}
  .cmd{display:inline-flex;align-items:center;gap:9px;background:rgba(15,19,28,.85);border:1px solid var(--edge);border-radius:10px;padding:10px 14px;margin-top:14px;font-family:var(--mono);font-size:12.5px;color:#cdd3dd}
  .cmd .p{color:var(--tealb)}
  .sub2{font-size:13px;color:var(--muted);margin:10px 0 0}
  .more{display:inline-block;margin-top:26px;font-size:14.5px;color:var(--tealb);text-decoration:none;position:relative}
  .more::after{content:"";position:absolute;left:0;bottom:-3px;width:100%;height:1px;background:var(--tealb);transform:scaleX(0);transform-origin:left;transition:transform .35s ease}
  .more:hover::after{transform:scaleX(1)}
  footer{position:fixed;bottom:20px;left:0;right:0;text-align:center;z-index:1;color:#5b6470;font-size:12.5px;font-family:var(--mono)}
</style></head>
<body>
  <div class="aurora"></div><div class="grid"></div>
  <div class="card">
    <span class="tile"><svg width="52" height="52" viewBox="0 0 48 48" aria-hidden="true">
      <path class="arc" d="M8.5 38.5 C 14 29, 19 25, 23.5 22.6" fill="none" stroke="#5dcaa5" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="8.5" cy="38.5" r="2.3" fill="#5dcaa5" opacity="0.6"/>
      <g class="win"><g transform="rotate(-14 31 23)"><rect x="20.5" y="10.5" width="22" height="26" rx="4" fill="#fff"/><circle cx="25" cy="15.2" r="1" fill="#aab2bd"/><circle cx="28.2" cy="15.2" r="1" fill="#aab2bd"/><circle cx="31.4" cy="15.2" r="1" fill="#aab2bd"/><rect x="24.5" y="20.8" width="14" height="4" rx="2" fill="#1d9e75"/><rect x="24.5" y="28" width="10" height="2.8" rx="1.4" fill="#cdd3dd"/></g></g>
      <circle r="2.6" fill="#5dcaa5"><animateMotion dur="2.6s" repeatCount="indefinite" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.4 0 0.2 1" path="M8.5 38.5 C 14 29, 19 25, 23.5 22.6"/><animate attributeName="opacity" dur="2.6s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;0.15;0.85;1"/></circle>
    </svg></span>
    <div><span class="pill"><span class="d"></span>self-hosted instance</span></div>
    <h1>This is a toss instance</h1>
    <p class="lead">Publish HTML files and folders as shareable links — self-hosted, on your own domain.</p>
    <div class="hint">shares live at /s/&lt;slug&gt; · publishing needs a token</div>
    ${cta}
    <div><a class="more" href="https://tossme.xyz">What is toss? →</a></div>
  </div>
  <footer>powered by toss</footer>
</body></html>`;
}

// --- Main handler ---

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  try {
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, backend: 'vercel' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Seed admin user in multi-tenant mode if table is empty
    if (MULTI_TENANT) {
      const sql = getSQL();
      const rows = await sql`SELECT COUNT(*)::int as c FROM users`;
      if (rows[0]?.c === 0) {
        const adminHash = await sha256(OWNER_TOKEN);
        await sql`INSERT INTO users (token_hash, label, created_at, is_admin) VALUES (${adminHash}, 'admin', ${Math.floor(Date.now() / 1000)}, 1) ON CONFLICT DO NOTHING`;
      }
    }

    // ===== UPLOAD artifact =====
    if (url.pathname === '/artifacts' && request.method === 'POST') {
      const auth = await requireUser(request);
      if (auth instanceof Response) return auth;

      const contentLength = request.headers.get('Content-Length');
      const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
      if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_SIZE) {
        return new Response('Request too large', { status: 413 });
      }

      const name = url.searchParams.get('name') || 'untitled.html';
      const expiresParam = url.searchParams.get('expires');
      const requestedId = url.searchParams.get('id');
      // For a folder share the request body is only the entry index.html, but the
      // artifact represents the whole folder. The client sends the summed folder size
      // as total_bytes so `toss list` reports the real footprint, not the index size.
      // Absent/invalid (single-file shares) → fall back to the uploaded body length.
      const totalBytesParam = url.searchParams.get('total_bytes');

      // expires=0 or missing → permanent. Otherwise capped at 90 days.
      let expiresSeconds = 0;
      if (expiresParam !== null && expiresParam !== '0') {
        const parsed = parseInt(expiresParam, 10);
        if (isNaN(parsed) || parsed < 0) {
          return new Response('Invalid expires param', { status: 400 });
        }
        const MAX_TTL = 90 * 24 * 60 * 60;
        if (parsed > MAX_TTL) {
          return new Response('Max expiry is 90 days', { status: 400 });
        }
        expiresSeconds = parsed;
      }

      // Validate caller-supplied stable slug if present
      if (requestedId !== null) {
        if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(requestedId) || RESERVED_SLUGS.has(requestedId)) {
          return new Response('Invalid id: lowercase alphanumeric and hyphens, 3-64 chars', { status: 400 });
        }
      }

      const html = await request.text();
      const sizeBytes = totalBytesParam && /^\d+$/.test(totalBytesParam)
        ? Number(totalBytesParam) : html.length;
      const sql = getSQL();
      const now = Math.floor(Date.now() / 1000);

      // Replace-in-place when a stable slug already exists and is owned by the caller.
      // The slug stays (recipients keep working URLs); name, content, expires_at,
      // and password_hash all reflect the new request — re-sharing fully re-describes
      // the share. Omitting --password clears the password; omitting --expires (or
      // --expires never) makes it permanent.
      if (requestedId !== null) {
        const existing = await sql`SELECT id, token_hash FROM artifacts WHERE slug = ${requestedId}`;
        if (existing[0]) {
          if (existing[0].token_hash !== auth.tokenHash) {
            // Structured + actionable so an agent can recover (pick a different id) rather
            // than treat it as an opaque failure. Slugs are a single global namespace.
            return new Response(JSON.stringify({
              error: 'slug_taken',
              slug: requestedId,
              hint: 'This id is already used by another share. Re-run with a different --id, or omit --id for an auto-generated slug.',
            }), { status: 409, headers: { 'Content-Type': 'application/json' } });
          }
          const existingId = existing[0].id;
          // Versioning: mint a new immutable version when content changes (or --force);
          // fail-closed on a no-op re-share that would hide existing comments.
          const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
          const newHash = await sha256(html);
          const curV = await sql`SELECT av.content_hash AS chash FROM artifacts a LEFT JOIN artifact_versions av ON av.id = a.current_version_id WHERE a.id = ${existingId}`;
          const curHash = curV[0] ? curV[0].chash : null;
          const contentChanged = !curHash || curHash !== newHash;
          if (!contentChanged && !force) {
            // ANY comment on the artifact (current OR archived) blocks an identical
            // re-share. Re-publishing the same content over a doc that has comment
            // history must be explicit via --force.
            const cc = await sql`SELECT COUNT(*)::int AS n FROM comment_threads WHERE artifact_id = ${existingId} AND deleted_at IS NULL`;
            if ((cc[0] ? cc[0].n : 0) > 0) {
              return new Response(JSON.stringify({ error: 'comments_present_no_change', comment_count: cc[0].n, hint: '--force' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
            }
          }
          // Password salt is the artifact id, which is preserved on update.
          const passwordParam = url.searchParams.get('password');
          const newPasswordHash = passwordParam ? await sha256(passwordParam + existingId) : null;
          const newExpiresAt = expiresSeconds === 0 ? 0 : (now + expiresSeconds);
          // Folder re-share reconciliation: drop stale sub-files (anything other than
          // the entry) so a page removed/renamed in the new version can't orphan and
          // keep serving the old blob. index.html is overwritten in place just below;
          // the client re-uploads the current sub-files next via /files. Single-file
          // re-shares are unaffected (their only blob is index.html, which is skipped).
          const staleFiles = await blobList(`artifacts/${existingId}/files/`);
          for (const p of staleFiles) {
            if (p !== `artifacts/${existingId}/files/index.html`) await blobDelete(p);
          }
          await blobPut(`artifacts/${existingId}/files/index.html`, html, 'text/html');
          await sql`UPDATE artifacts SET name = ${name}, size_bytes = ${sizeBytes}, expires_at = ${newExpiresAt}, password_hash = ${newPasswordHash} WHERE id = ${existingId}`;
          if (contentChanged || force) {
            await mintVersion(existingId, newHash, now);
          }
          const shortUrl = `${url.origin}/s/${requestedId}`;
          return new Response(JSON.stringify({ id: existingId, slug: requestedId, url: shortUrl, legacyUrl: '', updated: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // New artifact.
      const id = generateId();
      let slug: string;
      if (requestedId !== null) {
        slug = requestedId;
      } else {
        // 62-bit slugs collide with vanishing probability, but a pre-check loop
        // beats relying on the DB unique constraint to surface a 500.
        slug = generateSlug();
        for (let attempt = 0; attempt < 5; attempt++) {
          const taken = await sql`SELECT 1 FROM artifacts WHERE slug = ${slug}`;
          if (!taken[0]) break;
          slug = generateSlug();
        }
      }

      const passwordParam = url.searchParams.get('password');
      const passwordHash = passwordParam ? await sha256(passwordParam + id) : null;
      const commentsParam = url.searchParams.get('comments');
      const commentsEnabled = commentsParam === '1' || commentsParam === 'true' ? 1 : 0;

      await blobPut(`artifacts/${id}/files/index.html`, html, 'text/html');

      const expiresAt = expiresSeconds === 0 ? PERMANENT : (now + expiresSeconds);
      await sql`INSERT INTO artifacts (id, slug, name, size_bytes, created_at, expires_at, token_hash, password_hash, comments_enabled) VALUES (${id}, ${slug}, ${name}, ${sizeBytes}, ${now}, ${expiresAt}, ${auth.tokenHash}, ${passwordHash}, ${commentsEnabled})`;
      await mintVersion(id, await sha256(html), now);

      // Legacy /a/:id?t=jwt URL. issueArtifactJWT handles the permanent vs
      // time-bound distinction so the verifier can normalize correctly.
      const jwt = await issueArtifactJWT(id, expiresAt, JWT_SECRET);
      const legacyUrl = `${url.origin}/a/${id}?t=${jwt}`;
      const shortUrl = `${url.origin}/s/${slug}`;

      return authJson({ id, slug, url: shortUrl, legacyUrl });
    }

    // ===== UPLOAD additional files =====
    const filesMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/files$/);
    if (filesMatch && request.method === 'POST') {
      const auth = await requireUser(request);
      if (auth instanceof Response) return auth;

      const contentLength = request.headers.get('Content-Length');
      const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
      if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_SIZE) {
        return new Response('Request too large', { status: 413 });
      }

      const id = filesMatch[1];
      const sql = getSQL();

      if (MULTI_TENANT && !auth.isAdmin) {
        const rows = await sql`SELECT token_hash FROM artifacts WHERE id = ${id}`;
        if (!rows[0] || !constantTimeEqual(rows[0].token_hash, auth.tokenHash)) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      let filePath = url.searchParams.get('path');
      if (!filePath) return new Response('Missing path param', { status: 400 });

      filePath = filePath.replace(/\\/g, '/');
      const parts = filePath.split('/').filter((p) => p !== '' && p !== '.');
      if (parts.some((p) => p === '..')) {
        return new Response('Invalid path', { status: 400 });
      }
      filePath = parts.join('/');

      const body = await request.arrayBuffer();
      await blobPut(`artifacts/${id}/files/${filePath}`, body, mimeType(filePath));

      return authJson({ uploaded: filePath });
    }

    // ===== LIST artifacts =====
    if (url.pathname === '/artifacts' && request.method === 'GET') {
      const auth = await requireUser(request);
      if (auth instanceof Response) return auth;

      const sql = getSQL();
      let results: any[];
      if (MULTI_TENANT && !auth.isAdmin) {
        results = await sql`SELECT id, slug, name, size_bytes, created_at, expires_at FROM artifacts WHERE token_hash = ${auth.tokenHash} ORDER BY created_at DESC`;
      } else {
        results = await sql`SELECT id, slug, name, size_bytes, created_at, expires_at FROM artifacts ORDER BY created_at DESC`;
      }

      return authJson(results);
    }

    // ===== DELETE artifact =====
    if (url.pathname.match(/^\/artifacts\/[a-f0-9-]+$/) && request.method === 'DELETE') {
      const auth = await requireUser(request);
      if (auth instanceof Response) return auth;

      const id = url.pathname.split('/')[2];
      const sql = getSQL();

      if (MULTI_TENANT && !auth.isAdmin) {
        const rows = await sql`SELECT token_hash FROM artifacts WHERE id = ${id}`;
        if (!rows[0] || !constantTimeEqual(rows[0].token_hash, auth.tokenHash)) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      const paths = await blobList(`artifacts/${id}/`);
      for (const p of paths) {
        await blobDelete(p);
      }
      // Cascade comments before the artifact row so a half-failed revoke
      // doesn't leave orphans with no way to find them again. Delete
      // messages first (they reference threads via thread_id).
      await sql`DELETE FROM comment_messages WHERE thread_id IN (SELECT id FROM comment_threads WHERE artifact_id = ${id})`;
      await sql`DELETE FROM comment_threads WHERE artifact_id = ${id}`;
      await sql`DELETE FROM artifacts WHERE id = ${id}`;

      return authJson({ revoked: id });
    }

    // ===== TOGGLE comments (per-share opt-in) =====
    const commentsToggleMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/comments$/);
    if (commentsToggleMatch && request.method === 'PATCH') {
      const auth = await requireUser(request);
      if (auth instanceof Response) return auth;
      const id = commentsToggleMatch[1];
      const sql = getSQL();

      // Owner/admin only — same ownership rule as DELETE.
      if (MULTI_TENANT && !auth.isAdmin) {
        const rows = await sql`SELECT token_hash FROM artifacts WHERE id = ${id}`;
        if (!rows[0] || !constantTimeEqual(rows[0].token_hash, auth.tokenHash)) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      let enabled: unknown;
      try {
        enabled = ((await request.json()) as { enabled?: unknown }).enabled;
      } catch {
        return new Response('Invalid payload', { status: 400 });
      }
      if (typeof enabled !== 'boolean') {
        return new Response('enabled (boolean) is required', { status: 400 });
      }
      await sql`UPDATE artifacts SET comments_enabled = ${enabled ? 1 : 0} WHERE id = ${id}`;
      return authJson({ id, comments_enabled: enabled });
    }

    const versionsMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/versions$/);
    if (versionsMatch && request.method === 'GET') {
      const artifactId = versionsMatch[1];
      // Listing versions is metadata about the artifact, so it stays available
      // even when comments are toggled off (counts simply read 0).
      const access = await requireCommentAccess(request, artifactId, { requireEnabled: false });
      if (access instanceof Response) return access;
      const sql = getSQL();
      const rows = await sql`SELECT av.seq, av.content_hash, av.created_at, (SELECT COUNT(*) FROM comment_threads ct WHERE ct.version_id = av.id AND ct.deleted_at IS NULL) AS comment_count, (av.id = a.current_version_id) AS is_current FROM artifact_versions av JOIN artifacts a ON a.id = av.artifact_id WHERE av.artifact_id = ${artifactId} ORDER BY av.seq DESC`;
      const versions = rows.map((r: any) => ({
        seq: Number(r.seq),
        content_hash: r.content_hash,
        created_at: Number(r.created_at),
        comment_count: Number(r.comment_count),
        is_current: r.is_current === true || r.is_current === 1 || r.is_current === 't',
      }));
      return authJson({ artifactId, versions });
    }

    const commentListMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/comment-threads$/);
    if (commentListMatch && request.method === 'GET') {
      const artifactId = commentListMatch[1];
      const access = await requireCommentAccess(request, artifactId);
      if (access instanceof Response) return access;
      const pagePath = normalizePagePath(url.searchParams.get('pagePath') || 'index.html');
      if (pagePath instanceof Response) return pagePath;
      const includeActivity = url.searchParams.get('includeActivity') === '1';

      const sql = getSQL();

      // Explore a specific version: ?version=<seq>. Returns the whole version's
      // threads across every page (page_path per thread), matched strictly by
      // version_id (no legacy-NULL fallback). Omitted => latest-only, below.
      const versionParam = url.searchParams.get('version');
      if (versionParam !== null) {
        const seq = Number(versionParam);
        if (!Number.isInteger(seq) || seq < 1) return new Response('version must be a positive integer', { status: 400 });
        const vrow = await sql`SELECT id FROM artifact_versions WHERE artifact_id = ${artifactId} AND seq = ${seq}`;
        if (!vrow[0]) {
          const maxRow = await sql`SELECT MAX(seq) AS max FROM artifact_versions WHERE artifact_id = ${artifactId}`;
          const max = maxRow[0] && maxRow[0].max ? Number(maxRow[0].max) : 0;
          return new Response(JSON.stringify({ error: 'version_not_found', seq, hint: max ? `this share has versions 1-${max}` : 'this share has no versions yet' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        const vid = vrow[0].id;
        const vThreads = await sql`SELECT id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_label, resolved_at, deleted_at, created_at, updated_at FROM comment_threads WHERE artifact_id = ${artifactId} AND version_id = ${vid} AND deleted_at IS NULL ORDER BY created_at DESC`;
        const vMessages = await sql`SELECT m.id, m.thread_id, m.author_token_hash, m.author_label, m.body, m.created_at, m.updated_at, m.deleted_at, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ${artifactId} AND t.version_id = ${vid} AND t.deleted_at IS NULL ORDER BY m.created_at ASC`;
        const vHydrated = hydrateCommentThreads(vThreads, vMessages);
        return authJson({ version: seq, versionId: vid, viewer: { authenticated: true, label: null }, threads: vHydrated, activityThreads: vHydrated });
      }

      // Latest-only: filter to the artifact's current version. NULL current
      // (legacy artifact, no version minted yet) => show all (no version filter).
      const curVerRow = await sql`SELECT current_version_id AS vid FROM artifacts WHERE id = ${artifactId}`;
      const curVid = curVerRow[0] ? curVerRow[0].vid : null;
      const threads = await sql`SELECT id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_label, resolved_at, deleted_at, created_at, updated_at FROM comment_threads WHERE artifact_id = ${artifactId} AND page_path = ${pagePath} AND (${curVid}::text IS NULL OR version_id = ${curVid}) AND deleted_at IS NULL ORDER BY created_at DESC`;
      const messages = await sql`SELECT m.id, m.thread_id, m.author_token_hash, m.author_label, m.body, m.created_at, m.updated_at, m.deleted_at, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ${artifactId} AND t.page_path = ${pagePath} AND (${curVid}::text IS NULL OR t.version_id = ${curVid}) AND t.deleted_at IS NULL ORDER BY m.created_at ASC`;
      const activityThreads = includeActivity
        ? await sql`SELECT id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_label, resolved_at, deleted_at, created_at, updated_at FROM comment_threads WHERE artifact_id = ${artifactId} AND (${curVid}::text IS NULL OR version_id = ${curVid}) AND deleted_at IS NULL ORDER BY created_at DESC`
        : threads;
      const activityMessages = includeActivity
        ? await sql`SELECT m.id, m.thread_id, m.author_token_hash, m.author_label, m.body, m.created_at, m.updated_at, m.deleted_at, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ${artifactId} AND (${curVid}::text IS NULL OR t.version_id = ${curVid}) AND t.deleted_at IS NULL ORDER BY m.created_at ASC`
        : messages;

      // Access is already proven (grant or owner); anyone may edit/delete/resolve.
      const hydrateThreads = (threadRows: any[], messageRows: any[]) => {
        const grouped = new Map();
        for (const row of messageRows) {
          const items = grouped.get(row.thread_id) || [];
          const out = {
            ...row,
            can_edit: !row.deleted_at && row.thread_status !== 'resolved',
            can_delete: !row.deleted_at,
          };
          delete out.author_token_hash; // never expose the legacy author token hash
          items.push(out);
          grouped.set(row.thread_id, items);
        }

        return threadRows.map((thread) => {
          const out = {
            ...thread,
            anchor: thread.anchor_json ? JSON.parse(thread.anchor_json) : null,
            can_delete: true,
            can_resolve: true,
            messages: grouped.get(thread.id) || [],
          };
          delete out.created_by_token_hash;
          return out;
        });
      };

      return authJson({
        pagePath,
        viewer: { authenticated: true, label: null },
        threads: hydrateThreads(threads, messages),
        activityThreads: hydrateThreads(activityThreads, activityMessages),
      });
    }

    if (commentListMatch && request.method === 'POST') {
      const artifactId = commentListMatch[1];
      const access = await requireCommentAccess(request, artifactId);
      if (access instanceof Response) return access;

      const reqBody = await request.json().catch(() => null);
      const name = normalizeName(reqBody);
      if (name instanceof Response) return name;
      const normalized = normalizeThreadInput(reqBody);
      if (normalized instanceof Response) return normalized;

      const sql = getSQL();
      const now = Math.floor(Date.now() / 1000);
      const threadId = generateId();
      const messageId = generateId();
      const curVerRow = await sql`SELECT current_version_id AS vid FROM artifacts WHERE id = ${artifactId}`;
      const versionId = curVerRow[0] ? curVerRow[0].vid : null;
      await sql`INSERT INTO comment_threads (id, artifact_id, version_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, created_at, updated_at) VALUES (${threadId}, ${artifactId}, ${versionId}, ${normalized.pagePath}, ${NO_TOKEN}, ${name}, ${normalized.scopeType}, ${normalized.anchorJson}, 'open', ${now}, ${now})`;
      await sql`INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, created_at, updated_at) VALUES (${messageId}, ${threadId}, ${NO_TOKEN}, ${name}, ${normalized.body}, ${now}, ${now})`;
      return authJson({
        id: threadId,
        messageId,
        thread: {
          id: threadId,
          artifact_id: artifactId,
          page_path: normalized.pagePath,
          created_by_label: name,
          scope_type: normalized.scopeType,
          anchor: normalized.anchorJson ? JSON.parse(normalized.anchorJson) : null,
          status: 'open',
          resolved_by_label: null,
          resolved_at: null,
          deleted_at: null,
          created_at: now,
          updated_at: now,
          can_delete: true,
          can_resolve: true,
          messages: [{
            id: messageId,
            thread_id: threadId,
            author_label: name,
            body: normalized.body,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            can_edit: true,
            can_delete: true,
          }],
        },
      }, { status: 201 });
    }

    const threadMessageMatch = url.pathname.match(/^\/comment-threads\/([a-f0-9-]+)\/messages$/);
    if (threadMessageMatch && request.method === 'POST') {
      const threadId = threadMessageMatch[1];

      const sql = getSQL();
      const threadRows = await sql`SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ${threadId}`;
      if (!threadRows[0] || threadRows[0].deleted_at) return new Response('Not found', { status: 404 });
      const access = await requireCommentAccess(request, String(threadRows[0].artifact_id));
      if (access instanceof Response) return access;

      const reqBody = await request.json().catch(() => null);
      const name = normalizeName(reqBody);
      if (name instanceof Response) return name;
      const message = normalizeMessageInput(reqBody);
      if (message instanceof Response) return message;

      const now = Math.floor(Date.now() / 1000);
      const messageId = generateId();
      await sql`INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, created_at, updated_at) VALUES (${messageId}, ${threadId}, ${NO_TOKEN}, ${name}, ${message}, ${now}, ${now})`;
      await sql`UPDATE comment_threads SET updated_at = ${now} WHERE id = ${threadId}`;
      return authJson({
        id: messageId,
        threadId,
        threadUpdatedAt: now,
        message: {
          id: messageId,
          thread_id: threadId,
          author_label: name,
          body: message,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          can_edit: true,
          can_delete: true,
        },
      }, { status: 201 });
    }

    const threadResolveMatch = url.pathname.match(/^\/comment-threads\/([a-f0-9-]+)\/(resolve|reopen)$/);
    if (threadResolveMatch && request.method === 'POST') {
      const threadId = threadResolveMatch[1];
      const action = threadResolveMatch[2];

      const sql = getSQL();
      const threadRows = await sql`SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ${threadId}`;
      if (!threadRows[0] || threadRows[0].deleted_at) return new Response('Not found', { status: 404 });
      const access = await requireCommentAccess(request, String(threadRows[0].artifact_id));
      if (access instanceof Response) return access;

      const rb = await request.json().catch(() => null);
      const resolverName = rb && typeof rb === 'object' && typeof (rb as { name?: unknown }).name === 'string'
        ? (rb as { name: string }).name.trim().slice(0, 80) : '';

      const now = Math.floor(Date.now() / 1000);
      if (action === 'resolve') {
        await sql`UPDATE comment_threads SET status = 'resolved', resolved_by_token_hash = ${NO_TOKEN}, resolved_by_label = ${resolverName}, resolved_at = ${now}, updated_at = ${now} WHERE id = ${threadId}`;
      } else {
        await sql`UPDATE comment_threads SET status = 'open', resolved_by_token_hash = NULL, resolved_by_label = NULL, resolved_at = NULL, updated_at = ${now} WHERE id = ${threadId}`;
      }
      return authJson({
        id: threadId,
        status: action === 'resolve' ? 'resolved' : 'open',
        resolvedByLabel: action === 'resolve' ? (resolverName || null) : null,
        resolvedAt: action === 'resolve' ? now : null,
        updatedAt: now,
      });
    }

    const threadDeleteMatch = url.pathname.match(/^\/comment-threads\/([a-f0-9-]+)$/);
    if (threadDeleteMatch && request.method === 'DELETE') {
      const threadId = threadDeleteMatch[1];

      const sql = getSQL();
      const threadRows = await sql`SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ${threadId}`;
      if (!threadRows[0] || threadRows[0].deleted_at) return new Response('Not found', { status: 404 });
      const access = await requireCommentAccess(request, String(threadRows[0].artifact_id));
      if (access instanceof Response) return access;

      const now = Math.floor(Date.now() / 1000);
      await sql`UPDATE comment_threads SET deleted_at = ${now}, deleted_by_token_hash = ${NO_TOKEN}, updated_at = ${now} WHERE id = ${threadId}`;
      return new Response(null, { status: 204 });
    }

    const messageMatch = url.pathname.match(/^\/comment-messages\/([a-f0-9-]+)$/);
    if (messageMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
      const messageId = messageMatch[1];

      const sql = getSQL();
      const rows = await sql`SELECT m.thread_id, m.author_token_hash, m.deleted_at, t.artifact_id, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE m.id = ${messageId} AND t.deleted_at IS NULL`;
      if (!rows[0] || rows[0].deleted_at) return new Response('Not found', { status: 404 });
      const access = await requireCommentAccess(request, String(rows[0].artifact_id));
      if (access instanceof Response) return access;

      const now = Math.floor(Date.now() / 1000);
      if (request.method === 'PATCH') {
        if (rows[0].thread_status === 'resolved') return new Response('Resolved comments cannot be edited', { status: 409 });
        const message = normalizeMessageInput(await request.json().catch(() => null));
        if (message instanceof Response) return message;
        await sql`UPDATE comment_messages SET body = ${message}, updated_at = ${now} WHERE id = ${messageId}`;
        await sql`UPDATE comment_threads SET updated_at = ${now} WHERE id = ${rows[0].thread_id}`;
        return authJson({ id: messageId, body: message, updatedAt: now, threadUpdatedAt: now });
      }

      await sql`UPDATE comment_messages SET deleted_at = ${now}, deleted_by_token_hash = ${NO_TOKEN}, updated_at = ${now} WHERE id = ${messageId}`;
      await sql`UPDATE comment_threads SET updated_at = ${now} WHERE id = ${rows[0].thread_id}`;
      return new Response(null, { status: 204 });
    }

    // ===== TOKEN MANAGEMENT (admin only) =====
    if (MULTI_TENANT && url.pathname === '/tokens') {
      const sql = getSQL();

      if (request.method === 'GET') {
        const auth = await requireAdmin(request);
        if (auth instanceof Response) return auth;

        const results = await sql`SELECT token_hash, label, created_at, is_admin FROM users ORDER BY created_at DESC`;
        return authJson(results);
      }

      if (request.method === 'POST') {
        const auth = await requireAdmin(request);
        if (auth instanceof Response) return auth;

        const body = await request.json() as { label?: string };
        const label = body.label || 'unnamed';
        const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
        const token = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
        const tokenHash = await sha256(token);

        await sql`INSERT INTO users (token_hash, label, created_at, is_admin) VALUES (${tokenHash}, ${label}, ${Math.floor(Date.now() / 1000)}, 0)`;

        return authJson({ token, label });
      }
    }

    if (MULTI_TENANT && url.pathname.match(/^\/tokens\/[a-f0-9]{64}$/) && request.method === 'DELETE') {
      const auth = await requireAdmin(request);
      if (auth instanceof Response) return auth;

      const tokenHash = url.pathname.split('/')[2];
      const sql = getSQL();
      await sql`DELETE FROM users WHERE token_hash = ${tokenHash} AND is_admin = 0`;

      return authJson({ revoked: tokenHash });
    }

    // ===== SERVE by slug (/s/:slug) =====
    const slugMatch = url.pathname.match(/^\/s\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
    if (slugMatch) {
      const slug = slugMatch[1];
      const sql = getSQL();
      const rows = await sql`SELECT id, expires_at, password_hash FROM artifacts WHERE slug = ${slug}`;

      if (!rows[0]) return new Response('Not found', { status: 404 });

      if (isArtifactExpired(rows[0].expires_at)) {
        return new Response('Link expired', { status: 410 });
      }

      // Serve the entry under a trailing slash so the browser resolves relative assets
      // (./styles.css, ./page.html) against /s/<slug>/ rather than /s/. Bare-slug GETs
      // redirect to the canonical slash form; sub-paths (slugMatch[2] defined) and the
      // password POST pass through untouched.
      if (slugMatch[2] === undefined && (request.method === 'GET' || request.method === 'HEAD')) {
        return new Response(null, { status: 302, headers: { Location: `${url.origin}/s/${slug}/` } });
      }

      if (rows[0].password_hash) {
        const cookieName = `toss_pwd_${slug}`;
        const cookies = request.headers.get('Cookie') || '';
        const hasSession = cookies.includes(`${cookieName}=1`);

        if (!hasSession) {
          if (request.method === 'POST') {
            const formData = await request.formData();
            const password = formData.get('password') as string;
            const providedHash = password ? await sha256(password + rows[0].id) : '';

            if (constantTimeEqual(providedHash, rows[0].password_hash)) {
              // Correct password: redirect with a session cookie scoped to
              // this share's lifetime (capped at 30d for permanent shares).
              const maxAge = artifactCookieMaxAge(rows[0].expires_at);
              return new Response(null, {
                status: 302,
                headers: {
                  Location: `${url.origin}/s/${slug}/`,
                  'Set-Cookie': `${cookieName}=1; Path=/s/${slug}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
                },
              });
            }

            return passwordFormResponse(slug, true, 401);
          }

          return passwordFormResponse(slug, false, 200);
        }
      }

      let filePath = slugMatch[2] || 'index.html';
      if (filePath.endsWith('/')) filePath += 'index.html';

      filePath = filePath.replace(/\\/g, '/');
      const parts = filePath.split('/').filter((p) => p !== '' && p !== '.');
      if (parts.some((p) => p === '..')) {
        return new Response('Invalid path', { status: 400 });
      }
      filePath = parts.join('/');

      return serveArtifact(rows[0], filePath, request, { artifactBasePath: `/s/${slug}/` });
    }

    // ===== SERVE by ID + JWT (/a/:id) =====
    const serveMatch = url.pathname.match(/^\/a\/([a-f0-9-]+)(?:\/(.*))?$/);
    if (serveMatch) {
      const id = serveMatch[1];

      if (!url.pathname.endsWith('/') && serveMatch[2] === undefined) {
        return Response.redirect(`${url.origin}${url.pathname}/?${url.searchParams.toString()}`, 302);
      }

      let token = url.searchParams.get('t');
      if (!token) {
        const cookie = request.headers.get('Cookie');
        if (cookie) {
          const match = cookie.match(/toss_tok=([^;]+)/);
          if (match) token = match[1];
        }
      }
      if (!token) return new Response('Missing token', { status: 401 });

      let verified: { expiresAt: number } | null;
      try {
        const payload = await verifyJWT(token, JWT_SECRET);
        if (payload.sub !== id) return new Response('Invalid token scope', { status: 403 });
        verified = readArtifactJWT(payload);
      } catch {
        return new Response('Invalid token', { status: 401 });
      }
      if (!verified) return new Response('Link expired', { status: 410 });

      let filePath = serveMatch[2] || 'index.html';
      if (filePath.endsWith('/')) filePath += 'index.html';

      filePath = filePath.replace(/\\/g, '/');
      const parts = filePath.split('/').filter((p) => p !== '' && p !== '.');
      if (parts.some((p) => p === '..')) {
        return new Response('Invalid path', { status: 400 });
      }
      filePath = parts.join('/');

      // readArtifactJWT already returned PERMANENT (0) for permanent tokens,
      // so meta.expires_at carries the canonical sentinel into serveArtifact.
      const meta: ArtifactMeta = { id, expires_at: verified.expiresAt };
      return serveArtifact(meta, filePath, request, { artifactBasePath: `/a/${id}/` });
    }

    // ===== Root (/) — branded splash; no instance data leaked. (/health is the machine endpoint.)
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(instancePage(url.origin, MULTI_TENANT), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      });
    }

    return new Response('Not found', { status: 404 });
  } catch (err) {
    console.error('Handler error:', err);
    return new Response('Internal server error', { status: 500 });
  }
}
// force rebuild 1777314833
