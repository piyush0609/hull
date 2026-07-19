import type { TossConfig } from './config.js';
import type { CommentLabel, CommentLabelDocumentV1, CommentLabelRegistry } from './comment-labels.js';

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`Could not reach ${url}. Is your toss deployed and reachable?`);
  }
}

export class TossAPIError extends Error {
  constructor(
    message: string,
    public status: number,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'TossAPIError';
  }
}

async function apiJson<T>(res: Response, operation: string): Promise<T> {
  const text = typeof res.text === 'function' ? await res.text() : '';
  let body: any = {};
  if (text) {
    try { body = JSON.parse(text); }
    catch {
      if (res.ok) throw new TossAPIError(`${operation} returned invalid JSON.`, res.status);
      body = { message: text };
    }
  } else if (typeof res.json === 'function') body = await res.json();
  if (!res.ok) {
    const message = body.message || body.error || `${operation} failed`;
    throw new TossAPIError(`${operation} failed: ${res.status} ${message}`, res.status, body);
  }
  return body as T;
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
  async getComments(id: string, opts: { password?: string; version?: number } = {}): Promise<Record<string, any> & { threads: unknown[]; activityThreads: unknown[]; commentLabels?: CommentLabel[]; commentLabelRevision?: number }> {
    const url = new URL(`/artifacts/${id}/comment-threads`, this.config.endpoint);
    url.searchParams.set('pagePath', 'index.html');
    url.searchParams.set('includeActivity', '1');
    // version pins the read to a specific seq (whole version, all pages); omitted = latest.
    if (opts.version != null) url.searchParams.set('version', String(opts.version));
    const headers: Record<string, string> = { Authorization: this.authHeader() };
    if (opts.password) headers['X-Toss-Password'] = opts.password;
    const res = await safeFetch(url.href, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch comments: ${res.status} ${text}`);
    }
    return res.json();
  }

  // List the artifact's versions (seq, hash, created_at, comment count, current
  // marker). Same access gating as comment reads; works even if comments are off.
  async getVersions(id: string, opts: { password?: string } = {}): Promise<{ artifactId: string; versions: Array<{ seq: number; content_hash: string; created_at: number; comment_count: number; is_current: boolean }> }> {
    const url = new URL(`/artifacts/${id}/versions`, this.config.endpoint);
    const headers: Record<string, string> = { Authorization: this.authHeader() };
    if (opts.password) headers['X-Toss-Password'] = opts.password;
    const res = await safeFetch(url.href, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to fetch versions: ${res.status} ${text}`);
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

  private async commentLabelsRequest<T>(path = '', init: RequestInit = {}): Promise<T> {
    const url = new URL(`/comment-labels${path}`, this.config.endpoint);
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: this.authHeader(),
    };
    if (init.body != null) headers['Content-Type'] = 'application/json';
    const res = await safeFetch(url.href, { ...init, headers });
    return apiJson<T>(res, 'Comment labels request');
  }

  async getCommentLabels(): Promise<CommentLabelRegistry> {
    const body = await this.commentLabelsRequest<any>();
    return {
      revision: body.commentLabelRevision ?? body.revision,
      labels: body.commentLabels ?? body.labels ?? [],
    };
  }

  async createCommentLabel(expectedRevision: number, label: Omit<CommentLabel, 'position'> & { position?: number }): Promise<CommentLabelRegistry> {
    const body = await this.commentLabelsRequest<any>('', {
      method: 'POST', body: JSON.stringify({ expectedRevision, commentLabel: label }),
    });
    return { revision: body.commentLabelRevision ?? body.revision, labels: body.commentLabels ?? body.labels ?? [] };
  }

  async updateCommentLabel(key: string, expectedRevision: number, changes: Partial<Omit<CommentLabel, 'key'>>): Promise<CommentLabelRegistry> {
    const body = await this.commentLabelsRequest<any>(`/${encodeURIComponent(key)}`, {
      method: 'PATCH', body: JSON.stringify({ expectedRevision, changes }),
    });
    return { revision: body.commentLabelRevision ?? body.revision, labels: body.commentLabels ?? body.labels ?? [] };
  }

  async deleteCommentLabel(key: string, expectedRevision: number): Promise<CommentLabelRegistry> {
    const body = await this.commentLabelsRequest<any>(`/${encodeURIComponent(key)}`, {
      method: 'DELETE', body: JSON.stringify({ expectedRevision }),
    });
    return { revision: body.commentLabelRevision ?? body.revision, labels: body.commentLabels ?? body.labels ?? [] };
  }

  async reorderCommentLabels(expectedRevision: number, keys: string[]): Promise<CommentLabelRegistry> {
    const body = await this.commentLabelsRequest<any>('/order', {
      method: 'PUT', body: JSON.stringify({ expectedRevision, keys }),
    });
    return { revision: body.commentLabelRevision ?? body.revision, labels: body.commentLabels ?? body.labels ?? [] };
  }

  async previewCommentLabelApply(document: CommentLabelDocumentV1): Promise<Record<string, any>> {
    return this.commentLabelsRequest('/apply?dryRun=1', { method: 'POST', body: JSON.stringify({ document }) });
  }

  async applyCommentLabels(expectedRevision: number, document: CommentLabelDocumentV1): Promise<CommentLabelRegistry> {
    const body = await this.commentLabelsRequest<any>('/apply', {
      method: 'POST', body: JSON.stringify({ expectedRevision, document }),
    });
    return { revision: body.commentLabelRevision ?? body.revision, labels: body.commentLabels ?? body.labels ?? [] };
  }

  async previewCommentLabelClear(): Promise<Record<string, any>> {
    return this.commentLabelsRequest('/clear?dryRun=1', { method: 'POST' });
  }

  async clearCommentLabels(expectedRevision: number): Promise<CommentLabelRegistry> {
    const body = await this.commentLabelsRequest<any>('/clear', {
      method: 'POST', body: JSON.stringify({ expectedRevision }),
    });
    return { revision: body.commentLabelRevision ?? body.revision, labels: body.commentLabels ?? body.labels ?? [] };
  }
}
