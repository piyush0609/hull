import type { TossConfig } from './config.js';

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`Could not reach ${url}. Is your toss deployed and reachable?`);
  }
}

export class TossAPI {
  constructor(private config: TossConfig) {}

  private authHeader(): string {
    return `Bearer ${this.config.token || this.config.ownerToken || ''}`;
  }

  async upload(html: Buffer, name: string, expiresSeconds: number, password?: string, id?: string, comments?: boolean, force?: boolean, totalBytes?: number): Promise<{ id: string; slug: string; url: string; legacyUrl: string; updated?: boolean }> {
    const url = new URL('/artifacts', this.config.endpoint);
    // expiresSeconds === 0 signals "never expires"
    url.searchParams.set('expires', String(expiresSeconds));
    url.searchParams.set('name', name);
    if (password) url.searchParams.set('password', password);
    if (id) url.searchParams.set('id', id);
    if (comments) url.searchParams.set('comments', '1');
    if (force) url.searchParams.set('force', '1');
    // Folder shares: the body is only the entry HTML, so tell the server the whole
    // folder's byte total — otherwise `toss list` would report just the index size.
    if (totalBytes != null) url.searchParams.set('total_bytes', String(totalBytes));

    const res = await safeFetch(url.href, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'text/html',
      },
      body: new Uint8Array(html),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  // Programmatic retrieval. Owner/admin or artifact-owner via the token; for a doc
  // you don't own, pass the document password (sent as X-Toss-Password, never logged
  // in args — the CLI sources it from an env key).
  async getComments(id: string, opts: { password?: string } = {}): Promise<{ pagePath: string; threads: unknown[]; activityThreads: unknown[] }> {
    const url = new URL(`/artifacts/${id}/comment-threads`, this.config.endpoint);
    url.searchParams.set('pagePath', 'index.html');
    url.searchParams.set('includeActivity', '1');
    const headers: Record<string, string> = { Authorization: this.authHeader() };
    if (opts.password) headers['X-Toss-Password'] = opts.password;
    const res = await safeFetch(url.href, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch comments: ${res.status} ${text}`);
    }
    return res.json();
  }

  async uploadFile(artifactId: string, relativePath: string, data: Buffer): Promise<void> {
    const url = new URL(`/artifacts/${artifactId}/files`, this.config.endpoint);
    url.searchParams.set('path', relativePath);

    const res = await safeFetch(url.href, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/octet-stream',
      },
      body: new Uint8Array(data),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed for ${relativePath}: ${res.status} ${text}`);
    }
  }

  async list(): Promise<Array<{ id: string; slug?: string; name: string; size_bytes: number; created_at: number; expires_at: number }>> {
    const res = await safeFetch(`${this.config.endpoint}/artifacts`, {
      headers: { Authorization: this.authHeader() },
    });
    if (!res.ok) throw new Error(`List failed: ${res.status}`);
    return res.json();
  }

  async revoke(id: string): Promise<void> {
    const res = await safeFetch(`${this.config.endpoint}/artifacts/${id}`, {
      method: 'DELETE',
      headers: { Authorization: this.authHeader() },
    });
    if (!res.ok) throw new Error(`Revoke failed: ${res.status}`);
  }

  async setComments(id: string, enabled: boolean): Promise<void> {
    const res = await safeFetch(`${this.config.endpoint}/artifacts/${id}/comments`, {
      method: 'PATCH',
      headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} comments: ${res.status} ${text}`);
    }
  }
}
