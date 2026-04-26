import { signJWT, verifyJWT } from './jwt.js';

export interface Env {
  TOSS_KV: KVNamespace;
  TOSS_DB: D1Database;
  JWT_SECRET: string;
  OWNER_TOKEN: string;
  MULTI_TENANT?: string;
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

async function resolveUser(request: Request, env: Env): Promise<AuthUser | null> {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const tokenHash = await sha256(token);

  // Always check admin token first
  const adminHash = await sha256(env.OWNER_TOKEN);
  if (constantTimeEqual(tokenHash, adminHash)) {
    return { tokenHash, isAdmin: true };
  }

  // Multi-tenant mode: check registered users table
  if (env.MULTI_TENANT === 'true') {
    const row = await env.TOSS_DB.prepare('SELECT is_admin FROM users WHERE token_hash = ?')
      .bind(tokenHash)
      .first<{ is_admin: number }>();
    if (row) {
      return { tokenHash, isAdmin: row.is_admin === 1 };
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

// --- ID / Slug generation ---

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function generateSlug(name: string): string {
  const base = name
    .replace(/\.html?$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base || 'share'}-${suffix}`;
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
    <h1>🔒 Password Required</h1>
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

function mimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    js: 'application/javascript',
    jsx: 'application/javascript',
    ts: 'application/typescript',
    tsx: 'application/typescript',
    css: 'text/css',
    json: 'application/json',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    txt: 'text/plain',
    xml: 'application/xml',
    pdf: 'application/pdf',
    md: 'text/markdown',
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
  env: Env
): Promise<Response> {
  // Check expiry
  if (meta.expires_at < Math.floor(Date.now() / 1000)) {
    return new Response('Link expired', { status: 410 });
  }

  const obj = await env.TOSS_KV.get(`artifacts/${meta.id}/files/${filePath}`, 'arrayBuffer');
  if (!obj) {
    if (!filePath.endsWith('.html')) {
      const indexObj = await env.TOSS_KV.get(`artifacts/${meta.id}/files/${filePath}/index.html`, 'arrayBuffer');
      if (indexObj) {
        return new Response(indexObj, {
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
    const maxAge = Math.max(0, meta.expires_at - Math.floor(Date.now() / 1000));
    headers['Set-Cookie'] = `toss_tok=${meta.id}; Path=/a/${meta.id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
    headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; frame-ancestors 'none'; base-uri 'none';";
    headers['Cache-Control'] = 'private, no-store, max-age=0';
  } else {
    headers['Cache-Control'] = 'public, max-age=86400, immutable';
  }

  return new Response(obj, { status: 200, headers });
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
        if (!expiresParam) return new Response('Missing expires param', { status: 400 });

        const expiresSeconds = parseInt(expiresParam, 10);
        if (isNaN(expiresSeconds) || expiresSeconds <= 0) {
          return new Response('Invalid expires param', { status: 400 });
        }
        const MAX_TTL = 90 * 24 * 60 * 60;
        if (expiresSeconds > MAX_TTL) {
          return new Response('Max expiry is 90 days', { status: 400 });
        }

        const id = generateId();
        const slug = generateSlug(name);
        const html = await request.text();

        const passwordParam = url.searchParams.get('password');
        const passwordHash = passwordParam ? await sha256(passwordParam + id) : null;

        await env.TOSS_KV.put(`artifacts/${id}/files/index.html`, html);

        const now = Math.floor(Date.now() / 1000);
        await env.TOSS_DB.prepare(
          'INSERT INTO artifacts (id, slug, name, size_bytes, created_at, expires_at, token_hash, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
          .bind(id, slug, name, html.length, now, now + expiresSeconds, auth.tokenHash, passwordHash)
          .run();

        const jwt = await signJWT({ sub: id, iat: now, exp: now + expiresSeconds }, env.JWT_SECRET);
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
        await env.TOSS_DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id).run();

        return new Response(JSON.stringify({ revoked: id }), {
          headers: { 'Content-Type': 'application/json' },
        });
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
        const row = await env.TOSS_DB.prepare(
          'SELECT id, expires_at, password_hash FROM artifacts WHERE slug = ?'
        ).bind(slug).first<{ id: string; expires_at: number; password_hash: string | null }>();

        if (!row) return new Response('Not found', { status: 404 });

        // Check expiry first
        if (row.expires_at < Math.floor(Date.now() / 1000)) {
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
                // Correct password: redirect with cookie
                const maxAge = Math.max(0, row.expires_at - Math.floor(Date.now() / 1000));
                return new Response(null, {
                  status: 302,
                  headers: {
                    Location: `${url.origin}/s/${slug}/`,
                    'Set-Cookie': `${cookieName}=1; Path=/s/${slug}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
                  },
                });
              }

              // Wrong password: show form again
              return new Response(passwordForm(slug, true), {
                status: 401,
                headers: { 'Content-Type': 'text/html' },
              });
            }

            // GET without session: show password form
            return new Response(passwordForm(slug, false), {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
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

        return serveArtifact(row, filePath, request, env);
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
          payload = await verifyJWT(token, env.JWT_SECRET);
          if (payload.sub !== id) return new Response('Invalid token scope', { status: 403 });
          if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
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

        const meta = { id, expires_at: payload.exp as number };
        return serveArtifact(meta, filePath, request, env);
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error('Worker error:', err);
      return new Response('Internal server error', { status: 500 });
    }
  },
};
