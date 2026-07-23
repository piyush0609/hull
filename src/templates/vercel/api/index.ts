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
  let payload: string, sigData: string, header: string;
  try {
    header = b64urlDecode(h);
    payload = b64urlDecode(b);
    sigData = b64urlDecode(s);
  } catch { throw new Error('Invalid token format'); }
  // Pin the algorithm: we only ever issue HS256. Asserting it here rejects any
  // token whose header claims a different alg (e.g. "none" or "HS512"), so the
  // verifier can never be tricked into skipping or mismatching the HMAC check.
  try {
    if ((JSON.parse(header) as { alg?: string }).alg !== 'HS256') {
      throw new Error('Unexpected token algorithm');
    }
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

// --- Password-session primitives ---
// A password-session cookie replaces the legacy forgeable `toss_pwd_<slug>=1`
// value with a signed JWT. Sessions live at most 24h and never past the
// artifact's own expiry; pwd_epoch ties them to the current password so a
// re-share invalidates outstanding sessions.
const PASSWORD_SESSION_MAX_AGE = 24 * 3600;

// Cap the session lifetime like issueCommentGrant. Returns exp given a fixed now.
function passwordSessionExp(expiresAt: number, now: number): number {
  const cap = now + PASSWORD_SESSION_MAX_AGE;
  return expiresAt === PERMANENT ? cap : Math.min(cap, expiresAt);
}

// Issue the signed session token AND the matching cookie Max-Age from ONE now/exp
// pair, so token exp and cookie lifetime can never diverge across a second tick.
async function issuePasswordSession(
  artifactId: string, expiresAt: number, secret: string, epoch: number,
): Promise<{ token: string; maxAge: number }> {
  const now = nowSeconds();
  const exp = passwordSessionExp(expiresAt, now);
  const token = await signJWT({ sub: artifactId, aud: 'password-session', pwd_epoch: epoch, iat: now, exp }, secret);
  return { token, maxAge: Math.max(0, exp - now) };
}

// Exact-name cookie parse. Split on ';', trim each segment, exact-key compare.
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const raw of header.split(';')) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

// Strict claim check against the current DB row.
function isSafeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}
async function verifyPasswordSession(
  token: string, artifactId: string, epoch: number, secret: string,
): Promise<boolean> {
  try {
    const payload = await verifyJWT(token, secret);
    if (payload.aud !== 'password-session') return false;
    if (payload.sub !== artifactId) return false;
    if (!isSafeInt(payload.iat)) return false;
    if (!isSafeInt(payload.exp) || payload.exp <= nowSeconds()) return false; // reject exp === now
    if (!isSafeInt(payload.pwd_epoch) || payload.pwd_epoch !== epoch) return false; // exact equality, no ||0
    return true;
  } catch {
    return false;
  }
}
// Exported for tests: assert a session token's validity against a specific epoch,
// and mint one, without going through the full HTTP route.
export { verifyPasswordSession as verifyPasswordSessionForTests, issuePasswordSession as issuePasswordSessionForTests };

// A signing key shorter than 32 UTF-8 bytes is too weak to trust; protected
// shares fail closed with a 500 rather than issuing a forgeable session.
function passwordSessionSecretUsable(secret: string | undefined): boolean {
  return !!secret && new TextEncoder().encode(secret).byteLength >= 32;
}

// --- Config from env ---
const JWT_SECRET = process.env.JWT_SECRET || '';
const OWNER_TOKEN = (process.env.OWNER_TOKEN || '').trim();
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || '';

// --- Neon client ---
let sqlOverride: any = null;
export function setVercelSqlForTests(sql: any): void { sqlOverride = sql; }
function getSQL() {
  if (sqlOverride) return sqlOverride;
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

function versionEntryBlobPath(artifactId: string, versionId: string): string {
  return `artifacts/${artifactId}/versions/${versionId}/index.html`;
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
  const token = auth.slice(7).trim();
  if (!token) return null;
  const tokenHash = await sha256(token);

  if (OWNER_TOKEN) {
    const adminHash = await sha256(OWNER_TOKEN);
    if (constantTimeEqual(tokenHash, adminHash)) {
      return { tokenHash, isAdmin: true, label: 'admin' };
    }
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
    if (!u) return authJson({ error: 'unauthorized', message: 'Owner authentication is required.' }, { status: 401 });
    if (!u.isAdmin) return authJson({ error: 'forbidden', message: 'Owner access is required.' }, { status: 403 });
    return u;
  });
}

// --- Reserved slugs (route namespace) ---
// Caller-supplied --id values matching any of these are rejected so they
// can't shadow built-in routes.
const RESERVED_SLUGS = new Set([
  's', 'a', 'tokens', 'artifacts', 'comment-labels', 'health', 'api', 'status',
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
// Text responses must declare charset=utf-8. Without it the browser applies a locale
// default (windows-1252 for en) and decodes UTF-8 bytes as mojibake; for a <script src>
// the default is the *referencing document's* encoding, so a UTF-8 asset under a
// charset-less page breaks too. Everything toss ingests is UTF-8 end to end.
// application/json is excluded deliberately: RFC 8259 defines no charset parameter
// (JSON is always UTF-8). Binary types are unaffected.
function mimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    jsx: 'application/javascript; charset=utf-8',
    ts: 'application/typescript; charset=utf-8',
    tsx: 'application/typescript; charset=utf-8',
    css: 'text/css; charset=utf-8', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml; charset=utf-8', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
    pdf: 'application/pdf', md: 'text/markdown; charset=utf-8',
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
      'Content-Type': 'text/html; charset=utf-8',
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
    const out = {
      ...row,
      can_edit: !row.deleted_at && row.thread_status !== 'resolved',
      can_delete: !row.deleted_at && !(row.kind === 'resolution' && row.thread_status === 'resolved'),
    };
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
type CommentMessageKind = string | null;

interface CommentLabel {
  key: string;
  label: string;
  description: string;
  color: string;
  enabled: boolean;
  position: number;
}

function commentLabelError(status: number, error: string, message: string, extra: Record<string, unknown> = {}): Response {
  return authJson({ error, message, ...extra }, { status });
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeCommentLabel(value: unknown, path = 'commentLabel'): CommentLabel | Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return commentLabelError(400, 'comment_label_invalid', 'Comment label must be an object.', { field: path });
  const input = value as Record<string, unknown>;
  const allowed = new Set(['key', 'label', 'description', 'color', 'enabled', 'position']);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) return commentLabelError(400, 'comment_label_invalid', 'Unknown comment label field.', { field: `${path}.${unknown}` });
  const key = typeof input.key === 'string' ? input.key : '';
  if (key === 'resolution') return commentLabelError(400, 'reserved_comment_label', 'The resolution key is reserved.', { key });
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(key)) return commentLabelError(400, 'comment_label_invalid', 'Invalid comment label key.', { field: `${path}.key` });
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || codePointLength(label) > 80) return commentLabelError(400, 'comment_label_invalid', 'Label must contain 1 to 80 characters.', { field: `${path}.label` });
  if (typeof input.description !== 'string') return commentLabelError(400, 'comment_label_invalid', 'Description must be a string.', { field: `${path}.description` });
  const description = input.description.trim();
  if (codePointLength(description) > 240) return commentLabelError(400, 'comment_label_invalid', 'Description may contain at most 240 characters.', { field: `${path}.description` });
  const color = typeof input.color === 'string' ? input.color.toUpperCase() : '';
  if (!/^#[0-9A-F]{6}$/.test(color)) return commentLabelError(400, 'comment_label_invalid', 'Color must be a six-digit hexadecimal color.', { field: `${path}.color` });
  if (typeof input.enabled !== 'boolean') return commentLabelError(400, 'comment_label_invalid', 'Enabled must be boolean.', { field: `${path}.enabled` });
  const position = input.position === undefined ? 0 : Number(input.position);
  if (!Number.isInteger(position) || position < 0) return commentLabelError(400, 'comment_label_invalid', 'Position must be a positive integer.', { field: `${path}.position` });
  return { key, label, description, color, enabled: input.enabled, position };
}

function expectedCommentLabelRevision(body: unknown): number | Response {
  const revision = body && typeof body === 'object' ? (body as { expectedRevision?: unknown }).expectedRevision : undefined;
  if (!Number.isSafeInteger(revision) || Number(revision) < 0) return commentLabelError(400, 'expected_revision_required', 'expectedRevision is required and must be a non-negative integer.');
  return Number(revision);
}

function normalizeCommentLabelChanges(value: unknown): Record<string, unknown> | Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return commentLabelError(400, 'comment_label_invalid', 'changes must be an object.', { field: 'changes' });
  const changes = value as Record<string, unknown>;
  const fields = Object.keys(changes);
  if (!fields.length) return commentLabelError(400, 'comment_label_invalid', 'changes must contain at least one mutable field.', { field: 'changes' });
  if (fields.some((field) => !['label', 'description', 'color', 'enabled', 'position'].includes(field))) return commentLabelError(400, 'comment_label_invalid', 'Changes contain an immutable or unknown field.', { field: 'changes' });
  const normalized: Record<string, unknown> = {};
  if ('label' in changes) {
    const label = typeof changes.label === 'string' ? changes.label.trim() : '';
    if (!label || codePointLength(label) > 80) return commentLabelError(400, 'comment_label_invalid', 'Label must contain 1 to 80 characters.', { field: 'changes.label' });
    normalized.label = label;
  }
  if ('description' in changes) {
    const description = typeof changes.description === 'string' ? changes.description.trim() : '';
    if (typeof changes.description !== 'string' || codePointLength(description) > 240) return commentLabelError(400, 'comment_label_invalid', 'Description must be a string of at most 240 characters.', { field: 'changes.description' });
    normalized.description = description;
  }
  if ('color' in changes) {
    const color = typeof changes.color === 'string' ? changes.color.toUpperCase() : '';
    if (!/^#[0-9A-F]{6}$/.test(color)) return commentLabelError(400, 'comment_label_invalid', 'Color must be a six-digit hexadecimal color.', { field: 'changes.color' });
    normalized.color = color;
  }
  if ('enabled' in changes) {
    if (typeof changes.enabled !== 'boolean') return commentLabelError(400, 'comment_label_invalid', 'Enabled must be boolean.', { field: 'changes.enabled' });
    normalized.enabled = changes.enabled;
  }
  if ('position' in changes) {
    if (!Number.isInteger(changes.position) || Number(changes.position) < 1) return commentLabelError(400, 'comment_label_invalid', 'Position must be a positive integer.', { field: 'changes.position' });
    normalized.position = Number(changes.position);
  }
  return normalized;
}

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

function normalizeMessageKind(body: unknown): CommentMessageKind | Response {
  const raw = body && typeof body === 'object' && (body as { kind?: unknown }).kind !== undefined
    ? (body as { kind?: unknown }).kind
    : null;
  if (raw === null) return null;
  if (typeof raw !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(raw) || raw === 'resolution') {
    return new Response('Invalid comment kind', { status: 400 });
  }
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
async function mintVersion(
  artifactId: string,
  contentHash: string,
  now: number,
  versionId = generateId(),
  artifactUpdate?: { name: string; sizeBytes: number; expiresAt: number; passwordHash: string | null }
): Promise<string> {
  const sql = getSQL();
  // Neon HTTP transactions are non-interactive but execute their predefined
  // statements sequentially. Lock in its own statement so a waiter gets a new
  // READ COMMITTED snapshot before allocating MAX(seq)+1. Copy the complete
  // comment snapshot set-wise, then publish the pointer as the final statement.
  // Any query failure rolls the version, copies, and pointer back together.
  const results = await sql.transaction((tx) => [
    tx`SELECT id FROM artifacts WHERE id = ${artifactId} FOR UPDATE`,
    tx`
      WITH next_seq AS (
        SELECT COALESCE(MAX(seq), 0) + 1 AS seq
        FROM artifact_versions
        WHERE artifact_id = ${artifactId}
      ), inserted_version AS (
        INSERT INTO artifact_versions (id, artifact_id, seq, content_hash, created_at)
        SELECT ${versionId}, ${artifactId}, seq, ${contentHash}, ${now}
        FROM next_seq
        RETURNING id, seq
      ), thread_map AS MATERIALIZED (
        SELECT
          source.*,
          md5(${versionId} || ':thread:' || source.id) AS new_id
        FROM comment_threads source
        CROSS JOIN inserted_version version
        WHERE version.seq > 1
          AND source.artifact_id = ${artifactId}
          AND source.version_id = (SELECT current_version_id FROM artifacts WHERE id = ${artifactId})
          AND source.deleted_at IS NULL
      ), copied_threads AS (
        INSERT INTO comment_threads (id, artifact_id, version_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_token_hash, resolved_by_label, resolved_at, created_at, updated_at)
        SELECT new_id, ${artifactId}, ${versionId}, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_token_hash, resolved_by_label, resolved_at, created_at, updated_at
        FROM thread_map
        RETURNING id
      ), copied_messages AS (
        INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, kind, created_at, updated_at)
        SELECT md5(${versionId} || ':message:' || message.id), thread.new_id, message.author_token_hash, message.author_label, message.body, message.kind, message.created_at, message.updated_at
        FROM comment_messages message
        INNER JOIN thread_map thread ON thread.id = message.thread_id
        WHERE message.deleted_at IS NULL
          AND (SELECT COUNT(*) FROM copied_threads) >= 0
        RETURNING id
      ), grandfathered_threads AS (
        UPDATE comment_threads
        SET version_id = ${versionId}
        WHERE artifact_id = ${artifactId}
          AND version_id IS NULL
          AND (SELECT seq FROM inserted_version) = 1
        RETURNING id
      )
      SELECT
        id,
        seq,
        (SELECT COUNT(*) FROM copied_threads) AS copied_thread_count,
        (SELECT COUNT(*) FROM copied_messages) AS copied_message_count,
        (SELECT COUNT(*) FROM grandfathered_threads) AS grandfathered_thread_count
      FROM inserted_version
    `,
    artifactUpdate
      ? tx`UPDATE artifacts SET name = ${artifactUpdate.name}, size_bytes = ${artifactUpdate.sizeBytes}, expires_at = ${artifactUpdate.expiresAt}, password_epoch = password_epoch + CASE WHEN password_hash IS DISTINCT FROM ${artifactUpdate.passwordHash} THEN 1 ELSE 0 END, password_hash = ${artifactUpdate.passwordHash}, current_version_id = ${versionId} WHERE id = ${artifactId} AND EXISTS (SELECT 1 FROM artifact_versions WHERE id = ${versionId}) RETURNING id`
      : tx`UPDATE artifacts SET current_version_id = ${versionId} WHERE id = ${artifactId} AND EXISTS (SELECT 1 FROM artifact_versions WHERE id = ${versionId}) RETURNING id`,
  ]);
  if (!results[0]?.[0] || !results[1]?.[0] || !results[2]?.[0]) {
    throw new Error('Artifact version transaction did not publish');
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

function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface VercelCommentWidgetConfig {
  artifactId: string;
  viewerToken: string;
  origin: string;
  artifactBasePath: string;
  currentPagePath: string;
  instanceScope: string;
}

export function injectCommentsUI(html: string, config: VercelCommentWidgetConfig): string {
  const payload = serializeInlineScriptValue(config);
  const shell = `
<div id="toss-comments-root"></div>
<script>
(() => {
  const cfg = ${payload};
  const NAME_KEY = 'toss-comment-name';
  const LABEL_SUMMARY_KEY = 'toss:comment-widget:' + cfg.instanceScope + ':open-feedback-expanded';
  const safeStorageGet = (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } };
  const safeStorageSet = (key, value) => { try { localStorage.setItem(key, value); } catch (e) {} };
  const PAGE = cfg.currentPagePath || 'index.html';
  const state = { mode: 'browse', threads: [], commentLabels: [], commentLabelRevision: 0, name: safeStorageGet(NAME_KEY) || '', kind: null, rootLabelPickerOpen: false, rootLabelSearch: '', rootLabelActive: 0, rootLabelFocusAfterRender: false, labelSummaryExpanded: safeStorageGet(LABEL_SUMMARY_KEY) === 'true', labelSummaryFocusAfterRender: false, statusFilter: 'open', kindFilter: 'all', pending: null, resolving: null, hoverEl: null, loaded: false, replyDrafts: {}, expandedThreadId: null, replyOriginThreadId: null, replyFocusAfterRender: null, replySubmitting: null, threadLoadGeneration: 0 };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const txt = (el) => (el && (el.innerText || el.textContent) || '').trim();
  const ago = (ts) => { const s = Math.floor(Date.now() / 1000 - ts); if (s < 60) return 'just now'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'; const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; return Math.floor(h / 24) + 'd ago'; };

  const host = document.getElementById('toss-comments-root');
  const sr = host.attachShadow({ mode: 'open' });
  const STYLE = '<style>:host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}[hidden]{display:none!important}button,input,textarea,select{font:inherit}.launcher,.panelBtn{position:fixed;z-index:2147483640;height:40px;border:0;cursor:pointer;border-radius:999px;font-size:13px;font-weight:650;color:#fff;background:#b94732;box-shadow:0 5px 14px rgba(185,71,50,.24);padding:0 17px}.launcher{right:20px;bottom:20px}.launcher:hover,.replyBtn:hover,.btn.primary:hover{background:#a63d2b}.launcher.active{background:#111827}.panelBtn{right:20px;bottom:72px;height:38px;background:#fff;color:#374151;padding:0 12px 0 14px;border:1px solid #e5e7eb;box-shadow:0 4px 12px rgba(15,23,42,.08)}#count{display:inline-grid;place-items:center;min-width:19px;height:19px;padding:0 5px;margin-left:6px;background:#b94732;color:#fff;border-radius:999px;font-size:10px;font-weight:700}.hint{position:fixed;z-index:2147483641;top:16px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 16px;border-radius:999px;font-size:13px}#hl{position:fixed;z-index:2147483630;pointer-events:none;border-radius:6px}#hl.hover{outline:2px solid #d9654a;outline-offset:1px;background:rgba(217,101,74,.08)}#hl.flash{outline:2px solid #d9654a;background:rgba(217,101,74,.14);animation:tcp .5s ease-in-out 0s 3}@keyframes tcp{0%,100%{background:rgba(217,101,74,.05)}50%{background:rgba(217,101,74,.22)}}.panel{position:fixed;z-index:2147483645;top:0;right:0;width:360px;max-width:360px;height:100vh;background:#fff;border-left:1px solid #e6e9ed;box-shadow:-12px 0 32px rgba(15,23,42,.1);display:flex;flex-direction:column;overflow:hidden}.panel header{height:56px;flex:0 0 56px;display:flex;align-items:center;justify-content:space-between;padding:0 14px 0 16px;border-bottom:1px solid #eef0f2}.panel header h3{margin:0;font-size:15px;font-weight:650;color:#111827}.panel header button{width:32px;height:32px;border:0;border-radius:8px;background:transparent;font-size:20px;color:#8b95a5}#status{padding:0 16px;font-size:12px;color:#9a3412}.labelSummary{position:relative;z-index:4;flex:0 0 34px;height:34px;border-bottom:1px solid #eef0f2;background:#fbfcfd}.summaryToggle{width:100%;height:33px;display:flex;align-items:center;gap:6px;border:0;background:transparent;padding:0 12px;color:#52606f;text-align:left;outline:0;overflow:hidden}.summaryToggle:focus-visible{box-shadow:inset 0 0 0 2px #d9654a}.summaryLead{display:flex;align-items:center;gap:5px;flex:0 0 auto;font-size:11px;font-weight:650;color:#111827}.summaryTotal{display:inline-grid;place-items:center;min-width:19px;height:19px;padding:0 5px;border:1px solid #d8dde4;border-radius:999px;background:#fff;color:#52606f;font-size:10px;font-weight:700}.summaryDivider{width:1px;height:14px;flex:0 0 1px;background:#dfe3e8}.summaryPreview{min-width:0;display:flex;align-items:center;gap:8px;overflow:hidden;white-space:nowrap;color:#667085;font-size:10.5px}.previewItem{display:inline-flex;align-items:center;gap:4px;min-width:0}.previewItem .name{max-width:62px;overflow:hidden;text-overflow:ellipsis}.previewItem b,.countRow b{color:#374151;font-weight:700;font-variant-numeric:tabular-nums}.summaryMore{flex:0 0 auto;color:#8b95a5;font-size:10px;white-space:nowrap}.chevron{position:relative;width:18px;height:18px;flex:0 0 18px;margin-left:auto;color:#8b95a5}.chevron:before{content:"";position:absolute;left:6px;top:5px;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg)}.summaryToggle[aria-expanded=true] .chevron:before{top:8px;transform:rotate(225deg)}.summaryPopover{position:absolute;left:10px;right:10px;top:38px;z-index:12;border:1px solid #e5e7eb;border-radius:10px;background:#fff;box-shadow:0 10px 28px rgba(15,23,42,.13);overflow:hidden}.popoverHead{height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 10px 0 12px;border-bottom:1px solid #eef0f2}.popoverHead strong{font-size:11px;color:#111827}.popoverHead span{font-size:10px;color:#8b95a5}.allCounts{max-height:190px;overflow-y:auto;overflow-x:hidden;padding:4px}.countRow{height:30px;display:flex;align-items:center;gap:8px;padding:0 8px;border-radius:7px;color:#475569;font-size:11px}.countRow .labelName{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.scrim{position:absolute;z-index:3;inset:90px 0 0;background:rgba(17,24,39,.045);pointer-events:none}.filters{position:relative;z-index:2;display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 12px;border-bottom:1px solid #eef0f2;background:#fff}.filters.single{grid-template-columns:1fr}.filters select{width:100%;height:30px;min-width:0;border:1px solid #d9dde3;border-radius:7px;background:#fff;color:#475569;padding:0 7px;font-size:11px}.filters select:focus,input:focus,textarea:focus{border-color:#d9654a;box-shadow:0 0 0 3px rgba(217,101,74,.1);outline:0}#list{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;padding:12px;display:flex;flex-direction:column;gap:10px;background:#fbfcfd}.empty{color:#8b95a5;text-align:center;padding:44px 18px;font-size:13px}.item{min-width:0;border:1px solid #e5e7eb;border-radius:12px;background:#fff;padding:12px;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.035)}.ctxline{font-size:11px;color:#667085;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ctxline .sel{color:#be4b2f;font-weight:600}.meta{display:flex;align-items:center;min-width:0;font-size:12px;line-height:18px;color:#1f2937;font-weight:650}.meta b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta .agox{color:#9ca3af;font-weight:400;font-size:11px;margin-left:6px;flex:0 0 auto}.body{font-size:13px;color:#374151;line-height:1.48;margin-top:3px;overflow-wrap:anywhere}.orphan{margin-top:8px;padding:8px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:12px;color:#9a3412}.composer{position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.52);display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(15,23,42,.28);width:520px;max-width:100%}.pad{padding:18px}.pad h3{margin:0 0 14px;font-size:15px;color:#111827}#ctx{background:#f8fafc;border:1px solid #e7eaee;border-radius:10px;padding:10px 12px;margin-bottom:14px}#ctx .cr{display:flex;gap:8px;font-size:12px;line-height:1.65;color:#293548}#ctx .cr span{color:#9ca3af;min-width:76px}#ctx code{font-family:monospace;font-size:11px;color:#be4b2f;word-break:break-all}.row{margin-bottom:10px;min-width:0}input,textarea{width:100%;border:1px solid #d5dae1;border-radius:9px;background:#fff;padding:10px 11px;font-size:13px;color:#111827}textarea{min-height:92px;resize:vertical;line-height:1.45}.actions{display:flex;justify-content:flex-end;gap:8px}.btn{height:36px;border:1px solid transparent;border-radius:8px;padding:0 14px;font-size:13px;font-weight:650}.btn.ghost{border-color:#dfe3e8;background:#fff;color:#475569}.btn.primary,.replyBtn{background:#b94732;color:#fff}.reply{padding:8px 0 0 12px;border-left:2px solid #eceff3;margin-top:8px}.reply .meta{font-size:11px}.reply .body{font-size:12px;color:#596579}.replyForm{margin-top:10px;padding-top:10px;border-top:1px solid #eef0f2;min-width:0}.identitySummary{display:flex;align-items:center;gap:7px;color:#667085;font-size:11px;min-width:0}.identitySummary strong{color:#374151;overflow:hidden;text-overflow:ellipsis}.identityAvatar{width:24px;height:24px;flex:0 0 24px;display:grid;place-items:center;border-radius:50%;background:#f0f2f5;color:#475569;font-size:9px}.identityChange{margin-left:auto;border:0;background:transparent;color:#b94732;font-size:10.5px}.identityEditor label,.replyField label{display:block;margin:0 0 5px;color:#475569;font-size:10.5px;font-weight:650}.identityEditor input{height:32px;padding:0 8px;font-size:11px}.identityActions,.replyActions{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap;margin-top:6px}.replyField{margin-top:8px}.replyInput{height:64px;min-height:64px;resize:none;padding:8px;font-size:11px}.replyActions .btn,.replyBtn{height:30px;padding:0 10px;font-size:11px;border-radius:7px}.replyBtn{border:0;font-weight:650}.btn.small{height:28px;padding:0 10px;font-size:11px}.btn.resolve{border-color:#b7e4d2;background:#f3fbf8;color:#14795c}.btn.reopen{border-color:#dfe3e8;background:#fff;color:#475569}.badge{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border:1px solid;border-radius:999px;font-size:10px;font-weight:650;line-height:16px;white-space:nowrap}.badge:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}.badge.open{background:#f0f9ff;border-color:#bae6fd;color:#0369a1}.badge.resolved{background:#f0fdf4;border-color:#bbf7d0;color:#15803d}.threadActions{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:10px}.threadActionGroup{display:flex;gap:8px}.replyToggle{border:0;background:transparent;color:#b94732;padding:0 2px;font-size:11px;font-weight:650}.messageHead{display:flex;align-items:flex-start;gap:6px;min-width:0;flex-wrap:wrap}.messageHead .meta{flex:1 1 92px;overflow:hidden;white-space:nowrap}.messageBadges{display:flex;flex:0 1 auto;align-items:center;justify-content:flex-end;gap:5px;min-width:0;max-width:100%}.kindBadge{display:inline-flex;align-items:center;gap:5px;height:20px;border:1px solid #d8dde4;border-radius:999px;padding:0 7px;background:#f8fafc;color:#52606f;font-size:9px;font-weight:750;letter-spacing:.045em;text-transform:uppercase;white-space:nowrap;max-width:100%}.kindBadge .bl{min-width:0;overflow:hidden;text-overflow:ellipsis}.tdot{width:5px;height:5px;flex:0 0 5px;border-radius:50%;box-shadow:0 0 0 1px rgba(15,23,42,.14)}.typeZone{margin-top:8px;min-width:0}.typeAdd{height:26px;display:inline-flex;align-items:center;gap:5px;border:1px solid #dfe3e8;border-radius:999px;background:#fff;color:#667085;padding:0 10px;font-size:10.5px;font-weight:650}.typeAdd.large{height:28px}.typePicker{margin-top:6px;border:1px solid #e5e7eb;border-radius:10px;background:#fff;box-shadow:0 4px 12px rgba(15,23,42,.07);padding:4px;max-width:100%}.typePickerList{max-height:128px;overflow-y:auto;overflow-x:hidden}.typePickerList.many{max-height:158px}.typeOption{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:#374151;font-size:11.5px;font-weight:600;text-align:left;white-space:nowrap;overflow:hidden}.typeOption.active{background:#f8fafc;box-shadow:inset 0 0 0 1.5px #d9654a}.typeOption .tlabel{min-width:0;overflow:hidden;text-overflow:ellipsis}.typeSearch{height:30px;border:0;border-bottom:1px solid #eef0f2;border-radius:8px 8px 0 0;padding:0 9px;margin:0 0 4px;font-size:11.5px}.typeEmpty{padding:12px 9px;color:#8b95a5;font-size:11px;text-align:center}.typeChip{max-width:100%;height:27px;display:inline-flex;align-items:center;gap:5px;border:1px solid #d8dde4;border-radius:999px;background:#f8fafc;color:#52606f;padding:0 5px 0 9px;font-size:10px;font-weight:650}.typeChip.large{height:28px;font-size:10.5px}.typeChipLabel{border:0;background:transparent;color:inherit;font:inherit;padding:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.typeChipRemove{width:16px;height:16px;border:0;border-radius:50%;background:transparent;color:inherit;padding:0}.resolveCard{width:440px}.resolveCard textarea{min-height:76px}.attribution{display:flex;align-items:center;gap:8px;margin:10px 0 2px;color:#667085;font-size:10.5px}.avatar{width:22px;height:22px;display:grid;place-items:center;border-radius:50%;background:#f0f2f5}.required{color:#9f3826}.srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:430px){.composer{padding:12px}.card{max-height:calc(100vh - 24px);overflow:auto}.launcher,.panelBtn{right:12px}.panel{left:0;right:auto;max-width:100vw;width:100vw;border:0;box-shadow:none}.typePickerList{max-height:104px}}</style>';
  const MARKUP = '<button id="launcher" class="launcher">Comment</button><button id="panelBtn" class="panelBtn">Comments <span id="count">0</span></button><div id="hint" class="hint" hidden>Comment mode &middot; click a component or select text &middot; Esc to exit</div><div id="hl" hidden></div><aside id="panel" class="panel" hidden><header><h3>Comments</h3><button id="panelClose" aria-label="Close comments">&times;</button></header><div id="status" role="status" aria-live="polite"></div><div id="labelSummary"></div><div id="labelScrim" class="scrim" hidden aria-hidden="true"></div><div id="filters" class="filters"><label><span class="srOnly">Thread status</span><select id="statusFilter" aria-label="Filter by thread status"><option value="open">Open threads</option><option value="resolved">Resolved threads</option><option value="all">All threads</option></select></label><label id="labelFilterWrap"><span class="srOnly">Comment label</span><select id="kindFilter" aria-label="Filter by comment label"></select></label></div><div id="list" tabindex="-1" aria-label="Comment threads"></div></aside><div id="composer" class="composer" hidden><div class="card" role="dialog" aria-modal="true" aria-labelledby="composerTitle"><div class="pad"><h3 id="composerTitle">Add a comment</h3><div id="ctx"></div><div class="row"><label for="cName">Your name</label><input id="cName" type="text" autocomplete="name" maxlength="80" required></div><div class="row"><label for="cText">Comment</label><textarea id="cText" placeholder="Describe the issue or suggestion" required></textarea></div><div id="rootLabelZone" class="row typeZone"></div><div class="actions"><button id="cCancel" class="btn ghost">Cancel</button><button id="cAdd" class="btn primary">Add comment</button></div></div></div></div><div id="resolveDialog" class="composer" hidden><div class="card resolveCard" role="dialog" aria-modal="true" aria-labelledby="resolveTitle"><div class="pad"><h3 id="resolveTitle">Resolve thread</h3><span id="resolveContext" class="kindBadge"></span><p>Add a required resolution note so reviewers can see what changed.</p><div class="row"><label for="resolveName">Your name <span class="required">*</span></label><input id="resolveName" type="text" autocomplete="name" maxlength="80" required></div><div class="row"><label for="resolveText">Resolution note <span class="required">*</span></label><textarea id="resolveText" required></textarea></div><div class="attribution"><span id="resolveAvatar" class="avatar" aria-hidden="true">?</span><span>This resolution will be attributed to <strong id="resolveAttribution">the named reviewer</strong>.</span></div><div class="actions"><button id="resolveCancel" class="btn ghost">Cancel</button><button id="resolveConfirm" class="btn primary">Resolve thread</button></div></div></div></div>';
  sr.innerHTML = STYLE + MARKUP;
  const $ = (s) => sr.querySelector(s);
  const launcher = $('#launcher'), panelBtn = $('#panelBtn'), countEl = $('#count'), hint = $('#hint'), hl = $('#hl');
  const panel = $('#panel'), list = $('#list'), composer = $('#composer'), ctx = $('#ctx'), cName = $('#cName'), cText = $('#cText'), statusEl = $('#status');
  const resolveDialog = $('#resolveDialog'), resolveName = $('#resolveName'), resolveText = $('#resolveText'), resolveContext = $('#resolveContext'), resolveAvatar = $('#resolveAvatar'), resolveAttribution = $('#resolveAttribution'), statusFilter = $('#statusFilter'), kindFilter = $('#kindFilter'), filters = $('#filters'), labelFilterWrap = $('#labelFilterWrap'), labelSummary = $('#labelSummary'), labelScrim = $('#labelScrim'), rootLabelZone = $('#rootLabelZone');

  launcher.addEventListener('click', () => setMode(state.mode === 'comment' ? 'browse' : 'comment'));
  panelBtn.addEventListener('click', () => { if (panel.hidden) openPanel(); else panel.hidden = true; });
  $('#panelClose').addEventListener('click', () => { panel.hidden = true; });
  $('#cCancel').addEventListener('click', closeComposer);
  $('#cAdd').addEventListener('click', addComment);
  $('#resolveCancel').addEventListener('click', closeResolve);
  $('#resolveConfirm').addEventListener('click', confirmResolve);
  resolveName.addEventListener('input', updateResolveAttribution);
  statusFilter.addEventListener('change', () => { state.statusFilter = statusFilter.value; render(true); });
  kindFilter.addEventListener('change', () => { state.kindFilter = kindFilter.value; render(true); });

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
    state.kind = null; state.rootLabelPickerOpen = false; state.rootLabelSearch = ''; state.rootLabelActive = 0;
    cName.value = state.name || ''; cText.value = ''; renderRootLabelZone(); composer.hidden = false;
    setTimeout(() => { (cName.value ? cText : cName).focus(); }, 30);
  }
  function closeComposer() { composer.hidden = true; state.pending = null; state.rootLabelPickerOpen = false; }

  const api = async (path, init) => {
    init = init || {};
    const headers = { 'X-Toss-Viewer': cfg.viewerToken };
    if (init.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(cfg.origin + path, { method: init.method || 'GET', headers: headers, body: init.body });
    const t = await res.text(); let data = null; try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed: ' + res.status));
    return data;
  };
  function withOptionalKind(payload, kind) { if (kind != null) payload.kind = kind; return payload; }
  function scopeOf(kind) { return kind === 'selection' ? 'selection' : (kind === 'page' ? 'artifact' : 'element'); }

  async function addComment() {
    if (!state.pending) return;
    const name = (cName.value || '').trim();
    const body = (cText.value || '').trim();
    if (!name) { cName.focus(); return; }
    if (!body) { cText.focus(); return; }
    commitGlobalIdentity(state.name, name);
    const t = state.pending; const scopeType = scopeOf(t.kind);
    const anchor = { kind: t.kind, locator: t.locator, state: t.state, view: t.view }; if (t.quote) anchor.quote = t.quote;
    closeComposer(); setStatus('Posting…');
    try {
      const data = await api('/artifacts/' + cfg.artifactId + '/comment-threads', { method: 'POST', body: JSON.stringify(withOptionalKind({ name: name, body: body, pagePath: PAGE, scopeType: scopeType, anchor: scopeType === 'artifact' ? undefined : anchor }, state.kind)) });
      if (data && data.thread) { state.threads.unshift(data.thread); }
      setStatus(''); openPanel();
    } catch (e) { setStatus(e.message || 'Failed to post.'); panel.hidden = false; }
  }

  function replyDraft(threadId) {
    if (!state.replyDrafts[threadId]) {
      const committed = (state.name || '').trim();
      state.replyDrafts[threadId] = { name: committed, body: '', kind: null, labelPickerOpen: false, labelSearch: '', labelActive: 0, identityEditing: !committed, identityEditorValue: committed, priorIdentity: committed };
    }
    return state.replyDrafts[threadId];
  }
  function commitGlobalIdentity(oldName, newName) {
    const previous = (oldName || '').trim();
    const committed = (newName || '').trim();
    state.name = committed;
    cName.value = committed;
    safeStorageSet(NAME_KEY, committed);
    Object.keys(state.replyDrafts).forEach((threadId) => {
      const draft = state.replyDrafts[threadId];
      if (draft.name !== previous) return;
      draft.name = committed;
      draft.priorIdentity = committed;
      if (!draft.identityEditing || draft.identityEditorValue === previous) draft.identityEditorValue = committed;
    });
    return committed;
  }
  function focusReplyControl(threadId, selector) {
    setTimeout(() => { const item = list.querySelector('[data-id="' + String(threadId).split('"').join('') + '"]'); const control = item && item.querySelector(selector); if (control) control.focus(); }, 0);
  }
  function focusAfterReplyCollapse(threadId) {
    setTimeout(() => {
      const reply = list.querySelector('.replyToggle[data-thread-id="' + String(threadId).split('"').join('') + '"]');
      if (reply) { reply.focus(); return; }
      const activeFilter = sr.activeElement === kindFilter ? kindFilter : (sr.activeElement === statusFilter ? statusFilter : null);
      if (activeFilter && !activeFilter.hidden) { activeFilter.focus(); return; }
      const action = list.querySelector('.threadActions button');
      if (action) { action.focus(); return; }
      list.focus();
    }, 0);
  }
  function queueReplyCollapseFocus(threadId) {
    state.replyOriginThreadId = threadId;
    state.replyFocusAfterRender = { threadId: threadId, fallback: true };
    state.expandedThreadId = null;
  }
  function captureReplyFocus() {
    const active = sr.activeElement;
    const composerEl = active && active.closest && active.closest('.replyForm');
    const item = composerEl && composerEl.closest('.item');
    if (!item || item.getAttribute('data-id') !== state.expandedThreadId) return null;
    let selector = '';
    if (active.classList.contains('replyInput')) selector = '.replyInput';
    else if (active.classList.contains('replyName')) selector = '.replyName';
    else if (active.classList.contains('identityChange')) selector = '.identityChange';
    else if (active.classList.contains('identitySave')) selector = '.identitySave';
    else if (active.classList.contains('identityCancel')) selector = '.identityCancel';
    else if (active.classList.contains('replyCancel')) selector = '.replyCancel';
    else if (active.classList.contains('replyBtn')) selector = '.replyBtn';
    else if (active.classList.contains('typeAdd')) selector = '.typeAdd';
    else if (active.classList.contains('typeChipLabel')) selector = '.typeChipLabel';
    else if (active.classList.contains('typeChipRemove')) selector = '.typeChipRemove';
    else if (active.classList.contains('typeSearch')) selector = '.typeSearch';
    if (!selector) return null;
    const hasSelection = typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number';
    return { threadId: state.expandedThreadId, selector: selector, selectionStart: hasSelection ? active.selectionStart : null, selectionEnd: hasSelection ? active.selectionEnd : null };
  }
  function restoreReplyFocus(intent) {
    if (!intent) return;
    if (intent.fallback) { focusAfterReplyCollapse(intent.threadId); return; }
    setTimeout(() => {
      const item = list.querySelector('[data-id="' + String(intent.threadId).split('"').join('') + '"]');
      const preserved = item && intent.preserveSelectionSelector && item.querySelector(intent.preserveSelectionSelector);
      if (preserved && intent.preserveSelectionStart !== null && typeof preserved.setSelectionRange === 'function') preserved.setSelectionRange(intent.preserveSelectionStart, intent.preserveSelectionEnd);
      const control = item && (item.querySelector(intent.selector) || (intent.fallbackSelector && item.querySelector(intent.fallbackSelector)));
      if (!control) { focusAfterReplyCollapse(intent.threadId); return; }
      control.focus();
      if (intent.selectionStart !== null && typeof control.setSelectionRange === 'function') control.setSelectionRange(intent.selectionStart, intent.selectionEnd);
    }, 0);
  }
  function restoreQueuedReplyFocus() {
    const intent = state.replyFocusAfterRender;
    state.replyFocusAfterRender = null;
    restoreReplyFocus(intent);
  }
  function openReply(threadId) {
    state.expandedThreadId = threadId;
    state.replyOriginThreadId = threadId;
    const draft = replyDraft(threadId);
    if (!draft.name) draft.identityEditing = true;
    render();
    focusReplyControl(threadId, draft.name && !draft.identityEditing ? '.replyInput' : '.replyName');
  }
  function cancelIdentity(threadId, focus) {
    const draft = replyDraft(threadId);
    const fallback = (draft.name || '').trim();
    draft.identityEditorValue = fallback;
    draft.priorIdentity = fallback;
    draft.identityEditing = !fallback;
    render();
    focusReplyControl(threadId, fallback ? '.identityChange' : '.replyName');
  }
  function saveIdentity(threadId) {
    const draft = replyDraft(threadId);
    const nextName = (draft.identityEditorValue || '').trim();
    if (!nextName) { focusReplyControl(threadId, '.replyName'); return false; }
    commitGlobalIdentity(draft.name, nextName);
    draft.identityEditing = false;
    draft.identityEditorValue = nextName;
    draft.priorIdentity = nextName;
    render();
    focusReplyControl(threadId, '.identityChange');
    return true;
  }
  function collapseReply(threadId, revertIdentity) {
    const draft = replyDraft(threadId);
    if (revertIdentity && draft.identityEditing) {
      const fallback = (draft.name || '').trim();
      draft.identityEditorValue = fallback;
      draft.priorIdentity = fallback;
      draft.identityEditing = !fallback;
    }
    state.expandedThreadId = null;
    render();
    focusAfterReplyCollapse(state.replyOriginThreadId || threadId);
  }
  function canRestoreReplyDraft(threadId, threads) {
    const thread = (threads || []).filter((item) => item.id === threadId)[0];
    return !!thread && !thread.deleted_at && (thread.status || 'open') !== 'resolved';
  }
  async function postReply(threadId) {
    const draft = replyDraft(threadId);
    if (draft.identityEditing && !saveIdentity(threadId)) return;
    const name = (draft.name || '').trim();
    const body = (draft.body || '').trim();
    if (!name) { draft.identityEditing = true; render(); focusReplyControl(threadId, '.replyName'); return; }
    if (!body) { focusReplyControl(threadId, '.replyInput'); return; }
    const snapshot = { threadId: threadId, name: draft.name, body: draft.body, kind: draft.kind, labelPickerOpen: draft.labelPickerOpen, labelSearch: draft.labelSearch, labelActive: draft.labelActive, identityEditing: draft.identityEditing, identityEditorValue: draft.identityEditorValue, priorIdentity: draft.priorIdentity };
    state.replySubmitting = threadId;
    render();
    try {
      await api('/comment-threads/' + threadId + '/messages', { method: 'POST', body: JSON.stringify(withOptionalKind({ name: snapshot.name, body: snapshot.body }, snapshot.kind)) });
      delete state.replyDrafts[threadId];
      state.expandedThreadId = null;
      state.replySubmitting = null;
      setStatus('');
      await loadThreads();
    } catch (e) {
      state.replySubmitting = null;
      setStatus(e.message || 'Failed to post reply.');
      if (canRestoreReplyDraft(threadId, state.threads)) {
        state.replyDrafts[threadId] = snapshot;
        state.expandedThreadId = threadId;
        render();
        focusReplyControl(threadId, snapshot.name ? '.replyInput' : '.replyName');
      } else {
        delete state.replyDrafts[threadId];
        state.replyOriginThreadId = threadId;
        state.replyFocusAfterRender = { threadId: threadId, fallback: true };
        state.expandedThreadId = null;
        render(true);
      }
    }
  }

  function reconcileReplyDrafts(threads) {
    const openIds = {};
    threads.forEach((thread) => { if ((thread.status || 'open') !== 'resolved' && !thread.deleted_at) openIds[thread.id] = true; });
    Object.keys(state.replyDrafts).forEach((threadId) => { if (!openIds[threadId]) delete state.replyDrafts[threadId]; });
    if (state.expandedThreadId && !openIds[state.expandedThreadId]) queueReplyCollapseFocus(state.expandedThreadId);
  }
  function threadsDigest(threads) {
    return JSON.stringify((threads || []).map((thread) => ({
      id: thread.id, status: thread.status || 'open', updated_at: thread.updated_at || null, deleted_at: thread.deleted_at || null,
      resolved_by_label: thread.resolved_by_label || '', resolved_at: thread.resolved_at || null,
      messages: (thread.messages || []).map((message) => ({ id: message.id, author_label: message.author_label || '', body: message.body || '', kind: message.kind == null ? null : message.kind, updated_at: message.updated_at || null, deleted_at: message.deleted_at || null })),
    })));
  }
  function labelsDigest(labels) { return JSON.stringify((labels || []).map((label) => [label.key, label.label, label.description || '', label.color || '', !!label.enabled, label.position])); }
  function applyThreads(threads, labels, revision) {
    reconcileReplyDrafts(threads);
    const enabledKeys = {};
    (labels || []).forEach((label) => { if (label.enabled && label.key !== 'resolution') enabledKeys[label.key] = true; });
    const notices = [];
    if (state.kindFilter !== 'all' && !enabledKeys[state.kindFilter]) { notices.push('Label filter reset to All labels — “' + labelName(state.kindFilter) + '” is no longer available.'); state.kindFilter = 'all'; }
    if (state.kind && !enabledKeys[state.kind]) {
      notices.push('Comment label “' + labelName(state.kind) + '” is no longer available; selection removed.');
      state.kind = null; state.rootLabelPickerOpen = false; state.rootLabelSearch = ''; state.rootLabelActive = 0;
      if (!composer.hidden) state.rootLabelFocusAfterRender = true;
    }
    Object.keys(state.replyDrafts).forEach((threadId) => {
      const draft = state.replyDrafts[threadId];
      if (draft.kind && !enabledKeys[draft.kind]) {
        const priorFocus = state.expandedThreadId === threadId ? captureReplyFocus() : null;
        notices.push('Reply label “' + labelName(draft.kind) + '” is no longer available; selection removed.');
        draft.kind = null; draft.labelPickerOpen = false; draft.labelSearch = ''; draft.labelActive = 0;
        // Prefer the replacement Add label opener; if no labels remain, the
        // documented fallback is the preserved reply body field.
        if (state.expandedThreadId === threadId) state.replyFocusAfterRender = { threadId: threadId, selector: '.typeAdd', fallbackSelector: '.replyInput', selectionStart: null, selectionEnd: null, preserveSelectionSelector: priorFocus && priorFocus.selector === '.replyInput' ? '.replyInput' : null, preserveSelectionStart: priorFocus ? priorFocus.selectionStart : null, preserveSelectionEnd: priorFocus ? priorFocus.selectionEnd : null };
      }
    });
    const sig = threadsDigest(threads) + '|' + labelsDigest(labels) + '|' + String(revision || 0);
    if (sig === state.sig) return;
    state.sig = sig; state.threads = threads; state.commentLabels = labels || []; state.commentLabelRevision = revision || 0;
    if (notices.length) setStatus(notices.join(' '));
    render(true); renderRootLabelZone();
  }
  function beginThreadLoad() { state.threadLoadGeneration += 1; return state.threadLoadGeneration; }
  function isLatestThreadLoad(generation) { return generation === state.threadLoadGeneration; }
  async function loadThreads() {
    const generation = beginThreadLoad();
    try {
      const data = await api('/artifacts/' + cfg.artifactId + '/comment-threads?pagePath=' + encodeURIComponent(PAGE) + '&includeActivity=1');
      if (!isLatestThreadLoad(generation)) return;
      state.loaded = true; setStatus(''); applyThreads((data && data.threads) || [], (data && data.commentLabels) || [], data && data.commentLabelRevision);
    } catch (e) { if (isLatestThreadLoad(generation) && !state.loaded) setStatus(e.message || 'Failed to load.'); }
  }

  // Resolve requires an attributed note; reopen only requires attribution.
  function closeResolve() { resolveDialog.hidden = true; state.resolving = null; resolveText.value = ''; }
  function initials(name) { const parts = (name || '').trim().split(/ +/).filter(Boolean); return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() : '?'; }
  function updateResolveAttribution() { const name = (resolveName.value || '').trim(); resolveAvatar.textContent = initials(name); resolveAttribution.textContent = name || 'the named reviewer'; }
  function openResolve(threadId, btn) {
    const thread = state.threads.filter((item) => item.id === threadId)[0] || {};
    const first = (thread.messages || [])[0] || {};
    const contextKind = first.kind;
    state.resolving = { threadId: threadId };
    resolveName.value = state.name || '';
    resolveText.value = '';
    resolveContext.className = 'kindBadge resolveContext';
    resolveContext.innerHTML = contextKind ? labelDot(labelForKey(contextKind)) + '<span class="bl">' + esc(labelName(contextKind)) + '</span>' : 'Untyped';
    updateResolveAttribution();
    resolveDialog.hidden = false;
    setTimeout(() => { (resolveName.value ? resolveText : resolveName).focus(); }, 30);
  }
  async function confirmResolve() {
    if (!state.resolving) return;
    const name = (resolveName.value || '').trim(), body = (resolveText.value || '').trim();
    if (!name) { resolveName.focus(); return; }
    if (!body) { resolveText.focus(); return; }
    const pending = state.resolving;
    commitGlobalIdentity(state.name, name);
    $('#resolveConfirm').disabled = true;
    try {
      await api('/comment-threads/' + pending.threadId + '/resolve', { method: 'POST', body: JSON.stringify({ name: name, body: body }) });
      closeResolve(); setStatus(''); await loadThreads();
    } catch (e) { setStatus(e.message || 'Failed to resolve.'); }
    finally { $('#resolveConfirm').disabled = false; }
  }
  async function setThreadStatus(threadId, action, btn, itemEl) {
    if (action === 'resolve') { openResolve(threadId, btn); return; }
    const draft = replyDraft(threadId);
    const name = (draft.name || state.name || '').trim();
    if (!name) { openReply(threadId); return; }
    btn.disabled = true; btn.textContent = 'Reopen\u2026';
    try {
      await api('/comment-threads/' + threadId + '/reopen', { method: 'POST', body: JSON.stringify({ name: name }) });
      commitGlobalIdentity(state.name, name); setStatus(''); await loadThreads();
    } catch (e) { setStatus(e.message || 'Failed to reopen.'); btn.disabled = false; btn.textContent = 'Reopen'; }
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
  const enabledLabels = () => state.commentLabels.filter((label) => label.enabled && label.key !== 'resolution');
  const labelForKey = (key) => state.commentLabels.filter((label) => label.key === key)[0] || null;
  const labelName = (key) => { const label = labelForKey(key); return label ? label.label : key; };
  const labelDot = (label) => label ? '<span class="tdot" aria-hidden="true" style="background:' + esc(label.color || '#667085') + '"></span>' : '';
  const kindBadge = (kind) => kind == null || kind === 'resolution' ? '' : '<span class="kindBadge">' + labelDot(labelForKey(kind)) + '<span class="bl">' + esc(labelName(kind)) + '</span></span>';
  const visibleMessages = (thread) => (thread.messages || []).filter((message) => !message.deleted_at);
  const labelCount = (threads, kind) => threads.reduce((total, thread) => total + (thread.status === 'resolved' ? 0 : visibleMessages(thread).filter((message) => message.kind === kind).length), 0);
  const threadMatchesKind = (thread, kind) => kind === 'all' || visibleMessages(thread).some((message) => message.kind === kind);
  const filteredPickerLabels = (search) => { const query = (search || '').trim().toLowerCase(); return enabledLabels().filter((label) => !query || (label.key + ' ' + label.label + ' ' + (label.description || '')).toLowerCase().indexOf(query) >= 0); };
  function labelPickerHtml(scope, selected, open, search, active) {
    const labels = filteredPickerLabels(search), many = enabledLabels().length > 6, safeActive = labels.length ? Math.max(0, Math.min(active || 0, labels.length - 1)) : -1;
    if (!open) {
      if (!selected) return '<button type="button" class="typeAdd' + (scope === 'root' ? ' large' : '') + '" aria-expanded="false" aria-haspopup="listbox"><span aria-hidden="true">+</span>Add label</button>';
      const label = labelForKey(selected);
      return '<span class="typeChip' + (scope === 'root' ? ' large' : '') + '">' + labelDot(label) + '<button type="button" class="typeChipLabel" aria-haspopup="listbox" aria-expanded="false" aria-label="Change comment label, currently ' + esc(labelName(selected)) + '">' + esc(labelName(selected)) + '</button><button type="button" class="typeChipRemove" aria-label="Remove comment label">&times;</button></span>';
    }
    const listId = 'label-picker-' + scope, helpId = listId + '-help', activeId = safeActive >= 0 ? listId + '-option-' + safeActive : null;
    const searchBox = many ? '<div id="' + helpId + '" class="srOnly">Searches label key, label, and description. Arrow keys, Home, and End update the active option.</div><input class="typeSearch" type="text" role="combobox" placeholder="Search labels…" aria-label="Search comment labels" aria-expanded="true" aria-controls="' + listId + '" aria-autocomplete="list"' + (activeId ? ' aria-activedescendant="' + activeId + '"' : '') + ' aria-describedby="' + helpId + '" value="' + esc(search || '') + '">' : '';
    const options = labels.map((label, index) => '<button id="' + listId + '-option-' + index + '" type="button" class="typeOption' + (index === safeActive ? ' active' : '') + '" role="option" aria-selected="' + String(selected === label.key) + '" tabindex="' + (many || index !== safeActive ? '-1' : '0') + '" data-label-key="' + esc(label.key) + '" data-option-index="' + index + '">' + labelDot(label) + '<span class="tlabel">' + esc(label.label) + '</span></button>').join('');
    return '<button type="button" class="typeAdd' + (scope === 'root' ? ' large' : '') + '" aria-expanded="true" aria-haspopup="listbox" aria-controls="' + listId + '"><span aria-hidden="true">+</span>' + (selected ? 'Change label' : 'Add label') + '</button><div class="typePicker">' + searchBox + '<div id="' + listId + '" class="typePickerList' + (many ? ' many' : '') + '" role="listbox" aria-label="Comment label"' + (activeId ? ' aria-activedescendant="' + activeId + '"' : '') + '>' + options + (!labels.length ? '<div class="typeEmpty" role="status" aria-live="polite">No labels match your search.</div>' : '') + '</div></div>';
  }
  function bindLabelPicker(zone, scope, draft) {
    const rerender = () => scope === 'root' ? renderRootLabelZone() : render();
    const currentZone = () => scope === 'root' ? rootLabelZone : list.querySelector('.replyForm:not([hidden]) .typeZone');
    const liveControl = (selector) => { const liveZone = currentZone(); return liveZone && liveZone.querySelector(selector); };
    const focusOpener = () => setTimeout(() => { const opener = liveControl('.typeAdd,.typeChipLabel'); if (opener) opener.focus(); }, 0);
    const focusActive = (preferSearch) => setTimeout(() => { const target = preferSearch ? liveControl('.typeSearch') : (liveControl('.typeOption.active') || liveControl('.typeSearch')); if (target) { target.focus(); if (preferSearch && typeof target.setSelectionRange === 'function') target.setSelectionRange(draft.labelSearch.length, draft.labelSearch.length); } }, 0);
    const closePicker = () => { draft.labelPickerOpen = false; draft.labelSearch = ''; draft.labelActive = 0; rerender(); focusOpener(); };
    const selectActive = () => { const labels = filteredPickerLabels(draft.labelSearch); if (!labels.length) return; draft.kind = labels[Math.max(0, Math.min(draft.labelActive, labels.length - 1))].key; draft.labelPickerOpen = false; draft.labelSearch = ''; draft.labelActive = 0; rerender(); focusOpener(); };
    const moveActive = (key, preferSearch) => {
      const labels = filteredPickerLabels(draft.labelSearch); if (!labels.length) return;
      if (key === 'Home') draft.labelActive = 0;
      else if (key === 'End') draft.labelActive = labels.length - 1;
      else draft.labelActive = (draft.labelActive + (key === 'ArrowDown' ? 1 : -1) + labels.length) % labels.length;
      rerender(); focusActive(preferSearch);
    };
    const handlePickerKey = (event, preferSearch) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); return true; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') { event.preventDefault(); moveActive(event.key, preferSearch); return true; }
      // The approved combobox contract reserves Space for selecting the active
      // descendant while search retains focus. Consequently literal spaces
      // cannot be entered in this label-search field; label/key/description
      // matching remains available through contiguous query terms.
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectActive(); return true; }
      return false;
    };
    const add = zone.querySelector('.typeAdd'); if (add) add.addEventListener('click', () => { draft.labelPickerOpen = !draft.labelPickerOpen; draft.labelActive = 0; rerender(); if (draft.labelPickerOpen) focusActive(enabledLabels().length > 6); });
    const change = zone.querySelector('.typeChipLabel'); if (change) change.addEventListener('click', () => { draft.labelPickerOpen = true; rerender(); focusActive(enabledLabels().length > 6); });
    const remove = zone.querySelector('.typeChipRemove'); if (remove) remove.addEventListener('click', () => { draft.kind = null; draft.labelPickerOpen = false; draft.labelSearch = ''; rerender(); });
    Array.prototype.forEach.call(zone.querySelectorAll('.typeOption'), (option) => {
      option.addEventListener('click', () => { draft.labelActive = Number(option.getAttribute('data-option-index')) || 0; selectActive(); });
      option.addEventListener('keydown', (event) => handlePickerKey(event, false));
    });
    const search = zone.querySelector('.typeSearch'); if (search) {
      search.addEventListener('input', () => { draft.labelSearch = search.value; draft.labelActive = 0; rerender(); focusActive(true); });
      search.addEventListener('keydown', (event) => handlePickerKey(event, true));
    }
  }
  function renderRootLabelZone() {
    const labels = enabledLabels(); rootLabelZone.hidden = !labels.length;
    if (!labels.length) {
      rootLabelZone.innerHTML = '';
      if (state.rootLabelFocusAfterRender) { state.rootLabelFocusAfterRender = false; setTimeout(() => cText.focus(), 0); }
      return;
    }
    const draft = { get kind() { return state.kind; }, set kind(value) { state.kind = value; }, get labelPickerOpen() { return state.rootLabelPickerOpen; }, set labelPickerOpen(value) { state.rootLabelPickerOpen = value; }, get labelSearch() { return state.rootLabelSearch; }, set labelSearch(value) { state.rootLabelSearch = value; }, get labelActive() { return state.rootLabelActive; }, set labelActive(value) { state.rootLabelActive = value; } };
    rootLabelZone.innerHTML = labelPickerHtml('root', state.kind, state.rootLabelPickerOpen, state.rootLabelSearch, state.rootLabelActive); bindLabelPicker(rootLabelZone, 'root', draft);
    if (state.rootLabelFocusAfterRender) { state.rootLabelFocusAfterRender = false; setTimeout(() => { const opener = rootLabelZone.querySelector('.typeAdd,.typeChipLabel'); if (opener) opener.focus(); else cText.focus(); }, 0); }
  }
  function renderLabelChrome() {
    const restoreToggleFocus = state.labelSummaryFocusAfterRender || (sr.activeElement && sr.activeElement.id === 'labelSummaryToggle');
    const labels = enabledLabels(); labelFilterWrap.hidden = !labels.length; filters.classList.toggle('single', !labels.length);
    kindFilter.innerHTML = '<option value="all">All labels</option>' + labels.map((label) => '<option value="' + esc(label.key) + '">' + esc(label.label) + '</option>').join(''); kindFilter.value = state.kindFilter;
    const counts = labels.map((label) => ({ label: label, count: labelCount(state.threads, label.key) })).filter((item) => item.count > 0), total = counts.reduce((sum, item) => sum + item.count, 0);
    if (!counts.length) { state.labelSummaryFocusAfterRender = false; labelSummary.innerHTML = ''; labelSummary.className = ''; labelScrim.hidden = true; return; }
    const preview = counts.slice(0, 2).map((item) => '<span class="previewItem">' + labelDot(item.label) + '<span class="name">' + esc(item.label.label) + '</span><b>' + item.count + '</b></span>').join('');
    const rows = counts.map((item) => '<div class="countRow">' + labelDot(item.label) + '<span class="labelName">' + esc(item.label.label) + '</span><b>' + item.count + '</b></div>').join('');
    labelSummary.className = 'labelSummary'; labelSummary.innerHTML = '<button id="labelSummaryToggle" class="summaryToggle" type="button" aria-expanded="' + String(state.labelSummaryExpanded) + '" aria-controls="label-summary-popover"><span class="summaryLead">Labels <span class="summaryTotal" aria-label="' + total + ' labeled open messages">' + total + '</span></span><span class="summaryDivider" aria-hidden="true"></span><span class="summaryPreview" aria-hidden="true">' + preview + '</span>' + (counts.length > 2 ? '<span class="summaryMore">+' + (counts.length - 2) + '</span>' : '') + '<span class="chevron" aria-hidden="true"></span></button><div id="label-summary-popover" class="summaryPopover" role="region" aria-label="All comment label counts"' + (state.labelSummaryExpanded ? '' : ' hidden') + '><div class="popoverHead"><strong>All labels</strong><span>' + total + ' total</span></div><div class="allCounts" tabindex="0">' + rows + '</div></div>';
    labelScrim.hidden = !state.labelSummaryExpanded;
    $('#labelSummaryToggle').addEventListener('click', () => { state.labelSummaryFocusAfterRender = true; state.labelSummaryExpanded = !state.labelSummaryExpanded; safeStorageSet(LABEL_SUMMARY_KEY, String(state.labelSummaryExpanded)); renderLabelChrome(); });
    if (restoreToggleFocus) { state.labelSummaryFocusAfterRender = false; setTimeout(() => { const replacement = $('#labelSummaryToggle'); if (replacement) replacement.focus(); }, 0); }
  }
  function render(preserveReplyFocus) {
    countEl.textContent = state.threads.length;
    renderLabelChrome();
    const visible = state.threads.filter((th) => {
      if (state.statusFilter !== 'all' && (th.status || 'open') !== state.statusFilter) return false;
      return threadMatchesKind(th, state.kindFilter);
    });
    if (state.expandedThreadId && !visible.some((thread) => thread.id === state.expandedThreadId)) queueReplyCollapseFocus(state.expandedThreadId);
    else if (preserveReplyFocus && !state.replyFocusAfterRender) state.replyFocusAfterRender = captureReplyFocus();
    if (!visible.length) { list.innerHTML = '<div class="empty">No comments match these filters.</div>'; restoreQueuedReplyFocus(); return; }
    list.innerHTML = visible.map((th) => {
      const a = th.anchor || {}, view = a.view || {}, st = a.state || {};
      const label = a.quote ? ('“' + a.quote.exact + '”') : (st.text || (th.scope_type === 'artifact' ? 'Whole page' : '(element)'));
      const msgs = th.messages || [], first = msgs[0] || {}, resolved = th.status === 'resolved';
      const who = (th.resolved_by_label || '').trim();
      const statusBadge = resolved
        ? '<span class="badge resolved"><span class="badgeText">resolved' + (who ? ' by ' + esc(who) : '') + (th.resolved_at ? ' \u00b7 ' + ago(th.resolved_at) : '') + '</span></span>'
        : '<span class="badge open"><span class="badgeText">open</span></span>';
      const key = Array.from(String(th.id)).map((char) => char.codePointAt(0).toString(16)).join('-');
      const composerId = 'reply-composer-' + key, editorId = 'reply-identity-editor-' + key, nameId = 'reply-name-' + key, replyId = 'reply-body-' + key;
      const draft = resolved ? null : replyDraft(th.id);
      const expanded = !resolved && state.expandedThreadId === th.id;
      let html = '<div class="item" data-id="' + esc(th.id) + '">' +
        '<div class="ctxline">' + esc(view.navLabel || view.heading || 'Page') + ' · <span class="sel">' + esc(label.slice(0, 46)) + (label.length > 46 ? '…' : '') + '</span></div>' +
        '<div class="messageHead' + (resolved ? ' resolvedHead' : '') + '"><div class="meta"><b>' + esc(th.created_by_label || first.author_label || 'Someone') + '</b><span class="agox">' + ago(th.created_at || Math.floor(Date.now() / 1000)) + '</span></div><div class="messageBadges">' + kindBadge(first.kind) + statusBadge + '</div></div>' +
        '<div class="body">' + esc(first.body || '') + '</div>';
      for (let i = 1; i < msgs.length; i++) {
        const r = msgs[i];
        html += '<div class="reply"><div class="messageHead"><div class="meta"><b>' + esc(r.author_label || 'Someone') + '</b><span class="agox">' + ago(r.created_at || Math.floor(Date.now() / 1000)) + '</span></div><div class="messageBadges">' + kindBadge(r.kind) + '</div></div><div class="body">' + esc(r.body || '') + '</div></div>';
      }
      html += '<div class="threadActions">' + (!resolved ? '<button type="button" class="replyToggle" data-thread-id="' + esc(th.id) + '" aria-expanded="' + String(expanded) + '" aria-controls="' + composerId + '">Reply</button>' : '<span></span>') + '<div class="threadActionGroup">' + (resolved
        ? '<button type="button" class="btn small reopen" data-act="reopen">Reopen</button>'
        : '<button type="button" class="btn small resolve" data-act="resolve">Resolve</button>') + '</div></div>';
      if (!resolved) {
        const summaryHidden = draft.identityEditing || !draft.name;
        const editorHidden = !draft.identityEditing && !!draft.name;
        html += '<div id="' + composerId + '" class="replyForm"' + (expanded ? '' : ' hidden') + '>' +
          '<div class="replyIdentity" aria-label="Reply identity"><div class="identitySummary"' + (summaryHidden ? ' hidden' : '') + '><span class="identityAvatar" aria-hidden="true">' + esc(initials(draft.name)) + '</span><span>Replying as <strong>' + esc(draft.name) + '</strong></span><button type="button" class="identityChange" aria-controls="' + editorId + '" aria-expanded="' + String(!editorHidden) + '">Change</button></div>' +
          '<div id="' + editorId + '" class="identityEditor"' + (editorHidden ? ' hidden' : '') + '><label for="' + nameId + '">Your name <span class="required">*</span></label><input id="' + nameId + '" class="replyName" type="text" autocomplete="name" maxlength="80" required value="' + esc(draft.identityEditorValue) + '"><div class="identityActions"><button type="button" class="btn ghost identityCancel">Cancel</button><button type="button" class="btn primary identitySave">Save</button></div></div></div>' +
          '<div class="replyField"><label for="' + replyId + '">Reply</label><textarea id="' + replyId + '" class="replyInput" placeholder="Write a reply…" required>' + esc(draft.body) + '</textarea></div>' +
          (enabledLabels().length ? '<div class="typeZone">' + labelPickerHtml('reply-' + key, draft.kind, draft.labelPickerOpen, draft.labelSearch, draft.labelActive) + '</div>' : '') +
          '<div class="replyActions"><button type="button" class="btn ghost replyCancel">Cancel</button><button type="button" class="replyBtn"' + (state.replySubmitting === th.id ? ' disabled' : '') + '>Reply</button></div></div>';
      }
      return html + '<div class="orphan" hidden></div></div>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.item'), (el) => el.addEventListener('click', (ev) => { if (ev.target.closest('.replyForm,.threadActions,button,input,textarea,select,label,[role=group]')) return; onItem(el.getAttribute('data-id'), el); }));
    Array.prototype.forEach.call(list.querySelectorAll('.threadActions [data-act]'), (btn) => btn.addEventListener('click', (ev) => { ev.stopPropagation(); const item = btn.closest('.item'); if (item) setThreadStatus(item.getAttribute('data-id'), btn.getAttribute('data-act'), btn, item); }));
    Array.prototype.forEach.call(list.querySelectorAll('.replyToggle'), (btn) => btn.addEventListener('click', (ev) => { ev.stopPropagation(); openReply(btn.getAttribute('data-thread-id')); }));
    Array.prototype.forEach.call(list.querySelectorAll('.replyName'), (input) => input.addEventListener('input', () => { replyDraft(input.closest('.item').getAttribute('data-id')).identityEditorValue = input.value; input.setCustomValidity(''); }));
    Array.prototype.forEach.call(list.querySelectorAll('.replyInput'), (input) => input.addEventListener('input', () => { replyDraft(input.closest('.item').getAttribute('data-id')).body = input.value; }));
    Array.prototype.forEach.call(list.querySelectorAll('.identityChange'), (btn) => btn.addEventListener('click', () => { const id = btn.closest('.item').getAttribute('data-id'), draft = replyDraft(id); draft.priorIdentity = draft.name; draft.identityEditorValue = draft.name; draft.identityEditing = true; render(); focusReplyControl(id, '.replyName'); }));
    Array.prototype.forEach.call(list.querySelectorAll('.identitySave'), (btn) => btn.addEventListener('click', () => saveIdentity(btn.closest('.item').getAttribute('data-id'))));
    Array.prototype.forEach.call(list.querySelectorAll('.identityCancel'), (btn) => btn.addEventListener('click', () => cancelIdentity(btn.closest('.item').getAttribute('data-id'), true)));
    Array.prototype.forEach.call(list.querySelectorAll('.replyCancel'), (btn) => btn.addEventListener('click', () => collapseReply(btn.closest('.item').getAttribute('data-id'), true)));
    Array.prototype.forEach.call(list.querySelectorAll('.replyBtn'), (btn) => btn.addEventListener('click', () => postReply(btn.closest('.item').getAttribute('data-id'))));
    Array.prototype.forEach.call(list.querySelectorAll('.replyForm .typeZone'), (zone) => { const id = zone.closest('.item').getAttribute('data-id'); bindLabelPicker(zone, 'reply-' + id, replyDraft(id)); });
    restoreQueuedReplyFocus();
  }

  function onItem(id, el) {
    const th = state.threads.filter((x) => x.id === id)[0]; if (!th) return;
    const target = relocate(th.anchor || {}), orphan = el.querySelector('.orphan');
    if (target) { orphan.hidden = true; target.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => flash(target), 300); }
    else { const a = th.anchor || {}; const view = a.view || {}; const st = a.state || {}; orphan.hidden = false; orphan.innerHTML = '⚠ The page changed since this was written. It referred to <b>“' + esc((st.text || '').slice(0, 80)) + '”</b> on the <b>' + esc(view.navLabel || view.heading || 'page') + '</b> screen.'; }
  }

  sr.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (resolveDialog.hidden === false) { const threadId = state.resolving && state.resolving.threadId; event.preventDefault(); closeResolve(); if (threadId) focusReplyControl(threadId, '.resolve'); return; }
    if (composer.hidden === false) { event.preventDefault(); closeComposer(); return; }
    if (state.mode === 'comment' || !state.expandedThreadId) return;
    event.preventDefault(); event.stopPropagation();
    const threadId = state.expandedThreadId, draft = replyDraft(threadId);
    if (draft.identityEditing) cancelIdentity(threadId, true);
    else collapseReply(threadId, false);
  });

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

  let contentPath = `artifacts/${meta.id}/files/${filePath}`;
  if (filePath === 'index.html') {
    const sql = getSQL();
    const versionRows = await sql`SELECT current_version_id FROM artifacts WHERE id = ${meta.id}`;
    const currentVersionId = versionRows[0]?.current_version_id;
    if (currentVersionId) contentPath = versionEntryBlobPath(meta.id, String(currentVersionId));
  }
  let stream = await blobGet(contentPath);
  // Legacy artifacts created before version-scoped entry blobs continue to use
  // the shared file path until their next publication.
  if (!stream && filePath === 'index.html' && contentPath !== `artifacts/${meta.id}/files/${filePath}`) {
    contentPath = `artifacts/${meta.id}/files/${filePath}`;
    stream = await blobGet(contentPath);
  }
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
    const response = await fetch(blobUrl(contentPath), { headers: blobHeaders() });
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
        // VERCEL_PROJECT_ID is stable across deployments, artifact versions, and
        // custom domains. The hostname is only a local/non-Vercel fallback.
        instanceScope: process.env.VERCEL_PROJECT_ID || new URL(request.url).hostname,
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

async function readOwnerCommentLabels(sql: any): Promise<{ revision: number; commentLabels: Array<CommentLabel & { usageCount: number }> }> {
  const rows = await sql`
    SELECT state.revision, label.key, label.label, label.description, label.color, label.enabled, label.position,
      (SELECT COUNT(*)::int FROM comment_messages message WHERE message.kind = label.key) AS usage_count
    FROM comment_label_registry_state state
    LEFT JOIN comment_labels label ON label.key <> 'resolution'
    WHERE state.singleton = true
    ORDER BY label.position ASC, label.key ASC
  `;
  return ownerCommentLabelListFromRows(rows);
}

function ownerCommentLabelListFromRows(rows: any[]): { revision: number; commentLabels: Array<CommentLabel & { usageCount: number }> } {
  return {
    revision: Number(rows[0]?.revision || 0),
    commentLabels: rows.filter((row: any) => row.key).map((row: any) => ({
      key: row.key, label: row.label, description: row.description, color: row.color,
      enabled: row.enabled === true, position: Number(row.position), usageCount: Number(row.usage_count),
    })),
  };
}

function staleCommentLabelRevision(expectedRevision: number, actualRevision: number): Response {
  return commentLabelError(409, 'stale_comment_label_registry', 'The comment label registry changed.', {
    expectedRevision, actualRevision, hint: 'Read or preview the registry again.',
  });
}

function normalizeCommentLabelDocument(value: unknown): { $schema: string; version: 1; commentLabels: CommentLabel[] } | Response {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return commentLabelError(400, 'comment_label_document_invalid', 'Document must be an object.', { field: 'document' });
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !['$schema', 'version', 'commentLabels'].includes(key));
  if (unknown) return commentLabelError(400, 'comment_label_document_invalid', 'Unknown document field.', { field: unknown });
  if (input.$schema !== 'toss/comment-labels@v1') return commentLabelError(400, 'comment_label_document_invalid', 'Unsupported comment label schema.', { field: '$schema' });
  if (input.version !== 1) return commentLabelError(400, 'comment_label_document_invalid', 'Unsupported comment label document version.', { field: 'version' });
  if (!Array.isArray(input.commentLabels)) return commentLabelError(400, 'comment_label_document_invalid', 'commentLabels must be an array.', { field: 'commentLabels' });
  const labels: CommentLabel[] = [];
  const keys = new Set<string>();
  const positions = new Set<number>();
  for (let index = 0; index < input.commentLabels.length; index++) {
    const parsed = normalizeCommentLabel(input.commentLabels[index], `commentLabels[${index}]`);
    if (parsed instanceof Response) return parsed;
    if (parsed.position < 1) return commentLabelError(400, 'comment_label_document_invalid', 'Position must be positive.', { field: `commentLabels[${index}].position` });
    if (keys.has(parsed.key)) return commentLabelError(400, 'comment_label_document_invalid', 'Comment label keys must be unique.', { field: `commentLabels[${index}].key` });
    if (positions.has(parsed.position)) return commentLabelError(400, 'comment_label_document_invalid', 'Included positions must be unique.', { field: `commentLabels[${index}].position` });
    keys.add(parsed.key); positions.add(parsed.position); labels.push(parsed);
  }
  return { $schema: 'toss/comment-labels@v1', version: 1, commentLabels: labels };
}

type OwnerCommentLabel = CommentLabel & { usageCount: number };

type CommentLabelApplyPreview = {
  creates: string[];
  updates: string[];
  reorders: string[];
  unchanged: string[];
  result: OwnerCommentLabel[];
  invalidPositionField?: string;
};

export function computeCommentLabelApply(current: OwnerCommentLabel[], included: CommentLabel[]): CommentLabelApplyPreview {
  const currentByKey = new Map(current.map((label) => [label.key, label]));
  const includedByKey = new Map(included.map((label) => [label.key, label]));
  const finalCount = current.length + included.filter((label) => !currentByKey.has(label.key)).length;
  const invalidIndex = included.findIndex((label) => label.position > finalCount);
  if (invalidIndex !== -1) {
    return { creates: [], updates: [], reorders: [], unchanged: [], result: [], invalidPositionField: `commentLabels[${invalidIndex}].position` };
  }
  const result: Array<OwnerCommentLabel | undefined> = new Array(finalCount);
  for (const label of included) {
    result[label.position - 1] = { ...label, usageCount: currentByKey.get(label.key)?.usageCount || 0 };
  }
  const omitted = current.filter((label) => !includedByKey.has(label.key));
  for (const label of omitted) {
    let slot = result.findIndex((value) => value === undefined);
    if (slot === -1) { slot = result.length; result.push(undefined); }
    result[slot] = { ...label };
  }
  const finalResult = result.filter((label): label is OwnerCommentLabel => Boolean(label)).map((label, index) => ({ ...label, position: index + 1 }));
  const creates = included.filter((label) => !currentByKey.has(label.key)).map((label) => label.key);
  const updates = included.filter((label) => {
    const before = currentByKey.get(label.key);
    return before && (before.label !== label.label || before.description !== label.description || before.color !== label.color || before.enabled !== label.enabled);
  }).map((label) => label.key);
  const reorders = finalResult.filter((label) => currentByKey.has(label.key) && currentByKey.get(label.key)!.position !== label.position).map((label) => label.key);
  const changed = new Set([...creates, ...updates, ...reorders]);
  const unchanged = finalResult.filter((label) => currentByKey.has(label.key) && !changed.has(label.key)).map((label) => label.key);
  return { creates, updates, reorders, unchanged, result: finalResult };
}

export function computeCommentLabelClear(current: OwnerCommentLabel[]): { deletes: string[]; disables: string[]; result: OwnerCommentLabel[] } {
  const deletes = current.filter((label) => label.usageCount === 0).map((label) => label.key);
  const disables = current.filter((label) => label.usageCount > 0 && label.enabled).map((label) => label.key);
  const result = current
    .filter((label) => label.usageCount > 0)
    .map((label, index) => ({ ...label, enabled: false, position: index + 1 }));
  return { deletes, disables, result };
}

async function handleCommentLabelRoutes(request: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/comment-labels')) return null;
  const validRoute = url.pathname === '/comment-labels'
    || url.pathname === '/comment-labels/order'
    || url.pathname === '/comment-labels/apply'
    || url.pathname === '/comment-labels/clear'
    || /^\/comment-labels\/[a-z0-9][a-z0-9-]{0,31}$/.test(url.pathname);
  if (!validRoute) return new Response('Not found', { status: 404 });
  const auth = await requireAdmin(request);
  if (auth instanceof Response) return auth;
  const sql = getSQL();
  if (request.method === 'GET' && url.pathname === '/comment-labels') return authJson(await readOwnerCommentLabels(sql));
  const body = request.method === 'POST' || request.method === 'PATCH' || request.method === 'PUT' || request.method === 'DELETE'
    ? await request.json().catch(() => null) : null;

  if (request.method === 'POST' && url.pathname === '/comment-labels') {
    const expected = expectedCommentLabelRevision(body); if (expected instanceof Response) return expected;
    const parsed = normalizeCommentLabel(body && typeof body === 'object' ? (body as any).commentLabel : null);
    if (parsed instanceof Response) return parsed;
    const results = await sql.transaction((tx: any) => [
      tx`SELECT revision FROM comment_label_registry_state WHERE singleton = true FOR UPDATE`,
      tx`WITH current AS (SELECT COUNT(*)::int AS count, EXISTS (SELECT 1 FROM comment_labels WHERE key = ${parsed.key}) AS exists FROM comment_labels WHERE key <> 'resolution'), decision AS (SELECT count, exists, CASE WHEN ${parsed.position} = 0 THEN count + 1 ELSE ${parsed.position} END AS position, ${parsed.position} = 0 OR ${parsed.position} BETWEEN 1 AND count + 1 AS position_valid FROM current), allowed AS (SELECT * FROM decision WHERE (SELECT revision FROM comment_label_registry_state WHERE singleton = true) = ${expected} AND NOT exists AND position_valid), shifted AS (UPDATE comment_labels SET position = position + 1 WHERE key <> 'resolution' AND position >= (SELECT position FROM allowed) RETURNING key), inserted AS (INSERT INTO comment_labels (key, label, description, color, enabled, position) SELECT ${parsed.key}, ${parsed.label}, ${parsed.description}, ${parsed.color}, ${parsed.enabled}, position FROM allowed WHERE (SELECT COUNT(*) FROM shifted) >= 0 RETURNING key), bumped AS (UPDATE comment_label_registry_state SET revision = revision + 1 WHERE singleton = true AND EXISTS (SELECT 1 FROM inserted) RETURNING revision) SELECT decision.exists, decision.position_valid, inserted.key, bumped.revision FROM decision LEFT JOIN inserted ON true LEFT JOIN bumped ON true`,
      tx`SELECT state.revision, label.key, label.label, label.description, label.color, label.enabled, label.position, (SELECT COUNT(*)::int FROM comment_messages message WHERE message.kind = label.key) AS usage_count FROM comment_label_registry_state state LEFT JOIN comment_labels label ON label.key <> 'resolution' WHERE state.singleton = true ORDER BY label.position, label.key`,
    ]);
    const actual = Number(results[0]?.[0]?.revision || 0);
    if (actual !== expected) return staleCommentLabelRevision(expected, actual);
    if (results[1]?.[0]?.exists) return commentLabelError(409, 'comment_label_exists', 'A comment label with this key already exists.', { key: parsed.key });
    if (!results[1]?.[0]?.position_valid) return commentLabelError(400, 'comment_label_invalid', 'Position is outside the registry.', { field: 'commentLabel.position' });
    const list = results[2];
    return authJson(ownerCommentLabelListFromRows(list), { status: 201 });
  }

  const keyMatch = url.pathname.match(/^\/comment-labels\/([a-z0-9][a-z0-9-]{0,31})$/);
  if (keyMatch && request.method === 'PATCH') {
    const key = keyMatch[1];
    if (key === 'resolution') return commentLabelError(400, 'reserved_comment_label', 'The resolution key is reserved.', { key });
    const expected = expectedCommentLabelRevision(body); if (expected instanceof Response) return expected;
    const changes = normalizeCommentLabelChanges(body && typeof body === 'object' ? (body as any).changes : null); if (changes instanceof Response) return changes;
    const patch = JSON.stringify(changes);
    const results = await sql.transaction((tx: any) => [
      tx`SELECT revision FROM comment_label_registry_state WHERE singleton = true FOR UPDATE`,
      tx`WITH current AS MATERIALIZED (SELECT *, COUNT(*) OVER ()::int AS count FROM comment_labels WHERE key <> 'resolution'), target AS MATERIALIZED (SELECT *, COALESCE((${patch}::jsonb->>'position')::int, position) AS new_position FROM current WHERE key = ${key}), decision AS MATERIALIZED (SELECT EXISTS (SELECT 1 FROM target) AS exists, COALESCE((SELECT new_position BETWEEN 1 AND count FROM target), false) AS position_valid, COALESCE((SELECT (${patch}::jsonb ? 'label' AND label IS DISTINCT FROM ${patch}::jsonb->>'label') OR (${patch}::jsonb ? 'description' AND description IS DISTINCT FROM ${patch}::jsonb->>'description') OR (${patch}::jsonb ? 'color' AND color IS DISTINCT FROM ${patch}::jsonb->>'color') OR (${patch}::jsonb ? 'enabled' AND enabled IS DISTINCT FROM (${patch}::jsonb->>'enabled')::boolean) OR (${patch}::jsonb ? 'position' AND position IS DISTINCT FROM new_position) FROM target), false) AS changed), moved AS (UPDATE comment_labels row SET position = CASE WHEN target.position < target.new_position THEN row.position - 1 WHEN target.new_position < target.position THEN row.position + 1 ELSE row.position END FROM target, decision WHERE row.key <> 'resolution' AND row.key <> ${key} AND decision.exists AND decision.position_valid AND decision.changed AND (SELECT revision FROM comment_label_registry_state WHERE singleton = true) = ${expected} AND ((target.position < target.new_position AND row.position > target.position AND row.position <= target.new_position) OR (target.new_position < target.position AND row.position >= target.new_position AND row.position < target.position)) RETURNING row.key), patched AS (UPDATE comment_labels row SET label = COALESCE(${patch}::jsonb->>'label', row.label), description = COALESCE(${patch}::jsonb->>'description', row.description), color = COALESCE(${patch}::jsonb->>'color', row.color), enabled = COALESCE((${patch}::jsonb->>'enabled')::boolean, row.enabled), position = target.new_position FROM target, decision WHERE row.key = ${key} AND decision.exists AND decision.position_valid AND decision.changed AND (SELECT revision FROM comment_label_registry_state WHERE singleton = true) = ${expected} AND (SELECT COUNT(*) FROM moved) >= 0 RETURNING row.key), bumped AS (UPDATE comment_label_registry_state SET revision = revision + 1 WHERE singleton = true AND EXISTS (SELECT 1 FROM patched) RETURNING revision) SELECT decision.*, bumped.revision FROM decision LEFT JOIN bumped ON true`,
      tx`SELECT state.revision, label.key, label.label, label.description, label.color, label.enabled, label.position, (SELECT COUNT(*)::int FROM comment_messages message WHERE message.kind = label.key) AS usage_count FROM comment_label_registry_state state LEFT JOIN comment_labels label ON label.key <> 'resolution' WHERE state.singleton = true ORDER BY label.position, label.key`,
    ]);
    const actual = Number(results[0]?.[0]?.revision || 0); if (actual !== expected) return staleCommentLabelRevision(expected, actual);
    if (!results[1]?.[0]?.exists) return commentLabelError(404, 'comment_label_not_found', 'Comment label not found.', { key });
    if (!results[1]?.[0]?.position_valid) return commentLabelError(400, 'comment_label_invalid', 'Position is outside the registry.', { field: 'changes.position' });
    return authJson(ownerCommentLabelListFromRows(results[2]));
  }

  if (keyMatch && request.method === 'DELETE') {
    const key = keyMatch[1];
    if (key === 'resolution') return commentLabelError(400, 'reserved_comment_label', 'The resolution key is reserved.', { key });
    const expected = expectedCommentLabelRevision(body); if (expected instanceof Response) return expected;
    const results = await sql.transaction((tx: any) => [
      tx`SELECT revision FROM comment_label_registry_state WHERE singleton = true FOR UPDATE`,
      tx`SELECT key, (SELECT COUNT(*)::int FROM comment_messages WHERE kind = ${key}) AS usage_count FROM comment_labels WHERE key = ${key} AND key <> 'resolution'`,
      tx`WITH removed AS (DELETE FROM comment_labels WHERE key = ${key} AND key <> 'resolution' AND (SELECT revision FROM comment_label_registry_state WHERE singleton = true) = ${expected} AND NOT EXISTS (SELECT 1 FROM comment_messages WHERE kind = ${key}) RETURNING position), repacked AS (UPDATE comment_labels SET position = position - 1 WHERE key <> 'resolution' AND position > (SELECT position FROM removed) RETURNING key), bumped AS (UPDATE comment_label_registry_state SET revision = revision + 1 WHERE singleton = true AND EXISTS (SELECT 1 FROM removed) AND (SELECT COUNT(*) FROM repacked) >= 0 RETURNING revision) SELECT removed.position, bumped.revision FROM removed, bumped`,
      tx`SELECT state.revision, label.key, label.label, label.description, label.color, label.enabled, label.position, (SELECT COUNT(*)::int FROM comment_messages message WHERE message.kind = label.key) AS usage_count FROM comment_label_registry_state state LEFT JOIN comment_labels label ON label.key <> 'resolution' WHERE state.singleton = true ORDER BY label.position, label.key`,
    ]);
    const actual = Number(results[0]?.[0]?.revision || 0); if (actual !== expected) return staleCommentLabelRevision(expected, actual);
    if (!results[1]?.[0]) return commentLabelError(404, 'comment_label_not_found', 'Comment label not found.', { key });
    const usageCount = Number(results[1][0].usage_count); if (usageCount) return commentLabelError(409, 'comment_label_in_use', 'The comment label is used by existing messages.', { key, usageCount, hint: 'Disable the label to preserve historical comments.' });
    return authJson(ownerCommentLabelListFromRows(results[3]));
  }

  if (request.method === 'PUT' && url.pathname === '/comment-labels/order') {
    const expected = expectedCommentLabelRevision(body); if (expected instanceof Response) return expected;
    const keys = body && typeof body === 'object' ? (body as any).keys : null;
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string') || new Set(keys).size !== keys.length) return commentLabelError(400, 'comment_label_order_invalid', 'keys must be an array of unique strings.', { field: 'keys' });
    const desired = keys.map((key: string, index: number) => ({ key, position: index + 1 }));
    const results = await sql.transaction((tx: any) => [
      tx`SELECT revision FROM comment_label_registry_state WHERE singleton = true FOR UPDATE`,
      tx`WITH requested AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(desired)}::jsonb) AS row(key text, position integer)), current AS (SELECT key, position FROM comment_labels WHERE key <> 'resolution'), decision AS (SELECT (SELECT COUNT(*) FROM requested) = (SELECT COUNT(*) FROM current) AND NOT EXISTS (SELECT key FROM requested EXCEPT SELECT key FROM current) AND NOT EXISTS (SELECT key FROM current EXCEPT SELECT key FROM requested) AS complete, EXISTS (SELECT 1 FROM requested JOIN current USING (key) WHERE requested.position <> current.position) AS changed), moved AS (UPDATE comment_labels target SET position = requested.position FROM requested, decision WHERE target.key = requested.key AND decision.complete AND decision.changed AND (SELECT revision FROM comment_label_registry_state WHERE singleton = true) = ${expected} RETURNING target.key), bumped AS (UPDATE comment_label_registry_state SET revision = revision + 1 WHERE singleton = true AND EXISTS (SELECT 1 FROM moved) RETURNING revision) SELECT decision.*, bumped.revision FROM decision LEFT JOIN bumped ON true`,
      tx`SELECT state.revision, label.key, label.label, label.description, label.color, label.enabled, label.position, (SELECT COUNT(*)::int FROM comment_messages message WHERE message.kind = label.key) AS usage_count FROM comment_label_registry_state state LEFT JOIN comment_labels label ON label.key <> 'resolution' WHERE state.singleton = true ORDER BY label.position, label.key`,
    ]);
    const actual = Number(results[0]?.[0]?.revision || 0); if (actual !== expected) return staleCommentLabelRevision(expected, actual);
    if (!results[1]?.[0]?.complete) return commentLabelError(400, 'comment_label_order_invalid', 'keys must contain every configurable comment label exactly once.', { field: 'keys' });
    return authJson(ownerCommentLabelListFromRows(results[2]));
  }

  if (request.method === 'POST' && url.pathname === '/comment-labels/apply') {
    const document = normalizeCommentLabelDocument(body && typeof body === 'object' ? (body as any).document : null); if (document instanceof Response) return document;
    const before = await readOwnerCommentLabels(sql);
    const preview = computeCommentLabelApply(before.commentLabels, document.commentLabels);
    if (url.searchParams.get('dryRun') === '1') {
      if (preview.invalidPositionField) return commentLabelError(400, 'comment_label_document_invalid', 'Position is outside the merged registry.', { field: preview.invalidPositionField });
      return authJson({ revision: before.revision, creates: preview.creates, updates: preview.updates, reorders: preview.reorders, unchanged: preview.unchanged, result: preview.result });
    }
    const expected = expectedCommentLabelRevision(body); if (expected instanceof Response) return expected;
    const desired = JSON.stringify(preview.result);
    const changed = preview.creates.length > 0 || preview.updates.length > 0 || preview.reorders.length > 0;
    const results = await sql.transaction((tx: any) => [
      tx`SELECT revision FROM comment_label_registry_state WHERE singleton = true FOR UPDATE`,
      tx`WITH desired AS (SELECT * FROM jsonb_to_recordset(${desired}::jsonb) AS row(key text, label text, description text, color text, enabled boolean, position integer)), written AS (INSERT INTO comment_labels (key,label,description,color,enabled,position) SELECT key,label,description,color,enabled,position FROM desired WHERE ${changed} AND (SELECT revision FROM comment_label_registry_state WHERE singleton = true) = ${expected} ON CONFLICT (key) DO UPDATE SET label=EXCLUDED.label,description=EXCLUDED.description,color=EXCLUDED.color,enabled=EXCLUDED.enabled,position=EXCLUDED.position RETURNING key), bumped AS (UPDATE comment_label_registry_state SET revision=revision+1 WHERE singleton=true AND EXISTS (SELECT 1 FROM written) RETURNING revision) SELECT ${changed} AS changed, bumped.revision FROM bumped RIGHT JOIN (SELECT 1) one ON true`,
      tx`SELECT state.revision, label.key, label.label, label.description, label.color, label.enabled, label.position, (SELECT COUNT(*)::int FROM comment_messages message WHERE message.kind = label.key) AS usage_count FROM comment_label_registry_state state LEFT JOIN comment_labels label ON label.key <> 'resolution' WHERE state.singleton = true ORDER BY label.position, label.key`,
    ]);
    const actual = Number(results[0]?.[0]?.revision || 0); if (actual !== expected) return staleCommentLabelRevision(expected, actual);
    if (preview.invalidPositionField) return commentLabelError(400, 'comment_label_document_invalid', 'Position is outside the merged registry.', { field: preview.invalidPositionField });
    return authJson(ownerCommentLabelListFromRows(results[2]));
  }

  if (request.method === 'POST' && url.pathname === '/comment-labels/clear') {
    const before = await readOwnerCommentLabels(sql);
    const preview = computeCommentLabelClear(before.commentLabels);
    if (url.searchParams.get('dryRun') === '1') {
      return authJson({ revision: before.revision, deletes: preview.deletes, disables: preview.disables, result: preview.result });
    }
    const expected = expectedCommentLabelRevision(body); if (expected instanceof Response) return expected;
    const results = await sql.transaction((tx: any) => [
      tx`SELECT revision FROM comment_label_registry_state WHERE singleton = true FOR UPDATE`,
      tx`WITH usage AS MATERIALIZED (SELECT label.key, EXISTS (SELECT 1 FROM comment_messages message WHERE message.kind = label.key) AS in_use FROM comment_labels label WHERE label.key <> 'resolution'), allowed AS MATERIALIZED (SELECT 1 WHERE (SELECT revision FROM comment_label_registry_state WHERE singleton = true) = ${expected}), removed AS (DELETE FROM comment_labels target USING usage, allowed WHERE target.key = usage.key AND NOT usage.in_use RETURNING target.key), survivors AS MATERIALIZED (SELECT label.key, row_number() OVER (ORDER BY label.position, label.key)::int AS position FROM comment_labels label JOIN usage ON usage.key = label.key AND usage.in_use), changed AS (UPDATE comment_labels target SET enabled = false, position = survivors.position FROM survivors, allowed WHERE target.key = survivors.key AND (target.enabled OR target.position <> survivors.position) RETURNING target.key), bumped AS (UPDATE comment_label_registry_state SET revision = revision + 1 WHERE singleton = true AND (EXISTS (SELECT 1 FROM removed) OR EXISTS (SELECT 1 FROM changed)) RETURNING revision) SELECT (SELECT COUNT(*) FROM removed)::int AS deletes, (SELECT COUNT(*) FROM changed)::int AS changes, bumped.revision FROM bumped RIGHT JOIN (SELECT 1) one ON true`,
      tx`SELECT state.revision, label.key, label.label, label.description, label.color, label.enabled, label.position, (SELECT COUNT(*)::int FROM comment_messages message WHERE message.kind = label.key) AS usage_count FROM comment_label_registry_state state LEFT JOIN comment_labels label ON label.key <> 'resolution' WHERE state.singleton = true ORDER BY label.position, label.key`,
    ]);
    const actual = Number(results[0]?.[0]?.revision || 0); if (actual !== expected) return staleCommentLabelRevision(expected, actual);
    return authJson(ownerCommentLabelListFromRows(results[2]));
  }

  return new Response('Method not allowed', { status: 405 });
}

export async function insertCommentReply(sql: any, params: { threadId: string; messageId: string; name: string; message: string; kind: string | null; now: number }) {
  const { threadId, messageId, name, message, kind, now } = params;
  return sql`
        WITH locked_state AS MATERIALIZED (
          SELECT contract_ready FROM comment_label_registry_state WHERE singleton = true FOR UPDATE
        ), target_thread AS MATERIALIZED (
          SELECT status FROM comment_threads
          WHERE id = ${threadId} AND deleted_at IS NULL
          FOR UPDATE
        ), valid_kind AS MATERIALIZED (
          SELECT 1 FROM locked_state
          WHERE ${kind}::text IS NULL OR (contract_ready AND EXISTS (SELECT 1 FROM comment_labels WHERE key = ${kind} AND enabled AND key <> 'resolution'))
        ), inserted_message AS (
          INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, kind, created_at, updated_at)
          SELECT ${messageId}, ${threadId}, ${NO_TOKEN}, ${name}, ${message}, ${kind}, ${now}, ${now}
          FROM valid_kind, target_thread WHERE target_thread.status <> 'resolved'
          RETURNING id
        ), touched AS (
          UPDATE comment_threads SET updated_at = ${now} WHERE id = ${threadId} AND EXISTS (SELECT 1 FROM inserted_message) RETURNING id
        ) SELECT
          EXISTS (SELECT 1 FROM target_thread) AS thread_exists,
          (SELECT status FROM target_thread) AS thread_status,
          EXISTS (SELECT 1 FROM valid_kind) AS kind_valid,
          EXISTS (SELECT 1 FROM inserted_message, touched) AS inserted
      `;
}

export async function readCommentSnapshot(sql: any, params: { artifactId: string; requestedVersion: number | null; pagePath: string; includeActivity: boolean }) {
  const { artifactId, requestedVersion, pagePath, includeActivity } = params;
  return sql`
        WITH registry AS MATERIALIZED (
          SELECT revision, contract_ready FROM comment_label_registry_state WHERE singleton = true
        ), artifact_context AS MATERIALIZED (
          SELECT current_version_id FROM artifacts WHERE id = ${artifactId}
        ), selected_version AS MATERIALIZED (
          SELECT ${requestedVersion}::int AS requested_seq,
            CASE WHEN ${requestedVersion}::int IS NULL THEN (SELECT current_version_id FROM artifact_context) ELSE (SELECT id FROM artifact_versions WHERE artifact_id = ${artifactId} AND seq = ${requestedVersion}) END AS version_id,
            CASE WHEN ${requestedVersion}::int IS NULL THEN true ELSE EXISTS (SELECT 1 FROM artifact_versions WHERE artifact_id = ${artifactId} AND seq = ${requestedVersion}) END AS found
        ), selected_threads AS MATERIALIZED (
          SELECT thread.* FROM comment_threads thread, selected_version selected
          WHERE thread.artifact_id = ${artifactId} AND thread.deleted_at IS NULL
            AND (CASE WHEN selected.requested_seq IS NULL AND selected.version_id IS NULL THEN true ELSE thread.version_id = selected.version_id END)
        ), hydrated AS MATERIALIZED (
          SELECT thread.id, thread.page_path, thread.created_at,
            (to_jsonb(thread) - 'created_by_token_hash' - 'anchor_json') || jsonb_build_object(
              'anchor', CASE WHEN thread.anchor_json IS NULL THEN NULL ELSE thread.anchor_json::jsonb END,
              'can_delete', true, 'can_resolve', true,
              'messages', COALESCE((
                SELECT jsonb_agg((to_jsonb(message) - 'author_token_hash') || jsonb_build_object(
                  'can_edit', message.deleted_at IS NULL AND thread.status <> 'resolved',
                  'can_delete', message.deleted_at IS NULL AND NOT (message.kind = 'resolution' AND thread.status = 'resolved')
                ) ORDER BY message.created_at ASC)
                FROM comment_messages message WHERE message.thread_id = thread.id
              ), '[]'::jsonb)
            ) AS value
          FROM selected_threads thread
        ), labels AS MATERIALIZED (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('key', label.key, 'label', label.label, 'description', label.description, 'color', label.color, 'enabled', label.enabled, 'position', label.position) ORDER BY label.position, label.key), '[]'::jsonb) AS value
          FROM comment_labels label, registry WHERE registry.contract_ready AND label.key <> 'resolution'
        )
        SELECT registry.revision, selected.found, selected.version_id,
          (SELECT COALESCE(MAX(seq), 0) FROM artifact_versions WHERE artifact_id = ${artifactId}) AS max_version,
          labels.value AS comment_labels,
          COALESCE(jsonb_agg(hydrated.value ORDER BY hydrated.created_at DESC) FILTER (WHERE hydrated.id IS NOT NULL AND (${requestedVersion}::int IS NOT NULL OR hydrated.page_path = ${pagePath})), '[]'::jsonb) AS threads,
          COALESCE(jsonb_agg(hydrated.value ORDER BY hydrated.created_at DESC) FILTER (WHERE hydrated.id IS NOT NULL AND (${requestedVersion}::int IS NOT NULL OR ${includeActivity} OR hydrated.page_path = ${pagePath})), '[]'::jsonb) AS activity_threads
        FROM registry CROSS JOIN selected_version selected CROSS JOIN labels LEFT JOIN hydrated ON true
        GROUP BY registry.revision, selected.found, selected.version_id, labels.value
      `;
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

    const commentLabelResponse = await handleCommentLabelRoutes(request, url);
    if (commentLabelResponse) return commentLabelResponse;

    // Seed admin user in multi-tenant mode if table is empty
    if (MULTI_TENANT && OWNER_TOKEN) {
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
          if (contentChanged || force) {
            // Stage immutable content under the candidate version. It is not
            // reachable from serveArtifact until mintVersion serializes ownership,
            // copies comments, updates metadata, and advances the pointer last.
            const candidateVersionId = generateId();
            const stagedPath = versionEntryBlobPath(existingId, candidateVersionId);
            await blobPut(stagedPath, html, 'text/html');
            try {
              await mintVersion(existingId, newHash, now, candidateVersionId, {
                name,
                sizeBytes,
                expiresAt: newExpiresAt,
                passwordHash: newPasswordHash,
              });
            } catch (error) {
              await blobDelete(stagedPath).catch(() => {});
              throw error;
            }
          } else {
            await sql`UPDATE artifacts SET name = ${name}, size_bytes = ${sizeBytes}, expires_at = ${newExpiresAt}, password_epoch = password_epoch + CASE WHEN password_hash IS DISTINCT FROM ${newPasswordHash} THEN 1 ELSE 0 END, password_hash = ${newPasswordHash} WHERE id = ${existingId}`;
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

      const expiresAt = expiresSeconds === 0 ? PERMANENT : (now + expiresSeconds);
      await sql`INSERT INTO artifacts (id, slug, name, size_bytes, created_at, expires_at, token_hash, password_hash, comments_enabled) VALUES (${id}, ${slug}, ${name}, ${sizeBytes}, ${now}, ${expiresAt}, ${auth.tokenHash}, ${passwordHash}, ${commentsEnabled})`;
      const initialVersionId = generateId();
      const stagedPath = versionEntryBlobPath(id, initialVersionId);
      await blobPut(stagedPath, html, 'text/html');
      try {
        await mintVersion(id, await sha256(html), now, initialVersionId);
      } catch (error) {
        await blobDelete(stagedPath).catch(() => {});
        await sql`DELETE FROM artifacts WHERE id = ${id} AND current_version_id IS NULL`.catch(() => {});
        throw error;
      }

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
      const versionParam = url.searchParams.get('version');
      const requestedVersion = versionParam === null ? null : Number(versionParam);
      if (requestedVersion !== null && (!Number.isInteger(requestedVersion) || requestedVersion < 1)) return new Response('version must be a positive integer', { status: 400 });
      // The complete revision/labels/threads envelope is intentionally assembled by
      // one SQL statement, giving every response one PostgreSQL MVCC snapshot.
      const snapshotRows = await readCommentSnapshot(sql, { artifactId, requestedVersion, pagePath, includeActivity });
      const snapshot = snapshotRows[0];
      if (requestedVersion !== null && !snapshot.found) {
        const max = Number(snapshot.max_version || 0);
        return authJson({ error: 'version_not_found', seq: requestedVersion, hint: max ? `this share has versions 1-${max}` : 'this share has no versions yet' }, { status: 404 });
      }
      return authJson({
        ...(requestedVersion === null ? { pagePath } : { version: requestedVersion, versionId: snapshot.version_id }),
        viewer: { authenticated: true, label: null },
        commentLabelRevision: Number(snapshot.revision),
        commentLabels: snapshot.comment_labels || [],
        threads: snapshot.threads || [],
        activityThreads: snapshot.activity_threads || [],
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
      const kind = normalizeMessageKind(reqBody);
      if (kind instanceof Response) return kind;

      const sql = getSQL();
      const now = Math.floor(Date.now() / 1000);
      const threadId = generateId();
      const messageId = generateId();
      const inserted = await sql`
        WITH locked_state AS MATERIALIZED (
          SELECT contract_ready FROM comment_label_registry_state WHERE singleton = true FOR UPDATE
        ), valid_kind AS MATERIALIZED (
          SELECT 1 FROM locked_state
          WHERE ${kind}::text IS NULL OR (contract_ready AND EXISTS (SELECT 1 FROM comment_labels WHERE key = ${kind} AND enabled AND key <> 'resolution'))
        ), inserted_thread AS (
          INSERT INTO comment_threads (id, artifact_id, version_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, created_at, updated_at)
          SELECT ${threadId}, ${artifactId}, artifact.current_version_id, ${normalized.pagePath}, ${NO_TOKEN}, ${name}, ${normalized.scopeType}, ${normalized.anchorJson}, 'open', ${now}, ${now}
          FROM artifacts artifact, valid_kind WHERE artifact.id = ${artifactId} RETURNING id
        ), inserted_message AS (
          INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, kind, created_at, updated_at)
          SELECT ${messageId}, id, ${NO_TOKEN}, ${name}, ${normalized.body}, ${kind}, ${now}, ${now} FROM inserted_thread RETURNING id
        ) SELECT inserted_thread.id, inserted_message.id AS message_id FROM inserted_thread, inserted_message
      `;
      if (!inserted[0]) return new Response('Invalid comment kind', { status: 400 });
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
            kind,
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
      const kind = normalizeMessageKind(reqBody);
      if (kind instanceof Response) return kind;

      const now = Math.floor(Date.now() / 1000);
      const messageId = generateId();
      const inserted = await insertCommentReply(sql, { threadId, messageId, name, message, kind, now });
      if (!inserted[0]?.thread_exists) return new Response('Not found', { status: 404 });
      if (inserted[0].thread_status === 'resolved') return new Response('Resolved comments cannot receive replies', { status: 409 });
      if (!inserted[0].kind_valid || !inserted[0].inserted) return new Response('Invalid comment kind', { status: 400 });
      return authJson({
        id: messageId,
        threadId,
        threadUpdatedAt: now,
        message: {
          id: messageId,
          thread_id: threadId,
          author_label: name,
          body: message,
          kind,
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
      const resolverName = normalizeName(rb);
      if (resolverName instanceof Response) return resolverName;

      const now = Math.floor(Date.now() / 1000);
      let resolutionMessage = null;
      if (action === 'resolve') {
        const resolutionBody = normalizeMessageInput(rb);
        if (resolutionBody instanceof Response) return resolutionBody;
        const messageId = generateId();
        const transition = await sql`
          WITH transitioned AS (
            UPDATE comment_threads
            SET status = 'resolved', resolved_by_token_hash = ${NO_TOKEN}, resolved_by_label = ${resolverName}, resolved_at = ${now}, updated_at = ${now}
            WHERE id = ${threadId} AND status = 'open' AND deleted_at IS NULL
            RETURNING id
          ), inserted AS (
            INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, kind, created_at, updated_at)
            SELECT ${messageId}, id, ${NO_TOKEN}, ${resolverName}, ${resolutionBody}, 'resolution', ${now}, ${now}
            FROM transitioned
            RETURNING id
          )
          SELECT id FROM inserted
        `;
        if (!transition[0]) return new Response('Thread is already resolved', { status: 409 });
        resolutionMessage = {
          id: messageId,
          thread_id: threadId,
          author_label: resolverName,
          body: resolutionBody,
          kind: 'resolution',
          created_at: now,
          updated_at: now,
          deleted_at: null,
          can_edit: false,
          can_delete: false,
        };
      } else {
        await sql`UPDATE comment_threads SET status = 'open', resolved_by_token_hash = NULL, resolved_by_label = NULL, resolved_at = NULL, updated_at = ${now} WHERE id = ${threadId}`;
      }
      return authJson({
        id: threadId,
        status: action === 'resolve' ? 'resolved' : 'open',
        resolvedByLabel: action === 'resolve' ? resolverName : null,
        resolvedAt: action === 'resolve' ? now : null,
        updatedAt: now,
        ...(action === 'resolve' ? { message: resolutionMessage } : {}),
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
      const rows = await sql`SELECT m.thread_id, m.author_token_hash, m.kind, m.deleted_at, t.artifact_id, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE m.id = ${messageId} AND t.deleted_at IS NULL`;
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

      if (rows[0].kind === 'resolution' && rows[0].thread_status === 'resolved') {
        return new Response('Resolution messages cannot be deleted while the thread is resolved', { status: 409 });
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
      const rows = await sql`SELECT id, expires_at, password_hash, password_epoch FROM artifacts WHERE slug = ${slug}`;

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
        // Fail closed if the signing key is too weak to issue a session.
        if (!passwordSessionSecretUsable(JWT_SECRET)) {
          return new Response('Server misconfigured', { status: 500 });
        }
        const cookieName = `toss_pwd_${slug}`;
        const sessionCookie = readCookie(request.headers.get('Cookie'), cookieName);
        const rowEpoch = Number.isSafeInteger(Number(rows[0].password_epoch)) ? Number(rows[0].password_epoch) : 0;
        const hasSession = sessionCookie
          ? await verifyPasswordSession(sessionCookie, rows[0].id, rowEpoch, JWT_SECRET)
          : false;

        if (!hasSession) {
          if (request.method === 'POST') {
            const formData = await request.formData();
            const password = formData.get('password') as string;
            const providedHash = password ? await sha256(password + rows[0].id) : '';

            if (constantTimeEqual(providedHash, rows[0].password_hash)) {
              // Correct password: redirect with a signed session cookie scoped
              // to this share's lifetime (capped at 24h; never past expiry).
              const { token, maxAge } = await issuePasswordSession(rows[0].id, rows[0].expires_at, JWT_SECRET, rowEpoch);
              return new Response(null, {
                status: 302,
                headers: {
                  Location: `${url.origin}/s/${slug}/`,
                  'Set-Cookie': `${cookieName}=${token}; Path=/s/${slug}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
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
