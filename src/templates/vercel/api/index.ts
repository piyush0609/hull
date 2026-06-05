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
async function requireCommentAccess(request: Request, artifactId: string): Promise<true | Response> {
  const sql = getSQL();
  const rows = await sql`SELECT comments_enabled, expires_at, password_epoch FROM artifacts WHERE id = ${artifactId}`;
  const row = rows[0];
  // A null row also covers a missing/revoked artifact.
  if (!row || !row.comments_enabled) return new Response('Not found', { status: 404 });
  if (isArtifactExpired(row.expires_at)) return new Response('Link expired', { status: 410 });

  // Owner token is a first-class reader/writer (programmatic/cloud access).
  const user = await resolveUser(request);
  if (user?.isAdmin) return true;

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
  const storageKey = 'toss-comment-name';
  const state = { token: localStorage.getItem(storageKey) || '', threads: [], activeThreadId: '', pendingScope: 'artifact', pendingAnchor: null, pendingRects: [], currentLabel: '', busy: false, loaded: false, loading: false };
  const currentPagePath = cfg.currentPagePath || 'index.html';
  const esc = (text) => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const root = document.getElementById('toss-comments-root');
  root.innerHTML = '<style>#toss-comments-root{position:fixed;top:0;right:0;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;color:#111827}#toss-comments-root *{box-sizing:border-box}.toss-comments-shell{display:flex;align-items:flex-start;gap:0}.toss-comments-toggle{margin:12px 0 0 auto;background:#111827;color:#fff;border:none;border-radius:999px 0 0 999px;padding:10px 14px;cursor:pointer;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.18)}.toss-comments-panel{width:360px;max-width:calc(100vw - 24px);height:100vh;background:#fff;border-left:1px solid #e5e7eb;box-shadow:-12px 0 32px rgba(15,23,42,.12);display:none;flex-direction:column}.toss-comments-panel.open{display:flex}.toss-comments-header{padding:16px;border-bottom:1px solid #e5e7eb;background:#f8fafc;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.toss-comments-header-copy{min-width:0}.toss-comments-close{border:none;background:#e2e8f0;color:#0f172a;border-radius:999px;padding:8px 10px;font-size:12px;font-weight:700;cursor:pointer}.toss-comments-title{font-weight:700;font-size:16px;margin:0 0 4px}.toss-comments-sub{font-size:12px;color:#64748b}.toss-comments-body{padding:16px;overflow:auto;display:flex;flex-direction:column;gap:12px}.toss-comments-card{border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#fff}.toss-comments-card.resolved{background:#f8fafc}.toss-comments-card.focused{border-color:#0f172a;box-shadow:0 0 0 3px rgba(15,23,42,.12)}.toss-comments-meta,.toss-comments-message-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;margin-bottom:8px}.toss-comments-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.toss-comments-actions button,.toss-comments-auth button,.toss-comments-context button{background:#fff;border:1px solid #d1d5db;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer}.toss-comments-actions button.primary{background:#111827;color:#fff;border-color:#111827}.toss-comments-actions button.warn{color:#b91c1c;border-color:#fecaca;background:#fff5f5}.toss-comments-auth input,.toss-comments-textarea{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:13px;background:#fff}.toss-comments-textarea{min-height:92px;resize:vertical}.toss-comments-auth{display:flex;gap:8px;flex-wrap:wrap}.toss-comments-auth input{flex:1 1 180px}.toss-comments-status{font-size:12px;color:#475569;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:10px}.toss-comments-context{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid #dbe4f0;border-radius:10px;background:#fff;font-size:12px;color:#334155}.toss-comments-context strong{display:block;color:#0f172a;font-size:12px}.toss-comments-context span{display:block;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}.toss-comments-thread-list{display:flex;flex-direction:column;gap:12px}.toss-comment-draft-highlight{position:absolute;z-index:2147483645;background:rgba(250,204,21,.35);outline:1px solid rgba(202,138,4,.8);border-radius:4px;pointer-events:none}.toss-comment-focus-highlight{position:absolute;z-index:2147483644;background:rgba(59,130,246,.16);outline:2px solid rgba(37,99,235,.8);border-radius:6px;pointer-events:none}.toss-comment-pin{position:absolute;z-index:2147483646;width:18px;height:18px;border-radius:999px;background:#111827;color:#fff;border:2px solid #fff;box-shadow:0 8px 24px rgba(15,23,42,.25);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer}.toss-comment-pin.active{background:#2563eb}.toss-comment-chip{position:absolute;z-index:2147483647;border:none;border-radius:999px;background:#111827;color:#fff;padding:8px 12px;font-size:12px;font-weight:600;box-shadow:0 10px 30px rgba(15,23,42,.28);cursor:pointer}.toss-comments-thread-anchor{font-size:12px;color:#475569;background:#f8fafc;border-radius:8px;padding:8px;margin-bottom:8px}.toss-comments-message{padding:8px 0;border-top:1px solid #f1f5f9}.toss-comments-message:first-child{border-top:none;padding-top:0}.toss-comments-empty{font-size:13px;color:#64748b}</style><div class="toss-comments-shell"><button class="toss-comments-toggle" type="button">Comments</button><aside class="toss-comments-panel" aria-label="Comments sidebar"><div class="toss-comments-header"><div class="toss-comments-header-copy"><div class="toss-comments-title">Comments</div><div class="toss-comments-sub">Discuss this shared page</div></div><button class="toss-comments-close" type="button" aria-label="Close comments">Close</button></div><div class="toss-comments-body"><div class="toss-comments-auth"><input class="toss-comments-token" placeholder="Your name (shown on your comments)" maxlength="80" /><button class="toss-comments-save-token primary" type="button">Save name</button><button class="toss-comments-clear-token" type="button">Clear</button></div><div class="toss-comments-status"></div><div class="toss-comments-context"><div><strong>Comment target</strong><span class="toss-comments-context-label">Whole page</span></div><button class="toss-comments-context-clear" type="button">Use whole page</button></div><textarea class="toss-comments-textarea" placeholder="Write a comment..."></textarea><button class="toss-comments-submit primary" type="button">Post Comment</button><div class="toss-comments-thread-list"></div></div></aside></div>';
  const panel = root.querySelector('.toss-comments-panel'); const tokenInput = root.querySelector('.toss-comments-token'); const textarea = root.querySelector('.toss-comments-textarea'); const submitButton = root.querySelector('.toss-comments-submit'); const list = root.querySelector('.toss-comments-thread-list'); const status = root.querySelector('.toss-comments-status'); const contextLabel = root.querySelector('.toss-comments-context-label'); tokenInput.value = state.token;
  const selectorFor = (el) => { if (!(el instanceof Element)) return 'unknown'; const parts = []; let node = el; while (node && node.nodeType === 1 && node !== document.body) { if (node.id) { parts.unshift('#' + node.id); break; } const parent = node.parentElement; let part = node.tagName.toLowerCase(); if (parent) { const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName); if (sameTagSiblings.length > 1) { const index = sameTagSiblings.indexOf(node) + 1; part += ':nth-of-type(' + index + ')'; } } parts.unshift(part); node = parent; } return parts.join(' > ') || 'unknown'; };
  const selectionRectFromAnchor = (anchor) => { if (!anchor || !anchor.selector || !anchor.selectedText) return null; const host = document.querySelector(anchor.selector); if (!(host instanceof Element)) return null; const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT); const textNodes = []; let node; let fullText = ''; while ((node = walker.nextNode())) { const text = node.textContent || ''; if (!text) continue; textNodes.push({ node, start: fullText.length, end: fullText.length + text.length }); fullText += text; } if (!fullText) return null; const selectedText = String(anchor.selectedText); let startIndex = fullText.indexOf(selectedText); if (startIndex < 0 && anchor.textSnippet) startIndex = fullText.indexOf(String(anchor.textSnippet)); if (startIndex < 0) return null; const endIndex = startIndex + selectedText.length; const startNodeMeta = textNodes.find((item) => startIndex >= item.start && startIndex <= item.end); const endNodeMeta = textNodes.find((item) => endIndex >= item.start && endIndex <= item.end) || textNodes[textNodes.length - 1]; if (!startNodeMeta || !endNodeMeta) return null; const range = document.createRange(); range.setStart(startNodeMeta.node, Math.max(0, startIndex - startNodeMeta.start)); range.setEnd(endNodeMeta.node, Math.max(0, Math.min((endNodeMeta.node.textContent || '').length, endIndex - endNodeMeta.start))); const rect = range.getBoundingClientRect(); if (!rect || (!rect.width && !rect.height)) return null; return { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) }; };
  const rectFromAnchor = (anchor) => { if (!anchor) return null; if (anchor.selectedText) { const selectionRect = selectionRectFromAnchor(anchor); if (selectionRect) return selectionRect; } if (anchor.selector) { const node = document.querySelector(anchor.selector); if (node instanceof Element) { const rect = node.getBoundingClientRect(); return { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) }; } } return anchor.rect || null; };
  const setStatus = (message) => { status.textContent = message; };
  const clearDraftHighlight = () => { document.querySelectorAll('.toss-comment-draft-highlight').forEach((node) => node.remove()); };
  const clearFocusHighlight = () => { document.querySelectorAll('.toss-comment-focus-highlight').forEach((node) => node.remove()); };
  const clearDraftChip = () => { document.querySelectorAll('.toss-comment-chip').forEach((node) => node.remove()); };
  const renderDraftHighlight = () => { clearDraftHighlight(); state.pendingRects.forEach((rect) => { const marker = document.createElement('div'); marker.className = 'toss-comment-draft-highlight'; marker.style.left = rect.x + 'px'; marker.style.top = rect.y + 'px'; marker.style.width = Math.max(rect.width, 8) + 'px'; marker.style.height = Math.max(rect.height, 16) + 'px'; document.body.appendChild(marker); }); };
  const renderDraftChip = () => { clearDraftChip(); if (state.pendingScope !== 'selection' || !state.pendingRects.length) return; const firstRect = state.pendingRects[0]; const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'toss-comment-chip'; chip.textContent = 'Comment'; chip.style.left = firstRect.x + 'px'; chip.style.top = Math.max(firstRect.y - 40, 12) + 'px'; chip.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); openPanelForComment(); setStatus('Selection captured. Add your comment.'); setTimeout(() => textarea.focus(), 0); }); document.body.appendChild(chip); };
  const renderFocusHighlight = () => { clearFocusHighlight(); if (!state.activeThreadId) return; const thread = state.threads.find((item) => item.id === state.activeThreadId); if (!thread || !thread.anchor) return; const rect = rectFromAnchor(thread.anchor); if (!rect) return; const marker = document.createElement('div'); marker.className = 'toss-comment-focus-highlight'; marker.style.left = (rect.x || 0) + 'px'; marker.style.top = (rect.y || 0) + 'px'; marker.style.width = Math.max(rect.width || 0, 8) + 'px'; marker.style.height = Math.max(rect.height || 0, 16) + 'px'; document.body.appendChild(marker); };
  const activateThread = (threadId) => { state.activeThreadId = threadId; render(); renderFocusHighlight(); const node = root.querySelector('[data-thread-id="' + threadId + '"]'); if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  const updateContext = () => { if (state.pendingScope === 'selection' && state.pendingAnchor) { contextLabel.textContent = 'Selected text: ' + (state.pendingAnchor.selectedText || state.pendingAnchor.textSnippet || 'Selection'); return; } contextLabel.textContent = 'Whole page'; };
  const resetPendingAnchor = () => { state.pendingScope = 'artifact'; state.pendingAnchor = null; state.pendingRects = []; clearDraftHighlight(); clearDraftChip(); updateContext(); };
  const setBusy = (busy) => { state.busy = busy; tokenInput.disabled = busy; textarea.disabled = busy; submitButton.disabled = busy; root.querySelectorAll('button').forEach((button) => { if (button.classList.contains('toss-comments-toggle')) return; button.disabled = busy; }); };
  const tempId = (prefix) => prefix + '-' + Math.random().toString(36).slice(2, 10);
  const scrollThreadIntoView = (threadId) => { const node = root.querySelector('[data-thread-id="' + threadId + '"]'); if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  const authHeaders = (needsAuth) => { const headers = { 'X-Toss-Viewer': cfg.viewerToken }; if (state.token) headers.Authorization = 'Bearer ' + state.token; if (needsAuth) headers['Content-Type'] = 'application/json'; return headers; };
  const api = async (path, init = {}, needsAuth = false) => { const res = await fetch(cfg.origin + path, { ...init, headers: { ...(init.headers || {}), ...authHeaders(needsAuth) } }); if (res.status === 204) return null; const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text ? { error: text } : null; } if (!res.ok) throw new Error((data && data.error) || text || ('Request failed: ' + res.status)); return data; };
  const anchorLabel = (thread) => { if (thread.scope_type === 'artifact') return 'General page comment'; const anchor = thread.anchor || {}; if (thread.scope_type === 'selection') return 'Selection: ' + (anchor.selectedText || anchor.textSnippet || 'Selected text'); return 'Element: ' + (anchor.selector || anchor.textSnippet || 'Selected element'); };
  const normalizeMessage = (message) => ({ ...message, can_edit: !!message.can_edit, can_delete: !!message.can_delete });
  const normalizeThread = (thread) => ({ ...thread, anchor: thread.anchor || null, can_delete: !!thread.can_delete, can_resolve: !!thread.can_resolve, messages: (thread.messages || []).map(normalizeMessage) });
  const upsertThread = (thread, options = {}) => { const normalized = normalizeThread(thread); const existingIndex = state.threads.findIndex((item) => item.id === normalized.id); if (existingIndex >= 0) { state.threads.splice(existingIndex, 1, normalized); return; } if (options.prepend) { state.threads.unshift(normalized); return; } state.threads.push(normalized); };
  const removeThread = (threadId) => { state.threads = state.threads.filter((thread) => thread.id !== threadId); };
  const updateThread = (threadId, updater) => { state.threads = state.threads.map((thread) => thread.id === threadId ? updater(thread) : thread); };
  const renderPins = () => { document.querySelectorAll('.toss-comment-pin').forEach((node) => node.remove()); state.threads.forEach((thread, index) => { if (thread.deleted_at || thread.scope_type === 'artifact' || !thread.anchor) return; const rect = rectFromAnchor(thread.anchor); if (!rect) return; const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'toss-comment-pin' + (thread.id === state.activeThreadId ? ' active' : ''); pin.textContent = String(index + 1); pin.style.left = (rect.x || 0) + 'px'; pin.style.top = (rect.y || 0) + 'px'; pin.title = anchorLabel(thread); pin.addEventListener('click', () => { panel.classList.add('open'); ensureThreadsLoaded(); activateThread(thread.id); }); document.body.appendChild(pin); }); };
  const render = () => { list.innerHTML = ''; if (!state.threads.length) { list.innerHTML = '<div class=\"toss-comments-empty\">No comments yet.</div>'; renderPins(); clearFocusHighlight(); return; } state.threads.forEach((thread) => { const article = document.createElement('article'); article.className = 'toss-comments-card' + (thread.status === 'resolved' ? ' resolved' : ''); if (thread.id === state.activeThreadId) article.className += ' focused'; article.dataset.threadId = thread.id; const meta = document.createElement('div'); meta.className = 'toss-comments-meta'; meta.innerHTML = '<span>' + esc(thread.created_by_label) + '</span><span>' + esc(thread.status) + '</span>'; article.appendChild(meta); const anchor = document.createElement('div'); anchor.className = 'toss-comments-thread-anchor'; anchor.textContent = anchorLabel(thread); article.appendChild(anchor); (thread.messages || []).forEach((message) => { const box = document.createElement('div'); box.className = 'toss-comments-message'; box.innerHTML = '<div class=\"toss-comments-message-meta\"><span>' + esc(message.author_label) + '</span><span>' + new Date(message.updated_at * 1000).toLocaleString() + (message.deleted_at ? ' · deleted' : (message.updated_at !== message.created_at ? ' · edited' : '')) + '</span></div><div>' + esc(message.deleted_at ? 'Message deleted' : message.body) + '</div>'; if (!message.deleted_at && (message.can_edit || message.can_delete)) { const actions = document.createElement('div'); actions.className = 'toss-comments-actions'; if (message.can_edit) { const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.dataset.action = 'edit-message'; edit.dataset.messageId = message.id; edit.dataset.body = message.body; actions.appendChild(edit); } if (message.can_delete) { const del = document.createElement('button'); del.type = 'button'; del.textContent = 'Delete'; del.className = 'warn'; del.dataset.action = 'delete-message'; del.dataset.messageId = message.id; actions.appendChild(del); } box.appendChild(actions); } article.appendChild(box); }); const actions = document.createElement('div'); actions.className = 'toss-comments-actions'; actions.innerHTML = '<button type=\"button\" data-action=\"reply-thread\" data-thread-id=\"' + thread.id + '\">Reply</button>'; if (thread.can_resolve && thread.status !== 'resolved') actions.innerHTML += '<button type=\"button\" class=\"primary\" data-action=\"resolve-thread\" data-thread-id=\"' + thread.id + '\">Resolve</button>'; if (thread.can_resolve && thread.status === 'resolved') actions.innerHTML += '<button type=\"button\" data-action=\"reopen-thread\" data-thread-id=\"' + thread.id + '\">Reopen</button>'; if (thread.can_delete) actions.innerHTML += '<button type=\"button\" class=\"warn\" data-action=\"delete-thread\" data-thread-id=\"' + thread.id + '\">Delete Thread</button>'; article.appendChild(actions); article.addEventListener('click', () => { state.activeThreadId = thread.id; render(); renderFocusHighlight(); }); list.appendChild(article); }); renderPins(); renderFocusHighlight(); };
  const loadThreads = async () => { state.loading = true; try { const data = await api('/artifacts/' + cfg.artifactId + '/comment-threads?pagePath=' + encodeURIComponent(currentPagePath) + '&includeActivity=1'); state.threads = (data.threads || []).map(normalizeThread); state.currentLabel = ''; state.loaded = true; setStatus(state.token ? ('Commenting as ' + state.token) : 'Enter your name above, then comment.'); render(); } catch (error) { setStatus(error.message || 'Failed to load comments.'); } finally { state.loading = false; } };
  const ensureThreadsLoaded = async (force = false) => { if (state.loading) return; if (!force && state.loaded) return; await loadThreads(); };
  const openPanelForComment = () => { panel.classList.add('open'); ensureThreadsLoaded(); };
  const captureSelectionAnchor = (options = {}) => { const openPanel = !!options.openPanel; const silent = !!options.silent; const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.toString().trim()) { if (!silent) setStatus('Select some text on the page first.'); return false; } const range = selection.getRangeAt(0); const rect = range.getBoundingClientRect(); const rects = Array.from(range.getClientRects()).map((clientRect) => ({ x: Math.round(clientRect.left + window.scrollX), y: Math.round(clientRect.top + window.scrollY), width: Math.round(clientRect.width), height: Math.round(clientRect.height) })).filter((clientRect) => clientRect.width > 0 && clientRect.height > 0); const selectedText = selection.toString().trim(); state.pendingScope = 'selection'; state.pendingAnchor = { selector: selectorFor(range.startContainer && range.startContainer.parentElement), selectedText, textSnippet: selectedText.slice(0, 240), rect: { x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) }, startOffset: range.startOffset, endOffset: range.endOffset }; state.pendingRects = rects.length ? rects : [{ x: Math.round(rect.left + window.scrollX), y: Math.round(rect.top + window.scrollY), width: Math.round(rect.width), height: Math.round(rect.height) }]; renderDraftHighlight(); renderDraftChip(); updateContext(); setStatus('Selection captured. Add your comment.'); if (openPanel) openPanelForComment(); return true; };
  document.addEventListener('mouseup', (event) => { const target = event.target; if (target instanceof Node && root.contains(target)) return; captureSelectionAnchor({ openPanel: false, silent: true }); });
  document.addEventListener('keydown', (event) => { if (event.key !== 'Escape') return; const selection = window.getSelection(); if (selection) selection.removeAllRanges(); if (state.pendingScope === 'selection' || state.pendingRects.length) { resetPendingAnchor(); setStatus('Selection cleared.'); } });
  root.addEventListener('click', async (event) => { const target = event.target; if (!(target instanceof HTMLElement)) return; const action = target.dataset.action; if (state.busy && !target.classList.contains('toss-comments-toggle')) return; if (target.classList.contains('toss-comments-toggle') || target.classList.contains('toss-comments-close')) { panel.classList.toggle('open'); if (panel.classList.contains('open')) ensureThreadsLoaded(); else { resetPendingAnchor(); state.activeThreadId = ''; clearFocusHighlight(); setStatus('Comments closed.'); } return; } if (target.classList.contains('toss-comments-save-token')) { state.token = tokenInput.value.trim(); if (state.token) localStorage.setItem(storageKey, state.token); setStatus('Name saved.'); setBusy(true); try { await ensureThreadsLoaded(true); } finally { setBusy(false); } return; } if (target.classList.contains('toss-comments-clear-token')) { state.token = ''; tokenInput.value = ''; localStorage.removeItem(storageKey); setStatus('Name cleared.'); setBusy(true); try { await ensureThreadsLoaded(true); } finally { setBusy(false); } return; } if (target.classList.contains('toss-comments-context-clear')) { resetPendingAnchor(); setStatus('Comment will be posted on the whole page.'); return; } if (target.classList.contains('toss-comments-submit')) { if (!state.token) { setStatus('Enter your name first (top of the panel).'); return; } const body = textarea.value.trim(); if (!body) { setStatus('Write a comment first.'); return; } const draft = textarea.value; textarea.value = ''; captureSelectionAnchor({ silent: true }); const optimisticThreadId = tempId('thread'); const optimisticMessageId = tempId('message'); const now = Math.floor(Date.now() / 1000); upsertThread({ id: optimisticThreadId, artifact_id: cfg.artifactId, created_by_label: state.token || 'You', scope_type: state.pendingScope, anchor: state.pendingScope === 'artifact' ? null : state.pendingAnchor, status: 'open', resolved_by_label: null, resolved_at: null, deleted_at: null, created_at: now, updated_at: now, can_delete: true, can_resolve: true, messages: [{ id: optimisticMessageId, thread_id: optimisticThreadId, author_label: state.token || 'You', body, created_at: now, updated_at: now, deleted_at: null, can_edit: true, can_delete: true }] }, { prepend: true }); render(); scrollThreadIntoView(optimisticThreadId); try { const data = await api('/artifacts/' + cfg.artifactId + '/comment-threads', { method: 'POST', body: JSON.stringify({ name: state.token, body, pagePath: currentPagePath, scopeType: state.pendingScope, anchor: state.pendingScope === 'artifact' ? undefined : state.pendingAnchor }) }, true); if (data && data.thread) { removeThread(optimisticThreadId); upsertThread(data.thread, { prepend: true }); render(); } resetPendingAnchor(); setStatus('Comment posted.'); } catch (error) { removeThread(optimisticThreadId); render(); textarea.value = draft; setStatus(error.message || 'Failed to post comment.'); } return; } if (!action) return; if (!state.token) { setStatus('Enter your name first (top of the panel).'); return; } try { if (action === 'reply-thread') { const body = window.prompt('Reply'); if (!body) return; const threadId = target.dataset.threadId; const optimisticMessageId = tempId('reply'); const now = Math.floor(Date.now() / 1000); updateThread(threadId, (thread) => ({ ...thread, updated_at: now, messages: [...(thread.messages || []), normalizeMessage({ id: optimisticMessageId, thread_id: threadId, author_label: state.token || 'You', body, created_at: now, updated_at: now, deleted_at: null, can_edit: true, can_delete: true })] })); render(); scrollThreadIntoView(threadId); const data = await api('/comment-threads/' + target.dataset.threadId + '/messages', { method: 'POST', body: JSON.stringify({ name: state.token, body }) }, true); if (data && data.message) { updateThread(threadId, (thread) => ({ ...thread, updated_at: data.threadUpdatedAt || thread.updated_at, messages: (thread.messages || []).map((message) => message.id === optimisticMessageId ? normalizeMessage(data.message) : message) })); } } else if (action === 'resolve-thread') { updateThread(target.dataset.threadId, (thread) => ({ ...thread, status: 'resolved', resolved_by_label: state.token || 'You', resolved_at: Math.floor(Date.now() / 1000), messages: (thread.messages || []).map((message) => ({ ...message, can_edit: false })) })); render(); const data = await api('/comment-threads/' + target.dataset.threadId + '/resolve', { method: 'POST', body: JSON.stringify({ name: state.token }) }, true); updateThread(target.dataset.threadId, (thread) => ({ ...thread, status: data.status, resolved_by_label: data.resolvedByLabel, resolved_at: data.resolvedAt, updated_at: data.updatedAt || thread.updated_at, messages: (thread.messages || []).map((message) => ({ ...message, can_edit: false })) })); } else if (action === 'reopen-thread') { updateThread(target.dataset.threadId, (thread) => ({ ...thread, status: 'open', resolved_by_label: null, resolved_at: null, messages: (thread.messages || []).map((message) => ({ ...message, can_edit: !message.deleted_at && message.author_label === (state.token || 'You') })) })); render(); const data = await api('/comment-threads/' + target.dataset.threadId + '/reopen', { method: 'POST' }, true); updateThread(target.dataset.threadId, (thread) => ({ ...thread, status: data.status, resolved_by_label: null, resolved_at: null, updated_at: data.updatedAt || thread.updated_at, messages: (thread.messages || []).map((message) => ({ ...message, can_edit: !message.deleted_at && message.author_label === (state.token || 'You') })) })); } else if (action === 'delete-thread') { if (!window.confirm('Delete this thread?')) return; if (state.activeThreadId === target.dataset.threadId) { state.activeThreadId = ''; clearFocusHighlight(); } removeThread(target.dataset.threadId); render(); await api('/comment-threads/' + target.dataset.threadId, { method: 'DELETE' }, true); } else if (action === 'edit-message') { const nextBody = window.prompt('Edit comment', target.dataset.body || ''); if (!nextBody) return; const threadNode = target.closest('[data-thread-id]'); const threadId = threadNode ? threadNode.dataset.threadId : ''; updateThread(threadId, (thread) => ({ ...thread, messages: (thread.messages || []).map((message) => message.id === target.dataset.messageId ? { ...message, body: nextBody, updated_at: Math.floor(Date.now() / 1000) } : message) })); render(); const data = await api('/comment-messages/' + target.dataset.messageId, { method: 'PATCH', body: JSON.stringify({ body: nextBody }) }, true); updateThread(threadId, (thread) => ({ ...thread, updated_at: data.threadUpdatedAt || thread.updated_at, messages: (thread.messages || []).map((message) => message.id === target.dataset.messageId ? { ...message, body: data.body, updated_at: data.updatedAt || message.updated_at } : message) })); } else if (action === 'delete-message') { if (!window.confirm('Delete this comment?')) return; const threadNode = target.closest('[data-thread-id]'); const threadId = threadNode ? threadNode.dataset.threadId : ''; updateThread(threadId, (thread) => ({ ...thread, messages: (thread.messages || []).map((message) => message.id === target.dataset.messageId ? { ...message, deleted_at: Math.floor(Date.now() / 1000), body: '' } : message) })); render(); await api('/comment-messages/' + target.dataset.messageId, { method: 'DELETE' }, true); } render(); } catch (error) { setStatus(error.message || 'Action failed.'); } });
  updateContext(); setStatus('Select text on the page to anchor a comment, or write to comment on the whole page.');
})();
</script>`;
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
    headers['Cache-Control'] = 'public, max-age=86400, immutable';
    return new Response(stream, { status: 200, headers });
  }
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
            return new Response('Slug already taken by another tenant', { status: 409 });
          }
          const existingId = existing[0].id;
          // Password salt is the artifact id, which is preserved on update.
          const passwordParam = url.searchParams.get('password');
          const newPasswordHash = passwordParam ? await sha256(passwordParam + existingId) : null;
          const newExpiresAt = expiresSeconds === 0 ? 0 : (now + expiresSeconds);
          await blobPut(`artifacts/${existingId}/files/index.html`, html, 'text/html');
          await sql`UPDATE artifacts SET name = ${name}, size_bytes = ${html.length}, expires_at = ${newExpiresAt}, password_hash = ${newPasswordHash} WHERE id = ${existingId}`;
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
      await sql`INSERT INTO artifacts (id, slug, name, size_bytes, created_at, expires_at, token_hash, password_hash, comments_enabled) VALUES (${id}, ${slug}, ${name}, ${html.length}, ${now}, ${expiresAt}, ${auth.tokenHash}, ${passwordHash}, ${commentsEnabled})`;

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

    const commentListMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/comment-threads$/);
    if (commentListMatch && request.method === 'GET') {
      const artifactId = commentListMatch[1];
      const access = await requireCommentAccess(request, artifactId);
      if (access instanceof Response) return access;
      const pagePath = normalizePagePath(url.searchParams.get('pagePath') || 'index.html');
      if (pagePath instanceof Response) return pagePath;
      const includeActivity = url.searchParams.get('includeActivity') === '1';

      const sql = getSQL();
      const threads = await sql`SELECT id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_label, resolved_at, deleted_at, created_at, updated_at FROM comment_threads WHERE artifact_id = ${artifactId} AND page_path = ${pagePath} AND deleted_at IS NULL ORDER BY created_at DESC`;
      const messages = await sql`SELECT m.id, m.thread_id, m.author_token_hash, m.author_label, m.body, m.created_at, m.updated_at, m.deleted_at, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ${artifactId} AND t.page_path = ${pagePath} AND t.deleted_at IS NULL ORDER BY m.created_at ASC`;
      const activityThreads = includeActivity
        ? await sql`SELECT id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_label, resolved_at, deleted_at, created_at, updated_at FROM comment_threads WHERE artifact_id = ${artifactId} AND deleted_at IS NULL ORDER BY created_at DESC`
        : threads;
      const activityMessages = includeActivity
        ? await sql`SELECT m.id, m.thread_id, m.author_token_hash, m.author_label, m.body, m.created_at, m.updated_at, m.deleted_at, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ${artifactId} AND t.deleted_at IS NULL ORDER BY m.created_at ASC`
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
      await sql`INSERT INTO comment_threads (id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, created_at, updated_at) VALUES (${threadId}, ${artifactId}, ${normalized.pagePath}, ${NO_TOKEN}, ${name}, ${normalized.scopeType}, ${normalized.anchorJson}, 'open', ${now}, ${now})`;
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

            return new Response(passwordForm(slug, true), {
              status: 401,
              headers: { 'Content-Type': 'text/html' },
            });
          }

          return new Response(passwordForm(slug, false), {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
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

    // ===== Root (/)
    if (url.pathname === '/' || url.pathname === '') {
      const isMulti = MULTI_TENANT;
      let artifactCount = 0;
      try {
        const sql = getSQL();
        const countRows = await sql`SELECT COUNT(*)::int as c FROM artifacts`;
        artifactCount = countRows[0]?.c || 0;
      } catch {}

      let userCount = 0;
      if (isMulti) {
        try {
          const userRows = await sql`SELECT COUNT(*)::int as c FROM users`;
          userCount = userRows[0]?.c || 0;
        } catch {}
      }

      return new Response(JSON.stringify({
        ok: true,
        backend: 'vercel',
        mode: isMulti ? 'multi-tenant' : 'single-user',
        artifacts: artifactCount,
        users: isMulti ? userCount : undefined,
        version: '0.1.0',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  } catch (err) {
    console.error('Handler error:', err);
    return new Response('Internal server error', { status: 500 });
  }
}
// force rebuild 1777314833
