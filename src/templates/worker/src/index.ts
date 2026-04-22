import { signJWT, verifyJWT } from './jwt.js';

export interface Env {
  TOSS_KV: KVNamespace;
  TOSS_DB: D1Database;
  JWT_SECRET: string;
  OWNER_TOKEN: string;
}

function requireOwner(request: Request, env: Env): Response | null {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.OWNER_TOKEN}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  return null;
}

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Upload artifact (creates ID + stores main file)
      if (url.pathname === '/artifacts' && request.method === 'POST') {
        const authErr = requireOwner(request, env);
        if (authErr) return authErr;

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
        const html = await request.text();

        await env.TOSS_KV.put(`artifacts/${id}/files/index.html`, html);

        const now = Math.floor(Date.now() / 1000);
        await env.TOSS_DB.prepare(
          'INSERT INTO artifacts (id, name, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
        )
          .bind(id, name, html.length, now, now + expiresSeconds)
          .run();

        const jwt = await signJWT({ sub: id, iat: now, exp: now + expiresSeconds }, env.JWT_SECRET);
        const shareUrl = `${url.origin}/a/${id}?t=${jwt}`;
        return new Response(JSON.stringify({ id, url: shareUrl }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Upload additional files to an existing artifact
      const filesMatch = url.pathname.match(/^\/artifacts\/([a-f0-9-]+)\/files$/);
      if (filesMatch && request.method === 'POST') {
        const authErr = requireOwner(request, env);
        if (authErr) return authErr;

        const id = filesMatch[1];
        let filePath = url.searchParams.get('path');
        if (!filePath) return new Response('Missing path param', { status: 400 });

        // Normalize and reject path traversal
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

      // List
      if (url.pathname === '/artifacts' && request.method === 'GET') {
        const authErr = requireOwner(request, env);
        if (authErr) return authErr;

        const { results } = await env.TOSS_DB.prepare(
          'SELECT id, name, size_bytes, created_at, expires_at FROM artifacts ORDER BY created_at DESC'
        ).all();

        return new Response(JSON.stringify(results || []), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Delete / Revoke
      if (url.pathname.match(/^\/artifacts\/[a-f0-9-]+$/) && request.method === 'DELETE') {
        const authErr = requireOwner(request, env);
        if (authErr) return authErr;

        const id = url.pathname.split('/')[2];
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

      // Serve artifact files
      const serveMatch = url.pathname.match(/^\/a\/([a-f0-9-]+)(?:\/(.*))?$/);
      if (serveMatch) {
        const id = serveMatch[1];

        // Redirect /a/{id} → /a/{id}/ so relative URLs resolve correctly
        if (!url.pathname.endsWith('/') && serveMatch[2] === undefined) {
          return Response.redirect(`${url.origin}${url.pathname}/?${url.searchParams.toString()}`, 302);
        }

        // Validate auth: query token OR cookie
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

        const obj = await env.TOSS_KV.get(`artifacts/${id}/files/${filePath}`, 'arrayBuffer');
        if (!obj) {
          if (!filePath.endsWith('.html')) {
            const indexObj = await env.TOSS_KV.get(`artifacts/${id}/files/${filePath}/index.html`, 'arrayBuffer');
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
          const maxAge = Math.max(0, (payload.exp as number) - Math.floor(Date.now() / 1000));
          headers['Set-Cookie'] = `toss_tok=${token}; Path=/a/${id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
          headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; frame-ancestors 'none'; base-uri 'none';";
          // Auth-gated HTML: never cache
          headers['Cache-Control'] = 'private, no-store, max-age=0';
        } else {
          // Static assets: cache at edge for 1 day since they're immutable per artifact
          headers['Cache-Control'] = 'public, max-age=86400, immutable';
        }

        return new Response(obj, { status: 200, headers });
      }

      return new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response(`Error: ${err instanceof Error ? err.message : String(err)}`, { status: 500 });
    }
  },
};
