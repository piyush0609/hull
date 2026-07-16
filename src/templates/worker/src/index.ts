import { signJWT, verifyJWT } from './jwt.js';

export interface Env {
  TOSS_KV: KVNamespace;
  TOSS_DB: D1Database;
  JWT_SECRET: string;
  OWNER_TOKEN: string;
  MULTI_TENANT?: string;
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
  const cap = now + 24 * 3600; // grants live at most 24h, never past artifact expiry
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

async function resolveUser(request: Request, env: Env): Promise<AuthUser | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const tokenHash = await sha256(token);

  // Always check admin token first
  const adminHash = await sha256(env.OWNER_TOKEN);
  if (constantTimeEqual(tokenHash, adminHash)) {
    return { tokenHash, isAdmin: true, label: 'admin' };
  }

  // Multi-tenant mode: check registered users table
  if (env.MULTI_TENANT === 'true') {
    const row = await env.TOSS_DB.prepare('SELECT is_admin, label FROM users WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{ is_admin: number; label?: string }>();
    if (row) {
      return { tokenHash, isAdmin: row.is_admin === 1, label: row.label || 'member' };
    }
  }

  return null;
}

function requireUser(request: Request, env: Env): Promise<AuthUser | Response> {
  return resolveUser(request, env).then((u) => u ?? new Response('Unauthorized', { status: 401 }));
}

function requireAdmin(request: Request, env: Env): Promise<AuthUser | Response> {
  return resolveUser(request, env).then((u) => {
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
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Comment-API contract: the artifact must have comments enabled (per-share
// opt-in) AND still be live (not revoked/expired) AND the caller must present
// either a valid comment grant (a distinct aud:"comment" token issued at serve
// time — the plain viewer/legacy token has no aud and is rejected here) OR the
// owner token (Bearer) for programmatic/cloud access. Returns true | Response.
async function requireCommentAccess(request: Request, env: Env, artifactId: string): Promise<true | Response> {
  const row = await env.TOSS_DB.prepare('SELECT comments_enabled, expires_at, password_epoch FROM artifacts WHERE id = ?')
    .bind(artifactId)
    .first<{ comments_enabled: number; expires_at: number; password_epoch: number | null }>();
  // A null row also covers a missing/revoked artifact.
  if (!row || !row.comments_enabled) return new Response('Not found', { status: 404 });
  if (isArtifactExpired(row.expires_at)) return new Response('Link expired', { status: 410 });

  // Owner token is a first-class reader/writer (programmatic/cloud access).
  const user = await resolveUser(request, env);
  if (user?.isAdmin) return true;

  // Otherwise require the comment grant. The distinct aud breaks the conflation
  // with the plain viewer token; pwd_epoch ties it to the current password.
  const token = request.headers.get('X-Toss-Viewer');
  if (!token) return new Response('Missing comment grant', { status: 401 });
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
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

// The commenter's display name — a self-entered claim (not verified), stored
// immutably as author_label and HTML-escaped on render. Identity needs no toss
// token or password; the grant already proved page access.
function normalizeName(body: unknown): string | Response {
  const raw = body && typeof body === 'object' && typeof (body as { name?: unknown }).name === 'string'
    ? (body as { name: string }).name.trim()
    : '';
  if (!raw) return new Response('Name is required', { status: 400 });
  if (raw.length > 80) return new Response('Name is too long', { status: 400 });
  return raw;
}

// Legacy token columns are NOT NULL but identity is now author_label; write a
// sentinel so old (token-based) rows and new (name-based) rows coexist with no
// schema change.
const NO_TOKEN = '';

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
  const storageKey = 'toss-comment-token:' + cfg.artifactId;
  const state = {
    token: localStorage.getItem(storageKey) || '',
    threads: [],
    activeThreadId: '',
    pendingScope: 'artifact',
    pendingAnchor: null,
    pendingRects: [],
    currentLabel: '',
    busy: false,
    loaded: false,
    loading: false,
    unreadCount: 0,
    activityFeed: [],
    lastDigest: '',
    activityThreads: [],
    pollTimer: null,
    replyThreadId: '',
    replyDraft: '',
  };

  const esc = (text) => String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const root = document.getElementById('toss-comments-root');
  const targetStorageKey = 'toss-comment-target:' + cfg.artifactId;
  root.innerHTML = '<style>' +
    '#toss-comments-root{position:fixed;top:0;right:0;z-index:2147483647;font-family:system-ui,-apple-system,sans-serif;color:#111827}' +
    '#toss-comments-root *{box-sizing:border-box}' +
    '.toss-comments-shell{display:flex;align-items:flex-start;gap:10px;margin:12px 0 0 auto}' +
    '.toss-comments-toggle,.toss-comments-notify-toggle{background:#111827;color:#fff;border:none;border-radius:999px;padding:10px 14px;cursor:pointer;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.18)}' +
    '.toss-comments-notify-toggle{position:relative;padding:10px 12px;min-width:44px}' +
    '.toss-comments-notify-toggle.has-unread{background:#1d4ed8;box-shadow:0 10px 28px rgba(37,99,235,.26)}' +
    '.toss-comments-badge{display:none;margin-left:8px;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#facc15;color:#111827;font-size:11px;font-weight:800;line-height:18px;text-align:center}' +
    '.toss-comments-notify-toggle .toss-comments-badge{position:absolute;top:-6px;right:-2px;margin-left:0}' +
    '.toss-comments-notify-toggle.has-unread .toss-comments-badge{display:inline-block}' +
    '.toss-comments-panel{width:360px;max-width:calc(100vw - 24px);height:100vh;background:#fff;border-left:1px solid #e5e7eb;box-shadow:-12px 0 32px rgba(15,23,42,.12);display:none;flex-direction:column}' +
    '.toss-comments-panel.open{display:flex}' +
    '.toss-notify-panel{position:fixed;top:58px;right:12px;width:320px;max-width:calc(100vw - 24px);max-height:320px;overflow:auto;background:#fff;border:1px solid #dbeafe;border-radius:16px;box-shadow:0 20px 40px rgba(15,23,42,.18);padding:10px;display:none;z-index:2147483647}' +
    '.toss-notify-panel.open{display:block}' +
    '.toss-comments-header{padding:16px;border-bottom:1px solid #e5e7eb;background:#f8fafc;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}' +
    '.toss-comments-header-copy{min-width:0}' +
    '.toss-comments-close{border:none;background:#e2e8f0;color:#0f172a;border-radius:999px;padding:8px 10px;font-size:12px;font-weight:700;cursor:pointer}' +
    '.toss-comments-title{font-weight:700;font-size:16px;margin:0 0 4px}' +
    '.toss-comments-sub{font-size:12px;color:#64748b}' +
    '.toss-comments-body{padding:16px;overflow:auto;display:flex;flex-direction:column;gap:12px}' +
    '.toss-comments-card{border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#fff}' +
    '.toss-comments-card.resolved{background:#f8fafc}' +
    '.toss-comments-card.focused{border-color:#0f172a;box-shadow:0 0 0 3px rgba(15,23,42,.12)}' +
    '.toss-comments-meta,.toss-comments-message-meta{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:#64748b;margin-bottom:8px}' +
    '.toss-comments-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}' +
    '.toss-comments-actions button,.toss-comments-auth button,.toss-comments-context button{background:#fff;border:1px solid #d1d5db;border-radius:10px;padding:7px 11px;font-size:12px;font-weight:600;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,border-color .15s ease,background .15s ease}' +
    '.toss-comments-actions button:hover,.toss-comments-auth button:hover,.toss-comments-context button:hover{transform:translateY(-1px);box-shadow:0 10px 20px rgba(15,23,42,.08);border-color:#94a3b8}' +
    '.toss-comments-actions button.primary{background:linear-gradient(135deg,#111827,#2563eb);color:#fff;border-color:#111827;box-shadow:0 10px 22px rgba(37,99,235,.16)}' +
    '.toss-comments-actions button.primary:hover{box-shadow:0 14px 26px rgba(37,99,235,.22)}' +
    '.toss-comments-actions button.warn{color:#b91c1c;border-color:#fecaca;background:linear-gradient(180deg,#fff5f5,#ffe4e6)}' +
    '.toss-comments-actions button[data-action=\"reply-thread\"],.toss-comments-actions button[data-action=\"reopen-thread\"],.toss-comments-actions button[data-action=\"edit-message\"]{background:linear-gradient(180deg,#f8fbff,#eef4ff);border-color:#bfdbfe;color:#1d4ed8}' +
    '.toss-comments-actions button[data-action=\"resolve-thread\"]{background:linear-gradient(135deg,#0f766e,#10b981);border-color:#0f766e;color:#fff;box-shadow:0 10px 22px rgba(16,185,129,.18)}' +
    '.toss-comments-actions button[data-action=\"resolve-thread\"]:hover{box-shadow:0 14px 26px rgba(16,185,129,.24)}' +
    '.toss-comments-submit{width:100%;border:none;border-radius:12px;padding:12px 14px;background:linear-gradient(135deg,#2563eb,#111827);color:#fff;font-size:13px;font-weight:700;letter-spacing:.01em;cursor:pointer;box-shadow:0 14px 28px rgba(37,99,235,.22);transition:transform .15s ease,box-shadow .15s ease}' +
    '.toss-comments-submit:hover{transform:translateY(-1px);box-shadow:0 18px 34px rgba(37,99,235,.28)}' +
    '.toss-comments-submit:disabled{opacity:.65;transform:none;box-shadow:none;cursor:not-allowed}' +
    '.toss-comments-input,.toss-comments-auth input,.toss-comments-textarea{width:100%;border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:13px;background:#fff}' +
    '.toss-comments-textarea{min-height:92px;resize:vertical}' +
    '.toss-comments-auth{display:flex;gap:8px;flex-wrap:wrap}' +
    '.toss-comments-auth input{flex:1 1 180px}' +
    '.toss-comments-status{font-size:12px;color:#475569;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:10px;padding:10px}' +
    '.toss-comments-notifications-title{font-size:11px;font-weight:800;letter-spacing:.08em;color:#1d4ed8;text-transform:uppercase;padding:2px 4px 8px}' +
    '.toss-comments-section-title{font-size:11px;font-weight:800;letter-spacing:.08em;color:#64748b;text-transform:uppercase;padding:2px 4px 4px}' +
    '.toss-comments-notification{width:100%;text-align:left;border:none;background:#fff;border-radius:10px;padding:10px 12px;cursor:pointer;box-shadow:0 6px 14px rgba(15,23,42,.06);margin-bottom:8px}' +
    '.toss-comments-notification:last-child{margin-bottom:0}' +
    '.toss-comments-notification:hover{transform:translateY(-1px);box-shadow:0 10px 20px rgba(15,23,42,.1)}' +
    '.toss-comments-notification.unread{background:#dbeafe;box-shadow:inset 0 0 0 1px #93c5fd,0 6px 14px rgba(15,23,42,.06)}' +
    '.toss-comments-notification strong{display:block;font-size:12px;color:#0f172a;margin-bottom:4px}' +
    '.toss-comments-notification span{display:block;font-size:12px;color:#475569;line-height:1.4}' +
    '.toss-comments-context{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border:1px solid #dbe4f0;border-radius:10px;background:#fff;font-size:12px;color:#334155}' +
    '.toss-comments-context strong{display:block;color:#0f172a;font-size:12px}' +
    '.toss-comments-context span{display:block;color:#64748b;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}' +
    '.toss-comments-thread-list{display:flex;flex-direction:column;gap:12px}' +
    '.toss-comment-draft-highlight{position:absolute;z-index:2147483645;background:rgba(250,204,21,.35);outline:1px solid rgba(202,138,4,.8);border-radius:4px;pointer-events:none}' +
    '.toss-comment-focus-highlight{position:absolute;z-index:2147483644;background:rgba(59,130,246,.16);outline:2px solid rgba(37,99,235,.8);border-radius:6px;pointer-events:none}' +
    '.toss-comment-pin{position:absolute;z-index:2147483646;width:18px;height:18px;border-radius:999px;background:#111827;color:#fff;border:2px solid #fff;box-shadow:0 8px 24px rgba(15,23,42,.25);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer}' +
    '.toss-comment-pin.active{background:#2563eb}' +
    '.toss-comment-chip{position:absolute;z-index:2147483647;border:none;border-radius:999px;background:#111827;color:#fff;padding:8px 12px;font-size:12px;font-weight:600;box-shadow:0 10px 30px rgba(15,23,42,.28);cursor:pointer}' +
    '.toss-comments-thread-anchor{font-size:12px;color:#475569;background:#f8fafc;border-radius:8px;padding:8px;margin-bottom:8px}' +
    '.toss-comments-message{padding:8px 0;border-top:1px solid #f1f5f9}' +
    '.toss-comments-message:first-child{border-top:none;padding-top:0}' +
    '.toss-comments-message.parent{padding:10px 12px 12px;border:1px solid #dbeafe;border-radius:12px;background:linear-gradient(180deg,#ffffff,#f8fbff)}' +
    '.toss-comments-message.reply{margin-left:18px;padding-left:12px;border-left:3px solid #dbeafe}' +
    '.toss-comments-replying-to{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;border-radius:999px;padding:4px 8px;margin-bottom:8px}' +
    '.toss-comments-empty{font-size:13px;color:#64748b}' +
    '</style>' +
    '<div class="toss-comments-shell">' +
      '<button class="toss-comments-notify-toggle" type="button" aria-label="Open notifications">🔔 <span class="toss-comments-badge">0</span></button>' +
      '<button class="toss-comments-toggle" type="button">Comments</button>' +
      '<div class="toss-notify-panel" aria-label="Notifications"><div class="toss-comments-notifications-title">Notifications</div><div class="toss-comments-notification-list"></div></div>' +
      '<aside class="toss-comments-panel" aria-label="Comments sidebar">' +
        '<div class="toss-comments-header"><div class="toss-comments-header-copy"><div class="toss-comments-title">Comments</div><div class="toss-comments-sub">Discuss this shared page</div></div><button class="toss-comments-close" type="button" aria-label="Close comments">Close</button></div>' +
        '<div class="toss-comments-body">' +
          '<div class="toss-comments-auth">' +
            '<input class="toss-comments-token" placeholder="Paste your toss token to comment" />' +
            '<button class="toss-comments-save-token primary" type="button">Save Token</button>' +
            '<button class="toss-comments-clear-token" type="button">Clear</button>' +
          '</div>' +
          '<div class="toss-comments-status"></div>' +
          '<div class="toss-comments-section-title">Threads</div>' +
          '<div class="toss-comments-context">' +
            '<div><strong>Comment target</strong><span class="toss-comments-context-label">Whole page</span></div>' +
            '<button class="toss-comments-context-clear" type="button">Use whole page</button>' +
          '</div>' +
          '<textarea class="toss-comments-textarea" placeholder="Write a comment..."></textarea>' +
          '<button class="toss-comments-submit primary" type="button">Post Comment →</button>' +
          '<div class="toss-comments-thread-list"></div>' +
        '</div>' +
      '</aside>' +
    '</div>' +
    '</div>';

  const panel = root.querySelector('.toss-comments-panel');
  const toggle = root.querySelector('.toss-comments-toggle');
  const notifyToggle = root.querySelector('.toss-comments-notify-toggle');
  const badge = root.querySelector('.toss-comments-badge');
  const status = root.querySelector('.toss-comments-status');
  const notifications = root.querySelector('.toss-notify-panel');
  const notificationList = root.querySelector('.toss-comments-notification-list');
  const tokenInput = root.querySelector('.toss-comments-token');
  const textarea = root.querySelector('.toss-comments-textarea');
  const submitButton = root.querySelector('.toss-comments-submit');
  const list = root.querySelector('.toss-comments-thread-list');
  const contextLabel = root.querySelector('.toss-comments-context-label');
  tokenInput.value = state.token;
  const currentPagePath = cfg.currentPagePath || 'index.html';
  const currentPageLabel = () => {
    const tail = (currentPagePath.split('/').pop() || 'index.html').replace(/\.html?$/i, '');
    if (!tail || tail === 'index') return 'Overview';
    return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  };
  const buildCommentsPath = (includeActivity = false) => {
    const params = new URLSearchParams();
    params.set('pagePath', currentPagePath);
    if (includeActivity) params.set('includeActivity', '1');
    return '/artifacts/' + cfg.artifactId + '/comment-threads?' + params.toString();
  };
  const buildPageUrl = (pagePath) => {
    if (!pagePath || pagePath === 'index.html') return cfg.origin + cfg.artifactBasePath;
    return cfg.origin + cfg.artifactBasePath + pagePath;
  };
  const setPendingTarget = (target) => {
    try { sessionStorage.setItem(targetStorageKey, JSON.stringify(target)); } catch {}
  };
  const readPendingTarget = () => {
    try {
      const raw = sessionStorage.getItem(targetStorageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const consumePendingTarget = () => {
    const parsed = readPendingTarget();
    if (!parsed || parsed.pagePath !== currentPagePath) return null;
    try { sessionStorage.removeItem(targetStorageKey); } catch {}
    return parsed;
  };

  const selectorFor = (el) => {
    if (!(el instanceof Element)) return 'unknown';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift('#' + node.id);
        break;
      }
      const parent = node.parentElement;
      let part = node.tagName.toLowerCase();
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(node) + 1;
          part += ':nth-of-type(' + index + ')';
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ') || 'unknown';
  };
  const selectionRectFromAnchor = (anchor) => {
    if (!anchor || !anchor.selector || !anchor.selectedText) return null;
    const host = document.querySelector(anchor.selector);
    if (!(host instanceof Element)) return null;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let node;
    let fullText = '';
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      if (!text) continue;
      textNodes.push({ node, start: fullText.length, end: fullText.length + text.length });
      fullText += text;
    }
    if (!fullText) return null;
    const selectedText = String(anchor.selectedText);
    let startIndex = fullText.indexOf(selectedText);
    if (startIndex < 0 && anchor.textSnippet) {
      startIndex = fullText.indexOf(String(anchor.textSnippet));
    }
    if (startIndex < 0) return null;
    const endIndex = startIndex + selectedText.length;
    const startNodeMeta = textNodes.find((item) => startIndex >= item.start && startIndex <= item.end);
    const endNodeMeta = textNodes.find((item) => endIndex >= item.start && endIndex <= item.end) || textNodes[textNodes.length - 1];
    if (!startNodeMeta || !endNodeMeta) return null;
    const range = document.createRange();
    range.setStart(startNodeMeta.node, Math.max(0, startIndex - startNodeMeta.start));
    range.setEnd(endNodeMeta.node, Math.max(0, Math.min((endNodeMeta.node.textContent || '').length, endIndex - endNodeMeta.start)));
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return {
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const rectFromAnchor = (anchor) => {
    if (!anchor) return null;
    if (anchor.selectedText) {
      const selectionRect = selectionRectFromAnchor(anchor);
      if (selectionRect) return selectionRect;
    }
    if (anchor.selector) {
      const node = document.querySelector(anchor.selector);
      if (node instanceof Element) {
        const rect = node.getBoundingClientRect();
        return {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }
    }
    return anchor.rect || null;
  };

  const setStatus = (message) => { status.textContent = message; };
  const threadsDigest = (threads) => JSON.stringify((threads || []).map((thread) => ({
    id: thread.id,
    status: thread.status,
    updated_at: thread.updated_at,
    deleted_at: thread.deleted_at || null,
    resolved_by_label: thread.resolved_by_label || '',
    messages: (thread.messages || []).map((message) => ({
      id: message.id,
      author_label: message.author_label,
      body: message.body,
      updated_at: message.updated_at,
      deleted_at: message.deleted_at || null,
    })),
  })));
  const shortSnippet = (text) => {
    const value = String(text || '').trim();
    if (!value) return 'No preview';
    return value.length > 10 ? value.slice(0, 10) + '...' : value;
  };
  const replySnippet = (text) => {
    const value = String(text || '').trim();
    if (!value) return 'No preview';
    return value.length > 72 ? value.slice(0, 72) + '...' : value;
  };
  const renderNotifications = () => {
    if (!state.activityFeed.length) {
      notifications.classList.remove('open');
      notificationList.innerHTML = '';
      return;
    }
    notificationList.innerHTML = state.activityFeed.map((activity, index) =>
      '<button type="button" class="toss-comments-notification' + (activity.unread ? ' unread' : '') + '" data-thread-id="' + esc(activity.threadId || '') + '" data-activity-id="' + esc(activity.id || '') + '" data-page-path="' + esc(activity.pagePath || 'index.html') + '">' +
        '<strong>' + esc(String(index + 1) + '. ' + (activity.actor || 'Someone') + ' · ' + (activity.pageLabel || 'Overview')) + '</strong>' +
        '<span>' + esc(activity.snippet || activity.message || 'New activity') + '</span>' +
      '</button>'
    ).join('');
  };
  const recalcUnread = () => {
    state.unreadCount = state.activityFeed.filter((item) => item.unread).length;
  };
  const renderUnread = () => {
    recalcUnread();
    const hasUnread = state.unreadCount > 0;
    notifyToggle.classList.toggle('has-unread', hasUnread);
    badge.textContent = String(state.unreadCount);
  };
  const markThreadNotificationsRead = (threadId) => {
    if (!threadId) return;
    state.activityFeed = state.activityFeed.map((item) => item.threadId === threadId ? { ...item, unread: false } : item);
    renderUnread();
    renderNotifications();
  };
  const markNotificationRead = (activityId) => {
    if (!activityId) return;
    state.activityFeed = state.activityFeed.filter((item) => item.id !== activityId);
    renderUnread();
    renderNotifications();
  };
  const latestActorForThread = (thread) => {
    const messages = thread.messages || [];
    const latestMessage = messages.reduce((best, message) => (!best || message.updated_at > best.updated_at ? message : best), null);
    if (latestMessage && latestMessage.author_label) return latestMessage.author_label;
    if (thread.resolved_by_label) return thread.resolved_by_label;
    return thread.created_by_label || '';
  };
  const labelForPagePath = (pagePath) => {
    const tail = String(pagePath || 'index.html').split('/').pop() || 'index.html';
    const base = tail.replace(/\.html?$/i, '');
    if (!base || base === 'index') return 'Overview';
    return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  };
  const describeActivities = (previousThreads, nextThreads) => {
    const previousById = new Map((previousThreads || []).map((thread) => [thread.id, thread]));
    const candidates = [];
    (nextThreads || []).forEach((thread) => {
      const previous = previousById.get(thread.id);
      const pagePath = thread.page_path || 'index.html';
      const pageLabel = labelForPagePath(pagePath);
      if (!previous) {
        const actor = latestActorForThread(thread);
        const newestMessage = (thread.messages || []).slice().sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0];
        candidates.push({ id: thread.id + ':' + String(thread.updated_at || 0) + ':create', updated_at: thread.updated_at || 0, actor, threadId: thread.id, pagePath, pageLabel, message: (actor || 'Someone') + ' added a comment.', snippet: shortSnippet(newestMessage ? newestMessage.body : 'New comment on this page'), unread: true });
        return;
      }
      const previousMessages = new Map((previous.messages || []).map((message) => [message.id, message]));
      const newMessage = (thread.messages || []).find((message) => !previousMessages.has(message.id));
      if (newMessage) {
        candidates.push({ id: thread.id + ':' + String(newMessage.updated_at || thread.updated_at || 0) + ':reply', updated_at: newMessage.updated_at || thread.updated_at || 0, actor: newMessage.author_label || '', threadId: thread.id, pagePath, pageLabel, message: (newMessage.author_label || 'Someone') + ' replied to a comment.', snippet: shortSnippet(newMessage.body || 'New reply'), unread: true });
        return;
      }
      if (thread.status !== previous.status) {
        const actor = thread.resolved_by_label || latestActorForThread(thread);
        candidates.push({ id: thread.id + ':' + String(thread.updated_at || 0) + ':status:' + thread.status, updated_at: thread.updated_at || 0, actor, threadId: thread.id, pagePath, pageLabel, message: (actor || 'Someone') + (thread.status === 'resolved' ? ' resolved a comment.' : ' reopened a comment.'), snippet: shortSnippet(anchorLabel(thread)), unread: true });
        return;
      }
      const editedMessage = (thread.messages || []).find((message) => {
        const before = previousMessages.get(message.id);
        return before && (before.body !== message.body || before.deleted_at !== message.deleted_at || before.updated_at !== message.updated_at);
      });
      if (editedMessage) {
        const suffix = editedMessage.deleted_at ? ' deleted a comment.' : ' updated a comment.';
        candidates.push({ id: thread.id + ':' + String(editedMessage.updated_at || thread.updated_at || 0) + ':edit', updated_at: editedMessage.updated_at || thread.updated_at || 0, actor: editedMessage.author_label || '', threadId: thread.id, pagePath, pageLabel, message: (editedMessage.author_label || 'Someone') + suffix, snippet: shortSnippet(editedMessage.deleted_at ? 'Comment deleted' : editedMessage.body), unread: true });
      }
    });
    candidates.sort((a, b) => b.updated_at - a.updated_at);
    return candidates.filter((candidate) => candidate.actor && candidate.actor !== state.currentLabel);
  };
  const clearDraftHighlight = () => {
    document.querySelectorAll('.toss-comment-draft-highlight').forEach((node) => node.remove());
  };
  const clearFocusHighlight = () => {
    document.querySelectorAll('.toss-comment-focus-highlight').forEach((node) => node.remove());
  };
  const clearDraftChip = () => {
    document.querySelectorAll('.toss-comment-chip').forEach((node) => node.remove());
  };
  const renderDraftHighlight = () => {
    clearDraftHighlight();
    state.pendingRects.forEach((rect) => {
      const marker = document.createElement('div');
      marker.className = 'toss-comment-draft-highlight';
      marker.style.left = rect.x + 'px';
      marker.style.top = rect.y + 'px';
      marker.style.width = Math.max(rect.width, 8) + 'px';
      marker.style.height = Math.max(rect.height, 16) + 'px';
      document.body.appendChild(marker);
    });
  };
  const renderDraftChip = () => {
    clearDraftChip();
    if (state.pendingScope !== 'selection' || !state.pendingRects.length) return;
    const firstRect = state.pendingRects[0];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'toss-comment-chip';
    chip.textContent = 'Comment';
    chip.style.left = firstRect.x + 'px';
    chip.style.top = Math.max(firstRect.y - 40, 12) + 'px';
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanelForComment();
      setStatus('Selection captured. Add your comment.');
      setTimeout(() => textarea.focus(), 0);
    });
    document.body.appendChild(chip);
  };
  const renderFocusHighlight = () => {
    clearFocusHighlight();
    if (!state.activeThreadId) return;
    const thread = state.threads.find((item) => item.id === state.activeThreadId);
    if (!thread || !thread.anchor) return;
    const rect = rectFromAnchor(thread.anchor);
    if (!rect) return;
    const marker = document.createElement('div');
    marker.className = 'toss-comment-focus-highlight';
    marker.style.left = (rect.x || 0) + 'px';
    marker.style.top = (rect.y || 0) + 'px';
    marker.style.width = Math.max(rect.width || 0, 8) + 'px';
    marker.style.height = Math.max(rect.height || 0, 16) + 'px';
    document.body.appendChild(marker);
  };
  const activateThread = (threadId) => {
    state.activeThreadId = threadId;
    markThreadNotificationsRead(threadId);
    render();
    renderFocusHighlight();
    const node = root.querySelector('[data-thread-id="' + threadId + '"]');
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const updateContext = () => {
    if (state.pendingScope === 'selection' && state.pendingAnchor) {
      contextLabel.textContent = 'Selected text: ' + (state.pendingAnchor.selectedText || state.pendingAnchor.textSnippet || 'Selection');
      return;
    }
    contextLabel.textContent = 'Whole page';
  };
  const resetPendingAnchor = () => {
    state.pendingScope = 'artifact';
    state.pendingAnchor = null;
    state.pendingRects = [];
    clearDraftHighlight();
    clearDraftChip();
    updateContext();
  };
  const setBusy = (busy) => {
    state.busy = busy;
    tokenInput.disabled = busy;
    textarea.disabled = busy;
    submitButton.disabled = busy;
    root.querySelectorAll('button').forEach((button) => {
      if (button.classList.contains('toss-comments-toggle') || button.classList.contains('toss-comments-notify-toggle')) return;
      button.disabled = busy;
    });
  };
  const tempId = (prefix) => prefix + '-' + Math.random().toString(36).slice(2, 10);
  const scrollThreadIntoView = (threadId) => {
    const node = root.querySelector('[data-thread-id="' + threadId + '"]');
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const authHeaders = (needsAuth) => {
    const headers = { 'X-Toss-Viewer': cfg.viewerToken };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    if (needsAuth) headers['Content-Type'] = 'application/json';
    return headers;
  };

  const api = async (path, init = {}, needsAuth = false) => {
    const res = await fetch(cfg.origin + path, {
      ...init,
      headers: { ...(init.headers || {}), ...authHeaders(needsAuth) },
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text ? { error: text } : null; }
    if (!res.ok) throw new Error((data && data.error) || text || ('Request failed: ' + res.status));
    return data;
  };

  const anchorLabel = (thread) => {
    if (thread.scope_type === 'artifact') return 'General page comment';
    const anchor = thread.anchor || {};
    if (thread.scope_type === 'selection') return 'Selection: ' + (anchor.selectedText || anchor.textSnippet || 'Selected text');
    return 'Element: ' + (anchor.selector || anchor.textSnippet || 'Selected element');
  };
  const normalizeMessage = (message) => ({
    ...message,
    can_edit: !!message.can_edit,
    can_delete: !!message.can_delete,
  });
  const normalizeThread = (thread) => ({
    ...thread,
    anchor: thread.anchor || null,
    can_delete: !!thread.can_delete,
    can_resolve: !!thread.can_resolve,
    messages: (thread.messages || []).map(normalizeMessage),
  });
  const upsertThread = (thread, options = {}) => {
    const normalized = normalizeThread(thread);
    const existingIndex = state.threads.findIndex((item) => item.id === normalized.id);
    if (existingIndex >= 0) {
      state.threads.splice(existingIndex, 1, normalized);
      return;
    }
    if (options.prepend) {
      state.threads.unshift(normalized);
      return;
    }
    state.threads.push(normalized);
  };
  const removeThread = (threadId) => {
    state.threads = state.threads.filter((thread) => thread.id !== threadId);
  };
  const updateThread = (threadId, updater) => {
    state.threads = state.threads.map((thread) => thread.id === threadId ? updater(thread) : thread);
  };

  const renderPins = () => {
    document.querySelectorAll('.toss-comment-pin').forEach((node) => node.remove());
    state.threads.forEach((thread, index) => {
      if (thread.deleted_at || thread.scope_type === 'artifact' || !thread.anchor) return;
      const rect = rectFromAnchor(thread.anchor);
      if (!rect) return;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'toss-comment-pin' + (thread.id === state.activeThreadId ? ' active' : '');
      pin.textContent = String(index + 1);
      pin.style.left = (rect.x || 0) + 'px';
      pin.style.top = (rect.y || 0) + 'px';
      pin.title = anchorLabel(thread);
      pin.addEventListener('click', () => {
        panel.classList.add('open');
        ensureThreadsLoaded();
        activateThread(thread.id);
      });
      document.body.appendChild(pin);
    });
  };

  const render = () => {
    list.innerHTML = '';
    if (!state.threads.length) {
      list.innerHTML = '<div class="toss-comments-empty">No comments on ' + esc(currentPageLabel()) + ' yet.</div>';
      renderNotifications();
      renderPins();
      return;
    }

    state.threads.forEach((thread) => {
      const article = document.createElement('article');
      article.className = 'toss-comments-card' + (thread.status === 'resolved' ? ' resolved' : '');
      if (thread.id === state.activeThreadId) article.className += ' focused';
      article.dataset.threadId = thread.id;

      const meta = document.createElement('div');
      meta.className = 'toss-comments-meta';
      meta.innerHTML = '<span>' + esc(thread.created_by_label) + '</span><span>' + esc(thread.status) + '</span>';
      article.appendChild(meta);

      const anchor = document.createElement('div');
      anchor.className = 'toss-comments-thread-anchor';
      anchor.textContent = anchorLabel(thread);
      article.appendChild(anchor);

      (thread.messages || []).forEach((message) => {
        const box = document.createElement('div');
        const messageIndex = (thread.messages || []).indexOf(message);
        const replyTarget = messageIndex > 0 ? ((thread.messages || [])[messageIndex - 1]?.author_label || thread.created_by_label || '') : '';
        box.className = 'toss-comments-message ' + (messageIndex === 0 ? 'parent' : 'reply');
        const replyMeta = messageIndex > 0 ? '<div class="toss-comments-replying-to">Replying to ' + esc(replyTarget) + '</div>' : '';
        box.innerHTML = '<div class="toss-comments-message-meta"><span>' + esc(message.author_label) + '</span><span>' + new Date(message.updated_at * 1000).toLocaleString() + (message.deleted_at ? ' · deleted' : (message.updated_at !== message.created_at ? ' · edited' : '')) + '</span></div>' +
          replyMeta +
          '<div>' + esc(message.deleted_at ? 'Message deleted' : message.body) + '</div>';
        if (!message.deleted_at && (message.can_edit || message.can_delete)) {
          const actions = document.createElement('div');
          actions.className = 'toss-comments-actions';
          if (message.can_edit) {
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.textContent = 'Edit';
            edit.dataset.action = 'edit-message';
            edit.dataset.messageId = message.id;
            edit.dataset.body = message.body;
            actions.appendChild(edit);
          }
          if (message.can_delete) {
            const del = document.createElement('button');
            del.type = 'button';
            del.textContent = 'Delete';
            del.className = 'warn';
            del.dataset.action = 'delete-message';
            del.dataset.messageId = message.id;
            actions.appendChild(del);
          }
          box.appendChild(actions);
        }
        article.appendChild(box);
      });

      const actions = document.createElement('div');
      actions.className = 'toss-comments-actions';
      actions.innerHTML = '<button type="button" data-action="reply-thread" data-thread-id="' + thread.id + '">Reply</button>';
      if (thread.can_resolve && thread.status !== 'resolved') {
        actions.innerHTML += '<button type="button" class="primary" data-action="resolve-thread" data-thread-id="' + thread.id + '">Resolve</button>';
      }
      if (thread.can_resolve && thread.status === 'resolved') {
        actions.innerHTML += '<button type="button" data-action="reopen-thread" data-thread-id="' + thread.id + '">Reopen</button>';
      }
      if (thread.can_delete) {
        actions.innerHTML += '<button type="button" class="warn" data-action="delete-thread" data-thread-id="' + thread.id + '">Delete Thread</button>';
      }
      article.appendChild(actions);
      if (state.replyThreadId === thread.id) {
        const replyTargetMessage = [...(thread.messages || [])].reverse().find((message) => !message.deleted_at) || null;
        const replyBox = document.createElement('div');
        replyBox.className = 'toss-comments-card';
        replyBox.innerHTML =
          '<div class="toss-comments-replying-to">Replying to ' + esc(replyTargetMessage?.author_label || thread.created_by_label || 'thread') + ': ' + esc(replySnippet(replyTargetMessage?.body || thread.messages?.[0]?.body || 'Comment')) + '</div>' +
          '<textarea class="toss-comments-textarea toss-comments-reply-input" data-thread-id="' + thread.id + '" placeholder="Write a reply...">' + esc(state.replyDraft) + '</textarea>' +
          '<div class="toss-comments-actions">' +
            '<button type="button" class="primary" data-action="submit-reply" data-thread-id="' + thread.id + '">Post Reply</button>' +
            '<button type="button" data-action="cancel-reply" data-thread-id="' + thread.id + '">Cancel</button>' +
          '</div>';
        article.appendChild(replyBox);
      }
      article.addEventListener('click', (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('button, textarea, input, label')) return;
        state.activeThreadId = thread.id;
        markThreadNotificationsRead(thread.id);
        render();
        renderFocusHighlight();
      });
      list.appendChild(article);
    });

    renderNotifications();
    renderPins();
    renderFocusHighlight();
    renderUnread();
  };

  const loadThreads = async (options = {}) => {
    const { silent = false, applyThreads = !silent } = options;
    state.loading = true;
    try {
      const data = await api(buildCommentsPath(true));
      const nextThreads = (data.threads || []).map(normalizeThread);
      const nextActivityThreads = (data.activityThreads || data.threads || []).map(normalizeThread);
      const previousThreads = state.activityThreads;
      const previousDigest = state.lastDigest;
      const nextLabel = data.viewer && data.viewer.label ? data.viewer.label : '';
      state.currentLabel = nextLabel;
      if (applyThreads) {
        state.threads = nextThreads;
        state.loaded = true;
      }
      const nextDigest = threadsDigest(nextActivityThreads);
      if (!previousDigest) {
        state.lastDigest = nextDigest;
      } else if (previousDigest !== nextDigest) {
        state.lastDigest = nextDigest;
        const activities = describeActivities(previousThreads, nextActivityThreads);
        if (activities.length) {
          const incomingIds = new Set(activities.map((item) => item.id));
          state.activityFeed = [
            ...activities,
            ...state.activityFeed.filter((item) => !incomingIds.has(item.id)),
          ].sort((a, b) => b.updated_at - a.updated_at).slice(0, 25);
        }
      }
      state.activityThreads = nextActivityThreads;
      if (!silent && state.token) {
        setStatus(state.currentLabel ? ('Commenting as ' + state.currentLabel) : 'Token saved. You can comment now.');
      } else if (!silent) {
        setStatus('Paste your toss token to create comments, reply, resolve, edit, or delete.');
      }
      if (applyThreads) {
        render();
        const pendingTarget = consumePendingTarget();
        if (pendingTarget && pendingTarget.threadId) {
          markNotificationRead(pendingTarget.activityId || '');
          markThreadNotificationsRead(pendingTarget.threadId);
          activateThread(pendingTarget.threadId);
          setStatus('Jumped to the latest activity.');
        }
      } else {
        renderNotifications();
        renderUnread();
      }
    } catch (error) {
      if (!silent) setStatus(error.message || 'Failed to load comments.');
    } finally {
      state.loading = false;
    }
  };
  const ensureThreadsLoaded = async (force = false) => {
    if (state.loading) return;
    if (!force && state.loaded) return;
    await loadThreads();
  };
  const startPolling = () => {
    if (state.pollTimer) return;
    state.pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadThreads({ silent: true, applyThreads: false });
    }, 2000);
  };
  const syncNotificationsNow = () => {
    if (document.visibilityState === 'hidden') return;
    loadThreads({ silent: true, applyThreads: false });
  };

  const openPanelForComment = () => {
    panel.classList.add('open');
    ensureThreadsLoaded();
  };
  const openPanelForNotifications = () => {
    panel.classList.add('open');
    ensureThreadsLoaded();
    notifications.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const captureSelectionAnchor = (options = {}) => {
    const { openPanel = false, silent = false } = options;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) {
      if (!silent) setStatus('Select some text on the page first.');
      return false;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).map((clientRect) => ({
      x: Math.round(clientRect.left + window.scrollX),
      y: Math.round(clientRect.top + window.scrollY),
      width: Math.round(clientRect.width),
      height: Math.round(clientRect.height),
    })).filter((clientRect) => clientRect.width > 0 && clientRect.height > 0);
    const selectedText = selection.toString().trim();
    state.pendingScope = 'selection';
    state.pendingAnchor = {
      selector: selectorFor(range.startContainer && range.startContainer.parentElement),
      selectedText,
      textSnippet: selectedText.slice(0, 240),
      rect: {
        x: Math.round(rect.left + window.scrollX),
        y: Math.round(rect.top + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    };
    state.pendingRects = rects.length ? rects : [{
      x: Math.round(rect.left + window.scrollX),
      y: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }];
    renderDraftHighlight();
    renderDraftChip();
    updateContext();
    setStatus('Selection captured. Add your comment.');
    if (openPanel) openPanelForComment();
    return true;
  };

  document.addEventListener('mouseup', (event) => {
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    captureSelectionAnchor({ openPanel: false, silent: true });
  });
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Node && root.contains(target)) return;
    if (target instanceof HTMLElement && (target.classList.contains('toss-comment-chip') || target.classList.contains('toss-comment-pin'))) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    if (state.pendingScope === 'selection' || state.pendingRects.length) {
      resetPendingAnchor();
      setStatus('Selection cleared.');
    }
    notifications.classList.remove('open');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    if (state.pendingScope === 'selection' || state.pendingRects.length) {
      resetPendingAnchor();
      setStatus('Selection cleared.');
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNotificationsNow();
  });
  window.addEventListener('focus', syncNotificationsNow);
  root.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (target.classList.contains('toss-comments-reply-input')) {
      state.replyDraft = target.value;
    }
  });

  root.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (state.busy && !target.classList.contains('toss-comments-toggle')) return;
    const notificationItem = target.closest('.toss-comments-notification');

    if (target.classList.contains('toss-comments-notify-toggle')) {
      if (notifications.classList.contains('open')) notifications.classList.remove('open');
      else {
        notifications.classList.add('open');
        ensureThreadsLoaded();
      }
      return;
    }
    if (target.classList.contains('toss-comments-toggle') || target.classList.contains('toss-comments-close')) {
      panel.classList.toggle('open');
      notifications.classList.remove('open');
      if (panel.classList.contains('open')) {
        ensureThreadsLoaded();
      } else {
        resetPendingAnchor();
        state.activeThreadId = '';
        clearFocusHighlight();
        setStatus('Comments closed.');
      }
      return;
    }
    if (notificationItem instanceof HTMLElement) {
      const threadId = notificationItem.dataset.threadId;
      const activityId = notificationItem.dataset.activityId;
      const pagePath = notificationItem.dataset.pagePath || 'index.html';
      if (pagePath !== currentPagePath) {
        setPendingTarget({ threadId, activityId, pagePath });
        notifications.classList.remove('open');
        window.location.href = buildPageUrl(pagePath);
        return;
      }
      panel.classList.add('open');
      notifications.classList.remove('open');
      markNotificationRead(activityId);
      markThreadNotificationsRead(threadId);
      await loadThreads({ silent: false, applyThreads: true });
      if (threadId) activateThread(threadId);
      setStatus('Jumped to the latest activity.');
      return;
    }
    if (target.classList.contains('toss-comments-save-token')) {
      state.token = tokenInput.value.trim();
      if (state.token) localStorage.setItem(storageKey, state.token);
      setStatus('Token saved. Loading comment permissions...');
      setBusy(true);
      try {
        await ensureThreadsLoaded(true);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (target.classList.contains('toss-comments-clear-token')) {
      state.token = '';
      tokenInput.value = '';
      localStorage.removeItem(storageKey);
      setStatus('Comment token cleared.');
      setBusy(true);
      try {
        await ensureThreadsLoaded(true);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (target.classList.contains('toss-comments-context-clear')) {
      resetPendingAnchor();
      setStatus('Comment will be posted on the whole page.');
      return;
    }
    if (target.classList.contains('toss-comments-submit')) {
      if (!state.token) {
        setStatus('Paste your toss token first.');
        return;
      }
      const body = textarea.value.trim();
      if (!body) {
        setStatus('Write a comment first.');
        return;
      }
      const draft = textarea.value;
      textarea.value = '';
      captureSelectionAnchor({ silent: true });
      const optimisticThreadId = tempId('thread');
      const optimisticMessageId = tempId('message');
      const now = Math.floor(Date.now() / 1000);
      upsertThread({
        id: optimisticThreadId,
        artifact_id: cfg.artifactId,
        created_by_label: state.currentLabel || 'You',
        scope_type: state.pendingScope,
        anchor: state.pendingScope === 'artifact' ? null : state.pendingAnchor,
        status: 'open',
        resolved_by_label: null,
        resolved_at: null,
        deleted_at: null,
        created_at: now,
        updated_at: now,
        can_delete: true,
        can_resolve: true,
        messages: [{
          id: optimisticMessageId,
          thread_id: optimisticThreadId,
          author_label: state.currentLabel || 'You',
          body,
          created_at: now,
          updated_at: now,
          deleted_at: null,
          can_edit: true,
          can_delete: true,
        }],
      }, { prepend: true });
      render();
      scrollThreadIntoView(optimisticThreadId);
      try {
        const data = await api('/artifacts/' + cfg.artifactId + '/comment-threads', {
          method: 'POST',
          body: JSON.stringify({
            body,
            pagePath: currentPagePath,
            scopeType: state.pendingScope,
            anchor: state.pendingScope === 'artifact' ? undefined : state.pendingAnchor,
          }),
        }, true);
        if (data && data.thread) {
          removeThread(optimisticThreadId);
          upsertThread(data.thread, { prepend: true });
          render();
        }
        resetPendingAnchor();
        setStatus('Comment posted.');
      } catch (error) {
        removeThread(optimisticThreadId);
        render();
        textarea.value = draft;
        setStatus(error.message || 'Failed to post comment.');
      }
      return;
    }

    if (!action) return;
    if (!state.token) {
      setStatus('Paste your toss token first.');
      return;
    }

    try {
      if (action === 'reply-thread') {
        state.replyThreadId = target.dataset.threadId || '';
        state.replyDraft = '';
        render();
        setStatus('Reply box opened.');
        return;
      } else if (action === 'cancel-reply') {
        state.replyThreadId = '';
        state.replyDraft = '';
        render();
        setStatus('Reply cancelled.');
        return;
      } else if (action === 'submit-reply') {
        const body = state.replyDraft.trim();
        if (!body) {
          setStatus('Write a reply first.');
          return;
        }
        const threadId = target.dataset.threadId;
        const optimisticMessageId = tempId('reply');
        const now = Math.floor(Date.now() / 1000);
        updateThread(threadId, (thread) => ({
          ...thread,
          updated_at: now,
          messages: [...(thread.messages || []), normalizeMessage({
            id: optimisticMessageId,
            thread_id: threadId,
            author_label: state.currentLabel || 'You',
            body,
            created_at: now,
            updated_at: now,
            deleted_at: null,
            can_edit: true,
            can_delete: true,
          })],
        }));
        state.replyThreadId = '';
        state.replyDraft = '';
        render();
        scrollThreadIntoView(threadId);
        const data = await api('/comment-threads/' + target.dataset.threadId + '/messages', {
          method: 'POST',
          body: JSON.stringify({ body }),
        }, true);
        if (data && data.message) {
          updateThread(threadId, (thread) => ({
            ...thread,
            updated_at: data.threadUpdatedAt || thread.updated_at,
            messages: (thread.messages || []).map((message) =>
              message.id === optimisticMessageId ? normalizeMessage(data.message) : message),
          }));
        }
      } else if (action === 'resolve-thread') {
        updateThread(target.dataset.threadId, (thread) => ({
          ...thread,
          status: 'resolved',
          resolved_by_label: state.currentLabel || 'You',
          resolved_at: Math.floor(Date.now() / 1000),
          messages: (thread.messages || []).map((message) => ({ ...message, can_edit: false })),
        }));
        render();
        const data = await api('/comment-threads/' + target.dataset.threadId + '/resolve', { method: 'POST' }, true);
        updateThread(target.dataset.threadId, (thread) => ({
          ...thread,
          status: data.status,
          resolved_by_label: data.resolvedByLabel,
          resolved_at: data.resolvedAt,
          updated_at: data.updatedAt || thread.updated_at,
        }));
      } else if (action === 'reopen-thread') {
        updateThread(target.dataset.threadId, (thread) => ({
          ...thread,
          status: 'open',
          resolved_by_label: null,
          resolved_at: null,
          messages: (thread.messages || []).map((message) => ({ ...message, can_edit: !message.deleted_at && message.author_label === (state.currentLabel || 'You') })),
        }));
        render();
        const data = await api('/comment-threads/' + target.dataset.threadId + '/reopen', { method: 'POST' }, true);
        updateThread(target.dataset.threadId, (thread) => ({
          ...thread,
          status: data.status,
          resolved_by_label: null,
          resolved_at: null,
          updated_at: data.updatedAt || thread.updated_at,
        }));
      } else if (action === 'delete-thread') {
        if (!window.confirm('Delete this thread?')) return;
        if (state.activeThreadId === target.dataset.threadId) {
          state.activeThreadId = '';
          clearFocusHighlight();
        }
        removeThread(target.dataset.threadId);
        render();
        await api('/comment-threads/' + target.dataset.threadId, { method: 'DELETE' }, true);
      } else if (action === 'edit-message') {
        const nextBody = window.prompt('Edit comment', target.dataset.body || '');
        if (!nextBody) return;
        const threadNode = target.closest('[data-thread-id]');
        const threadId = threadNode ? threadNode.dataset.threadId : '';
        updateThread(threadId, (thread) => ({
          ...thread,
          messages: (thread.messages || []).map((message) =>
            message.id === target.dataset.messageId
              ? { ...message, body: nextBody, updated_at: Math.floor(Date.now() / 1000) }
              : message),
        }));
        render();
        const data = await api('/comment-messages/' + target.dataset.messageId, {
          method: 'PATCH',
          body: JSON.stringify({ body: nextBody }),
        }, true);
        updateThread(threadId, (thread) => ({
          ...thread,
          updated_at: data.threadUpdatedAt || thread.updated_at,
          messages: (thread.messages || []).map((message) =>
            message.id === target.dataset.messageId
              ? { ...message, body: data.body, updated_at: data.updatedAt || message.updated_at }
              : message),
        }));
      } else if (action === 'delete-message') {
        if (!window.confirm('Delete this comment?')) return;
        const threadNode = target.closest('[data-thread-id]');
        const threadId = threadNode ? threadNode.dataset.threadId : '';
        updateThread(threadId, (thread) => ({
          ...thread,
          messages: (thread.messages || []).map((message) =>
            message.id === target.dataset.messageId
              ? { ...message, deleted_at: Math.floor(Date.now() / 1000), body: '' }
              : message),
        }));
        render();
        await api('/comment-messages/' + target.dataset.messageId, { method: 'DELETE' }, true);
      }
      render();
    } catch (error) {
      setStatus(error.message || 'Action failed.');
    }
  });

  updateContext();
  startPolling();
  const bootTarget = readPendingTarget();
  if (bootTarget && bootTarget.pagePath === currentPagePath) {
    panel.classList.add('open');
    loadThreads({ silent: true, applyThreads: true });
  } else {
    loadThreads({ silent: true });
  }
  setStatus('Select text on the page to anchor a comment, or write to comment on the whole page.');
})();
</script>`;

  if (html.includes('</body>')) return html.replace('</body>', `${shell}</body>`);
  return `${html}${shell}`;
}

// Text responses must declare charset=utf-8. Without it the browser applies a locale
// default (windows-1252 for en) and decodes UTF-8 bytes as mojibake; for a <script src>
// the default is the *referencing document's* encoding, so a UTF-8 asset under a
// charset-less page breaks too. Everything toss ingests is UTF-8 end to end.
// application/json is excluded deliberately: RFC 8259 defines no charset parameter
// (JSON is always UTF-8). Binary types are unaffected.
function mimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    jsx: 'application/javascript; charset=utf-8',
    ts: 'application/typescript; charset=utf-8',
    tsx: 'application/typescript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml; charset=utf-8',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    txt: 'text/plain; charset=utf-8',
    xml: 'application/xml; charset=utf-8',
    pdf: 'application/pdf',
    md: 'text/markdown; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

// --- Serve artifact (shared by /a/:id and /s/:slug) ---

interface ArtifactMeta {
  id: string;
  expires_at: number;
}

async function serveArtifact(
  meta: ArtifactMeta,
  filePath: string,
  request: Request,
  env: Env,
  routeConfig: { artifactBasePath: string }
): Promise<Response> {
  if (isArtifactExpired(meta.expires_at)) {
    return new Response('Link expired', { status: 410 });
  }

  const obj = await env.TOSS_KV.get(`artifacts/${meta.id}/files/${filePath}`, 'arrayBuffer');
  if (!obj) {
    if (!filePath.endsWith('.html')) {
      const indexObj = await env.TOSS_KV.get(`artifacts/${meta.id}/files/${filePath}/index.html`, 'arrayBuffer');
      if (indexObj) {
        return new Response(indexObj, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
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
    const html = typeof obj === 'string' ? obj : new TextDecoder().decode(obj);
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; frame-ancestors 'none'; base-uri 'none';";
    // Comments are a per-share opt-in (comments_enabled), independent of MULTI_TENANT.
    const commentsRow = await env.TOSS_DB.prepare('SELECT comments_enabled, password_epoch FROM artifacts WHERE id = ?')
      .bind(meta.id).first<{ comments_enabled: number; password_epoch: number | null }>();
    if (!commentsRow || !commentsRow.comments_enabled) {
      headers['Cache-Control'] = 'private, no-store, max-age=0';
      return new Response(html, { status: 200, headers });
    }
    const viewerToken = await issueCommentGrant(meta.id, meta.expires_at, env.JWT_SECRET, Number(commentsRow.password_epoch) || 0);
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
    return new Response(obj, { status: 200, headers });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Seed admin user in multi-tenant mode if table is empty
      if (env.MULTI_TENANT === 'true') {
        const count = await env.TOSS_DB.prepare('SELECT COUNT(*) as c FROM users').first<{ c: number }>();
        if (count && count.c === 0) {
          const adminHash = await sha256(env.OWNER_TOKEN);
          await env.TOSS_DB.prepare(
            'INSERT INTO users (token_hash, label, created_at, is_admin) VALUES (?, ?, ?, ?)'
          ).bind(adminHash, 'admin', Math.floor(Date.now() / 1000), 1).run();
        }
      }

      // ===== UPLOAD artifact =====
      if (url.pathname === '/artifacts' && request.method === 'POST') {
        const auth = await requireUser(request, env);
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
        const now = Math.floor(Date.now() / 1000);

        // Replace-in-place when a stable slug already exists and is owned by the caller.
        // The slug stays (recipients keep working URLs); name, content, expires_at,
        // and password_hash all reflect the new request — re-sharing fully re-describes
        // the share. Omitting --password clears the password; omitting --expires (or
        // --expires never) makes it permanent.
        if (requestedId !== null) {
          const existing = await env.TOSS_DB.prepare(
            'SELECT id, token_hash FROM artifacts WHERE slug = ?'
          ).bind(requestedId).first<{ id: string; token_hash: string }>();
          if (existing) {
            if (existing.token_hash !== auth.tokenHash) {
              return new Response('Slug already taken by another tenant', { status: 409 });
            }
            const existingId = existing.id;
            // Password salt is the artifact id, which is preserved on update.
            const passwordParam = url.searchParams.get('password');
            const newPasswordHash = passwordParam ? await sha256(passwordParam + existingId) : null;
            const newExpiresAt = expiresSeconds === 0 ? 0 : (now + expiresSeconds);
            await env.TOSS_KV.put(`artifacts/${existingId}/files/index.html`, html);
            await env.TOSS_DB.prepare(
              'UPDATE artifacts SET name = ?, size_bytes = ?, expires_at = ?, password_hash = ? WHERE id = ?'
            ).bind(name, sizeBytes, newExpiresAt, newPasswordHash, existingId).run();
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
          // 62-bit slugs collide with vanishing probability, but a pre-check
          // loop beats relying on the DB unique constraint to surface a 500.
          slug = generateSlug();
          for (let attempt = 0; attempt < 5; attempt++) {
            const taken = await env.TOSS_DB.prepare(
              'SELECT 1 FROM artifacts WHERE slug = ?'
            ).bind(slug).first();
            if (!taken) break;
            slug = generateSlug();
          }
        }

        const passwordParam = url.searchParams.get('password');
        const passwordHash = passwordParam ? await sha256(passwordParam + id) : null;
        const commentsParam = url.searchParams.get('comments');
        const commentsEnabled = commentsParam === '1' || commentsParam === 'true' ? 1 : 0;

        await env.TOSS_KV.put(`artifacts/${id}/files/index.html`, html);

        const expiresAt = expiresSeconds === 0 ? PERMANENT : (now + expiresSeconds);
        await env.TOSS_DB.prepare(
          'INSERT INTO artifacts (id, slug, name, size_bytes, created_at, expires_at, token_hash, password_hash, comments_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(id, slug, name, sizeBytes, now, expiresAt, auth.tokenHash, passwordHash, commentsEnabled)
          .run();

        // Legacy /a/:id?t=jwt URL. issueArtifactJWT handles the permanent vs
        // time-bound distinction so the verifier can normalize correctly.
        const jwt = await issueArtifactJWT(id, expiresAt, env.JWT_SECRET);
        const legacyUrl = `${url.origin}/a/${id}?t=${jwt}`;
        const shortUrl = `${url.origin}/s/${slug}`;

        return new Response(JSON.stringify({ id, slug, url: shortUrl, legacyUrl }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ===== UPLOAD additional files =====
      const filesMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/files$/);
      if (filesMatch && request.method === 'POST') {
        const auth = await requireUser(request, env);
        if (auth instanceof Response) return auth;

        const contentLength = request.headers.get('Content-Length');
        const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
        if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_SIZE) {
          return new Response('Request too large', { status: 413 });
        }

        const id = filesMatch[1];

        // In multi-tenant mode, verify user owns this artifact
        if (env.MULTI_TENANT === 'true' && !auth.isAdmin) {
          const row = await env.TOSS_DB.prepare('SELECT token_hash FROM artifacts WHERE id = ?')
            .bind(id)
            .first<{ token_hash: string }>();
          if (!row || !constantTimeEqual(row.token_hash, auth.tokenHash)) {
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
        await env.TOSS_KV.put(`artifacts/${id}/files/${filePath}`, body);

        return new Response(JSON.stringify({ uploaded: filePath }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ===== LIST artifacts =====
      if (url.pathname === '/artifacts' && request.method === 'GET') {
        const auth = await requireUser(request, env);
        if (auth instanceof Response) return auth;

        let results: unknown[] = [];
        if (env.MULTI_TENANT === 'true' && !auth.isAdmin) {
          const q = await env.TOSS_DB.prepare(
            'SELECT id, slug, name, size_bytes, created_at, expires_at FROM artifacts WHERE token_hash = ? ORDER BY created_at DESC'
          ).bind(auth.tokenHash).all();
          results = q.results || [];
        } else {
          const q = await env.TOSS_DB.prepare(
            'SELECT id, slug, name, size_bytes, created_at, expires_at FROM artifacts ORDER BY created_at DESC'
          ).all();
          results = q.results || [];
        }

        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ===== DELETE artifact =====
      if (url.pathname.match(/^\/artifacts\/[a-f0-9-]+$/) && request.method === 'DELETE') {
        const auth = await requireUser(request, env);
        if (auth instanceof Response) return auth;

        const id = url.pathname.split('/')[2];

        // In multi-tenant mode, verify ownership
        if (env.MULTI_TENANT === 'true' && !auth.isAdmin) {
          const row = await env.TOSS_DB.prepare('SELECT token_hash FROM artifacts WHERE id = ?')
            .bind(id)
            .first<{ token_hash: string }>();
          if (!row || !constantTimeEqual(row.token_hash, auth.tokenHash)) {
            return new Response('Forbidden', { status: 403 });
          }
        }

        let cursor: string | undefined;
        do {
          const list = await env.TOSS_KV.list({ prefix: `artifacts/${id}/`, cursor });
          for (const key of list.keys) {
            await env.TOSS_KV.delete(key.name);
          }
          cursor = list.list_complete ? undefined : list.cursor;
        } while (cursor);
        // Cascade comments before the artifact row so a half-failed revoke
        // doesn't leave orphans with no way to find them again. Delete
        // messages first (they reference threads via thread_id).
        await env.TOSS_DB.prepare(
          'DELETE FROM comment_messages WHERE thread_id IN (SELECT id FROM comment_threads WHERE artifact_id = ?)'
        ).bind(id).run();
        await env.TOSS_DB.prepare('DELETE FROM comment_threads WHERE artifact_id = ?').bind(id).run();
        await env.TOSS_DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id).run();

        return new Response(JSON.stringify({ revoked: id }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ===== TOGGLE comments (per-share opt-in) =====
      const commentsToggleMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/comments$/);
      if (commentsToggleMatch && request.method === 'PATCH') {
        const auth = await requireUser(request, env);
        if (auth instanceof Response) return auth;
        const id = commentsToggleMatch[1];

        // Owner/admin only — same ownership rule as DELETE.
        if (env.MULTI_TENANT === 'true' && !auth.isAdmin) {
          const row = await env.TOSS_DB.prepare('SELECT token_hash FROM artifacts WHERE id = ?')
            .bind(id).first<{ token_hash: string }>();
          if (!row || !constantTimeEqual(row.token_hash, auth.tokenHash)) {
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
        await env.TOSS_DB.prepare('UPDATE artifacts SET comments_enabled = ? WHERE id = ?')
          .bind(enabled ? 1 : 0, id).run();
        return new Response(JSON.stringify({ id, comments_enabled: enabled }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ===== COMMENT THREADS =====
      const commentListMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/comment-threads$/);
      if (commentListMatch && request.method === 'GET') {
        const artifactId = commentListMatch[1];
        const access = await requireCommentAccess(request, env, artifactId);
        if (access instanceof Response) return access;
        const pagePath = normalizePagePath(url.searchParams.get('pagePath') || 'index.html');
        if (pagePath instanceof Response) return pagePath;
        const includeActivity = url.searchParams.get('includeActivity') === '1';

        const threadQuery = await env.TOSS_DB.prepare(
          'SELECT id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_label, resolved_at, deleted_at, created_at, updated_at FROM comment_threads WHERE artifact_id = ? AND page_path = ? AND deleted_at IS NULL ORDER BY created_at DESC'
        ).bind(artifactId, pagePath).all();
        const messageQuery = await env.TOSS_DB.prepare(
          'SELECT m.id, m.thread_id, m.author_token_hash, m.author_label, m.body, m.created_at, m.updated_at, m.deleted_at, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ? AND t.page_path = ? AND t.deleted_at IS NULL ORDER BY m.created_at ASC'
        ).bind(artifactId, pagePath).all();
        let activityThreadQuery: { results?: unknown[] } | null = null;
        let activityMessageQuery: { results?: unknown[] } | null = null;
        if (includeActivity) {
          activityThreadQuery = await env.TOSS_DB.prepare(
            'SELECT id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, resolved_by_label, resolved_at, deleted_at, created_at, updated_at FROM comment_threads WHERE artifact_id = ? AND deleted_at IS NULL ORDER BY created_at DESC'
          ).bind(artifactId).all();
          activityMessageQuery = await env.TOSS_DB.prepare(
            'SELECT m.id, m.thread_id, m.author_token_hash, m.author_label, m.body, m.created_at, m.updated_at, m.deleted_at, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE t.artifact_id = ? AND t.deleted_at IS NULL ORDER BY m.created_at ASC'
          ).bind(artifactId).all();
        }

        const hydrateThreads = (
          threadRows: Array<Record<string, unknown>>,
          messageRows: Array<Record<string, unknown>>
        ) => {
          // Access is already proven (grant or owner); anyone may edit/delete/resolve.
          const threads = threadRows.map((thread) => ({
            ...thread,
            anchor: thread.anchor_json ? JSON.parse(String(thread.anchor_json)) : null,
            can_delete: true,
            can_resolve: true,
            messages: [],
          })) as Array<Record<string, unknown>>;

          const byThread = new Map<string, Array<Record<string, unknown>>>();
          for (const row of messageRows) {
            const items = byThread.get(String(row.thread_id)) || [];
            const out: Record<string, unknown> = {
              ...row,
              can_edit: !row.deleted_at && row.thread_status !== 'resolved',
              can_delete: !row.deleted_at,
            };
            delete out.author_token_hash; // never expose the legacy author token hash
            items.push(out);
            byThread.set(String(row.thread_id), items);
          }

          for (const thread of threads) {
            thread.messages = byThread.get(String(thread.id)) || [];
            delete thread.anchor_json;
            delete thread.created_by_token_hash;
          }
          return threads;
        };

        const threads = hydrateThreads(
          (threadQuery.results || []) as Array<Record<string, unknown>>,
          (messageQuery.results || []) as Array<Record<string, unknown>>
        );
        const activityThreads = includeActivity
          ? hydrateThreads(
            (activityThreadQuery?.results || []) as Array<Record<string, unknown>>,
            (activityMessageQuery?.results || []) as Array<Record<string, unknown>>
          )
          : threads;

        return jsonResponse({
          pagePath,
          viewer: { authenticated: true, label: null },
          threads,
          activityThreads,
        });
      }

      if (commentListMatch && request.method === 'POST') {
        const artifactId = commentListMatch[1];
        const access = await requireCommentAccess(request, env, artifactId);
        if (access instanceof Response) return access;

        const body = await request.json().catch(() => null);
        const name = normalizeName(body);
        if (name instanceof Response) return name;
        const normalized = normalizeThreadInput(body);
        if (normalized instanceof Response) return normalized;

        const now = Math.floor(Date.now() / 1000);
        const threadId = generateId();
        const messageId = generateId();

        await env.TOSS_DB.prepare(
          'INSERT INTO comment_threads (id, artifact_id, page_path, created_by_token_hash, created_by_label, scope_type, anchor_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          threadId,
          artifactId,
          normalized.pagePath,
          NO_TOKEN,
          name,
          normalized.scopeType,
          normalized.anchorJson,
          'open',
          now,
          now,
        ).run();

        await env.TOSS_DB.prepare(
          'INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(messageId, threadId, NO_TOKEN, name, normalized.body, now, now).run();

        return jsonResponse({
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

        const threadRow = await env.TOSS_DB.prepare(
          'SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ?'
        ).bind(threadId).first<{ artifact_id: string; deleted_at: number | null }>();
        if (!threadRow || threadRow.deleted_at) return new Response('Not found', { status: 404 });

        const access = await requireCommentAccess(request, env, threadRow.artifact_id);
        if (access instanceof Response) return access;

        const body = await request.json().catch(() => null);
        const name = normalizeName(body);
        if (name instanceof Response) return name;
        const message = normalizeMessageInput(body);
        if (message instanceof Response) return message;

        const now = Math.floor(Date.now() / 1000);
        const messageId = generateId();
        await env.TOSS_DB.prepare(
          'INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(messageId, threadId, NO_TOKEN, name, message, now, now).run();
        await env.TOSS_DB.prepare('UPDATE comment_threads SET updated_at = ? WHERE id = ?').bind(now, threadId).run();

        return jsonResponse({
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

        const threadRow = await env.TOSS_DB.prepare(
          'SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ?'
        ).bind(threadId).first<{ artifact_id: string; deleted_at: number | null }>();
        if (!threadRow || threadRow.deleted_at) return new Response('Not found', { status: 404 });

        const access = await requireCommentAccess(request, env, threadRow.artifact_id);
        if (access instanceof Response) return access;

        const rb = await request.json().catch(() => null);
        const resolverName = rb && typeof rb === 'object' && typeof (rb as { name?: unknown }).name === 'string'
          ? (rb as { name: string }).name.trim().slice(0, 80) : '';

        const now = Math.floor(Date.now() / 1000);
        if (action === 'resolve') {
          await env.TOSS_DB.prepare(
            'UPDATE comment_threads SET status = ?, resolved_by_token_hash = ?, resolved_by_label = ?, resolved_at = ?, updated_at = ? WHERE id = ?'
          ).bind('resolved', NO_TOKEN, resolverName, now, now, threadId).run();
        } else {
          await env.TOSS_DB.prepare(
            'UPDATE comment_threads SET status = ?, resolved_by_token_hash = NULL, resolved_by_label = NULL, resolved_at = NULL, updated_at = ? WHERE id = ?'
          ).bind('open', now, threadId).run();
        }
        return jsonResponse({
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

        const threadRow = await env.TOSS_DB.prepare(
          'SELECT artifact_id, deleted_at FROM comment_threads WHERE id = ?'
        ).bind(threadId).first<{ artifact_id: string; deleted_at: number | null }>();
        if (!threadRow || threadRow.deleted_at) return new Response('Not found', { status: 404 });

        const access = await requireCommentAccess(request, env, threadRow.artifact_id);
        if (access instanceof Response) return access;

        const now = Math.floor(Date.now() / 1000);
        await env.TOSS_DB.prepare(
          'UPDATE comment_threads SET deleted_at = ?, deleted_by_token_hash = ?, updated_at = ? WHERE id = ?'
        ).bind(now, NO_TOKEN, now, threadId).run();
        return new Response(null, { status: 204 });
      }

      const messageMatch = url.pathname.match(/^\/comment-messages\/([a-f0-9-]+)$/);
      if (messageMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
        const messageId = messageMatch[1];

        const row = await env.TOSS_DB.prepare(
          'SELECT m.thread_id, m.author_token_hash, m.deleted_at, t.artifact_id, t.status as thread_status FROM comment_messages m INNER JOIN comment_threads t ON t.id = m.thread_id WHERE m.id = ? AND t.deleted_at IS NULL'
        ).bind(messageId).first<{ thread_id: string; author_token_hash: string; deleted_at: number | null; artifact_id: string; thread_status: string }>();
        if (!row || row.deleted_at) return new Response('Not found', { status: 404 });

        const access = await requireCommentAccess(request, env, row.artifact_id);
        if (access instanceof Response) return access;

        const now = Math.floor(Date.now() / 1000);
        if (request.method === 'PATCH') {
          if (row.thread_status === 'resolved') return new Response('Resolved comments cannot be edited', { status: 409 });
          const message = normalizeMessageInput(await request.json().catch(() => null));
          if (message instanceof Response) return message;
          await env.TOSS_DB.prepare('UPDATE comment_messages SET body = ?, updated_at = ? WHERE id = ?')
            .bind(message, now, messageId)
            .run();
          await env.TOSS_DB.prepare('UPDATE comment_threads SET updated_at = ? WHERE id = ?').bind(now, row.thread_id).run();
          return jsonResponse({ id: messageId, body: message, updatedAt: now, threadUpdatedAt: now });
        }

        await env.TOSS_DB.prepare('UPDATE comment_messages SET deleted_at = ?, deleted_by_token_hash = ?, updated_at = ? WHERE id = ?')
          .bind(now, NO_TOKEN, now, messageId)
          .run();
        await env.TOSS_DB.prepare('UPDATE comment_threads SET updated_at = ? WHERE id = ?').bind(now, row.thread_id).run();
        return new Response(null, { status: 204 });
      }

      // ===== TOKEN MANAGEMENT (admin only) =====
      if (env.MULTI_TENANT === 'true' && url.pathname === '/tokens') {
        if (request.method === 'GET') {
          const auth = await requireAdmin(request, env);
          if (auth instanceof Response) return auth;

          const { results } = await env.TOSS_DB.prepare(
            'SELECT token_hash, label, created_at, is_admin FROM users ORDER BY created_at DESC'
          ).all();
          return new Response(JSON.stringify(results || []), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (request.method === 'POST') {
          const auth = await requireAdmin(request, env);
          if (auth instanceof Response) return auth;

          const body = await request.json() as { label?: string };
          const label = body.label || 'unnamed';
          const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
          const token = Array.from(tokenBytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          const tokenHash = await sha256(token);

          await env.TOSS_DB.prepare(
            'INSERT INTO users (token_hash, label, created_at, is_admin) VALUES (?, ?, ?, ?)'
          ).bind(tokenHash, label, Math.floor(Date.now() / 1000), 0).run();

          return new Response(JSON.stringify({ token, label }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      if (env.MULTI_TENANT === 'true' && url.pathname.match(/^\/tokens\/[a-f0-9]{64}$/) && request.method === 'DELETE') {
        const auth = await requireAdmin(request, env);
        if (auth instanceof Response) return auth;

        const tokenHash = url.pathname.split('/')[2];
        await env.TOSS_DB.prepare('DELETE FROM users WHERE token_hash = ? AND is_admin = 0')
          .bind(tokenHash)
          .run();

        return new Response(JSON.stringify({ revoked: tokenHash }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // ===== SERVE by slug (/s/:slug) =====
      const slugMatch = url.pathname.match(/^\/s\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
      if (slugMatch) {
        const slug = slugMatch[1];
        if (!url.pathname.endsWith('/') && slugMatch[2] === undefined) {
          return Response.redirect(`${url.origin}${url.pathname}/`, 302);
        }
        const row = await env.TOSS_DB.prepare(
          'SELECT id, expires_at, password_hash FROM artifacts WHERE slug = ?'
        ).bind(slug).first<{ id: string; expires_at: number; password_hash: string | null }>();

        if (!row) return new Response('Not found', { status: 404 });

        if (isArtifactExpired(row.expires_at)) {
          return new Response('Link expired', { status: 410 });
        }

        // Password check
        if (row.password_hash) {
          const cookieName = `toss_pwd_${slug}`;
          const cookies = request.headers.get('Cookie') || '';
          const hasSession = cookies.includes(`${cookieName}=1`);

          if (!hasSession) {
            if (request.method === 'POST') {
              const formData = await request.formData();
              const password = formData.get('password') as string;
              const providedHash = password ? await sha256(password + row.id) : '';

              if (constantTimeEqual(providedHash, row.password_hash)) {
                // Correct password: redirect with a session cookie scoped to
                // this share's lifetime (capped at 30d for permanent shares).
                const maxAge = artifactCookieMaxAge(row.expires_at);
                return new Response(null, {
                  status: 302,
                  headers: {
                    Location: `${url.origin}/s/${slug}/`,
                    'Set-Cookie': `${cookieName}=1; Path=/s/${slug}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
                  },
                });
              }

              // Wrong password: show form again
              return passwordFormResponse(slug, true, 401);
            }

            // GET without session: show password form
            return passwordFormResponse(slug, false, 200);
          }
        }

        // Serve content
        let filePath = slugMatch[2] || 'index.html';
        if (filePath.endsWith('/')) filePath += 'index.html';

        filePath = filePath.replace(/\\/g, '/');
        const parts = filePath.split('/').filter((p) => p !== '' && p !== '.');
        if (parts.some((p) => p === '..')) {
          return new Response('Invalid path', { status: 400 });
        }
        filePath = parts.join('/');

        return serveArtifact(row, filePath, request, env, { artifactBasePath: `/s/${slug}/` });
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
          const payload = await verifyJWT(token, env.JWT_SECRET);
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
        return serveArtifact(
          { id, expires_at: verified.expiresAt },
          filePath,
          request,
          env,
          { artifactBasePath: `/a/${id}/` },
        );
      }

      // Root (/) — branded splash; no instance data leaked. (/health is the machine endpoint.)
      if (url.pathname === '/' || url.pathname === '') {
        return new Response(instancePage(url.origin, env.MULTI_TENANT === 'true'), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
        });
      }


      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('Worker error:', err);
      return new Response('Internal server error', { status: 500 });
    }
  },
};
