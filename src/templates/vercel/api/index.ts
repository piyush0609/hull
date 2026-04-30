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
}

async function resolveUser(request: Request): Promise<AuthUser | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const tokenHash = await sha256(token);

  const adminHash = await sha256(OWNER_TOKEN);
  if (constantTimeEqual(tokenHash, adminHash)) {
    return { tokenHash, isAdmin: true };
  }

  if (MULTI_TENANT) {
    const sql = getSQL();
    const rows = await sql`SELECT is_admin FROM users WHERE token_hash = ${tokenHash}`;
    if (rows[0]) {
      return { tokenHash, isAdmin: rows[0].is_admin === 1 };
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

// --- Serve artifact ---
interface ArtifactMeta {
  id: string;
  expires_at: number;
}

async function serveArtifact(meta: ArtifactMeta, filePath: string, request: Request): Promise<Response> {
  // expires_at = 0 means permanent (never expires).
  if (meta.expires_at > 0 && meta.expires_at < Math.floor(Date.now() / 1000)) {
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
    // Permanent shares: 30d cookie life. Time-bound shares: scope to remaining lifetime.
    const maxAge = meta.expires_at === 0
      ? 30 * 86400
      : Math.max(0, meta.expires_at - Math.floor(Date.now() / 1000));
    headers['Set-Cookie'] = `toss_tok=${meta.id}; Path=/a/${meta.id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; frame-ancestors 'none'; base-uri 'none';";
    headers['Cache-Control'] = 'private, no-store, max-age=0';
  } else {
    headers['Cache-Control'] = 'public, max-age=86400, immutable';
  }

  return new Response(stream, { status: 200, headers });
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

      await blobPut(`artifacts/${id}/files/index.html`, html, 'text/html');

      // expires_at = 0 in the row signals "never expires".
      const expiresAt = expiresSeconds === 0 ? 0 : (now + expiresSeconds);
      await sql`INSERT INTO artifacts (id, slug, name, size_bytes, created_at, expires_at, token_hash, password_hash) VALUES (${id}, ${slug}, ${name}, ${html.length}, ${now}, ${expiresAt}, ${auth.tokenHash}, ${passwordHash})`;

      // Legacy /a/:id?t=jwt URL — for permanent shares we mark the JWT with
      // `permanent: true` so the verifier can normalize expires_at = 0 instead
      // of treating the far-future `exp` as a real expiry (which would cause
      // a 100-year cookie max-age).
      const jwtPayload: Record<string, unknown> = { sub: id, iat: now };
      if (expiresSeconds === 0) {
        jwtPayload.permanent = true;
        jwtPayload.exp = now + (100 * 365 * 86400);
      } else {
        jwtPayload.exp = now + expiresSeconds;
      }
      const jwt = await signJWT(jwtPayload, JWT_SECRET);
      const legacyUrl = `${url.origin}/a/${id}?t=${jwt}`;
      const shortUrl = `${url.origin}/s/${slug}`;

      return new Response(JSON.stringify({ id, slug, url: shortUrl, legacyUrl }), {
        headers: { 'Content-Type': 'application/json' },
      });
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

      return new Response(JSON.stringify({ uploaded: filePath }), {
        headers: { 'Content-Type': 'application/json' },
      });
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

      return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' },
      });
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
      await sql`DELETE FROM artifacts WHERE id = ${id}`;

      return new Response(JSON.stringify({ revoked: id }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== TOKEN MANAGEMENT (admin only) =====
    if (MULTI_TENANT && url.pathname === '/tokens') {
      const sql = getSQL();

      if (request.method === 'GET') {
        const auth = await requireAdmin(request);
        if (auth instanceof Response) return auth;

        const results = await sql`SELECT token_hash, label, created_at, is_admin FROM users ORDER BY created_at DESC`;
        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json' },
        });
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

        return new Response(JSON.stringify({ token, label }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (MULTI_TENANT && url.pathname.match(/^\/tokens\/[a-f0-9]{64}$/) && request.method === 'DELETE') {
      const auth = await requireAdmin(request);
      if (auth instanceof Response) return auth;

      const tokenHash = url.pathname.split('/')[2];
      const sql = getSQL();
      await sql`DELETE FROM users WHERE token_hash = ${tokenHash} AND is_admin = 0`;

      return new Response(JSON.stringify({ revoked: tokenHash }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ===== SERVE by slug (/s/:slug) =====
    const slugMatch = url.pathname.match(/^\/s\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
    if (slugMatch) {
      const slug = slugMatch[1];
      const sql = getSQL();
      const rows = await sql`SELECT id, expires_at, password_hash FROM artifacts WHERE slug = ${slug}`;

      if (!rows[0]) return new Response('Not found', { status: 404 });

      // expires_at = 0 means permanent (never expires).
      if (rows[0].expires_at > 0 && rows[0].expires_at < Math.floor(Date.now() / 1000)) {
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
              // Permanent shares: give the cookie a 30d life; time-bound shares: scope to remaining lifetime.
              const maxAge = rows[0].expires_at === 0
                ? 30 * 86400
                : Math.max(0, rows[0].expires_at - Math.floor(Date.now() / 1000));
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

      return serveArtifact(rows[0], filePath, request);
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

      let payload: Record<string, unknown>;
      try {
        payload = await verifyJWT(token, JWT_SECRET);
        if (payload.sub !== id) return new Response('Invalid token scope', { status: 403 });
        // Permanent JWTs skip the exp check; everything else uses exp as before.
        const isPermanent = payload.permanent === true;
        if (!isPermanent && typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
          return new Response('Link expired', { status: 410 });
        }
      } catch {
        return new Response('Invalid token', { status: 401 });
      }

      let filePath = serveMatch[2] || 'index.html';
      if (filePath.endsWith('/')) filePath += 'index.html';

      filePath = filePath.replace(/\\/g, '/');
      const parts = filePath.split('/').filter((p) => p !== '' && p !== '.');
      if (parts.some((p) => p === '..')) {
        return new Response('Invalid path', { status: 400 });
      }
      filePath = parts.join('/');

      // Normalize permanent tokens to expires_at = 0 so the cookie max-age
      // and 410 guard in serveArtifact() take the permanent branch.
      const meta: ArtifactMeta = {
        id,
        expires_at: payload.permanent === true ? 0 : (payload.exp as number),
      };
      return serveArtifact(meta, filePath, request);
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
