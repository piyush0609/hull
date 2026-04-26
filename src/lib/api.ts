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

  async upload(html: Buffer, name: string, expiresSeconds: number, password?: string): Promise<{ id: string; slug: string; url: string; legacyUrl: string }> {
    const url = new URL('/artifacts', this.config.endpoint);
    url.searchParams.set('expires', String(expiresSeconds));
    url.searchParams.set('name', name);
    if (password) url.searchParams.set('password', password);

    const res = await safeFetch(url.href, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.ownerToken}`,
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

  async uploadFile(artifactId: string, relativePath: string, data: Buffer): Promise<void> {
    const url = new URL(`/artifacts/${artifactId}/files`, this.config.endpoint);
    url.searchParams.set('path', relativePath);

    const res = await safeFetch(url.href, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.ownerToken}`,
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
      headers: { Authorization: `Bearer ${this.config.ownerToken}` },
    });
    if (!res.ok) throw new Error(`List failed: ${res.status}`);
    return res.json();
  }

  async revoke(id: string): Promise<void> {
    const res = await safeFetch(`${this.config.endpoint}/artifacts/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.config.ownerToken}` },
    });
    if (!res.ok) throw new Error(`Revoke failed: ${res.status}`);
  }
}
