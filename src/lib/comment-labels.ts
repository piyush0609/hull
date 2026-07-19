export const COMMENT_LABEL_SCHEMA = 'toss/comment-labels@v1' as const;
export const COMMENT_LABEL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface CommentLabel {
  key: string;
  label: string;
  description: string;
  color: string;
  enabled: boolean;
  position: number;
}

export interface OwnerCommentLabel extends CommentLabel {
  usageCount: number;
}

export interface CommentLabelRegistry {
  revision: number;
  labels: OwnerCommentLabel[];
}

export interface CommentLabelDocumentV1 {
  $schema: typeof COMMENT_LABEL_SCHEMA;
  version: 1;
  commentLabels: CommentLabel[];
}

export class CommentLabelValidationError extends Error {
  constructor(public problems: string[]) {
    super(problems.join('\n'));
    this.name = 'CommentLabelValidationError';
  }
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function normalizeCommentLabelColor(value: string): string {
  const color = value.startsWith('#') ? value : `#${value}`;
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new CommentLabelValidationError([`color must be a hex color like #9F3826`]);
  }
  return color.toUpperCase();
}

export function emptyCommentLabelDocument(): CommentLabelDocumentV1 {
  return { $schema: COMMENT_LABEL_SCHEMA, version: 1, commentLabels: [] };
}

export function commentLabelDocument(labels: CommentLabel[]): CommentLabelDocumentV1 {
  return {
    $schema: COMMENT_LABEL_SCHEMA,
    version: 1,
    commentLabels: labels
      .slice()
      .sort((a, b) => a.position - b.position || a.key.localeCompare(b.key))
      .map((label) => ({
        key: label.key,
        label: label.label,
        description: label.description,
        color: normalizeCommentLabelColor(label.color),
        enabled: label.enabled,
        position: label.position,
      })),
  };
}

export function serializeCommentLabelDocument(document: CommentLabelDocumentV1): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseCommentLabelDocument(input: string): CommentLabelDocumentV1 {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    throw new CommentLabelValidationError([`invalid JSON: ${error instanceof Error ? error.message : String(error)}`]);
  }
  return validateCommentLabelDocument(value);
}

export function validateCommentLabelDocument(value: unknown): CommentLabelDocumentV1 {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommentLabelValidationError(['document must be a JSON object']);
  }
  const document = value as Record<string, unknown>;
  const topFields = new Set(['$schema', 'version', 'commentLabels']);
  for (const field of Object.keys(document)) if (!topFields.has(field)) problems.push(`unknown field "${field}"`);
  if (document.$schema !== COMMENT_LABEL_SCHEMA) problems.push(`$schema must be "${COMMENT_LABEL_SCHEMA}"`);
  if (document.version !== 1) problems.push('version must be 1');
  if (!Array.isArray(document.commentLabels)) problems.push('commentLabels must be an array');

  const labels: CommentLabel[] = [];
  const keys = new Map<string, number>();
  const positions = new Map<number, number>();
  const allowed = new Set(['key', 'label', 'description', 'color', 'enabled', 'position']);
  if (Array.isArray(document.commentLabels)) document.commentLabels.forEach((raw, index) => {
    const path = `commentLabels[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${path} must be an object`);
      return;
    }
    const row = raw as Record<string, unknown>;
    for (const field of Object.keys(row)) if (!allowed.has(field)) problems.push(`${path}: unknown field "${field}"`);
    const key = row.key;
    if (typeof key !== 'string' || !COMMENT_LABEL_KEY_PATTERN.test(key)) {
      problems.push(`${path}.key must match ^[a-z0-9][a-z0-9-]{0,31}$`);
    } else if (key === 'resolution') {
      problems.push(`${path}.key "resolution" is reserved`);
    } else if (keys.has(key)) {
      problems.push(`${path}.key duplicates commentLabels[${keys.get(key)}].key`);
    } else keys.set(key, index);

    const label = typeof row.label === 'string' ? row.label.trim() : '';
    if (!label || codePointLength(label) > 80) problems.push(`${path}.label must be between 1 and 80 characters`);
    const description = typeof row.description === 'string' ? row.description.trim() : '';
    if (typeof row.description !== 'string' || codePointLength(description) > 240) problems.push(`${path}.description must be a string of at most 240 characters`);
    let color = '';
    if (typeof row.color !== 'string') problems.push(`${path}.color must be a hex color like #9F3826`);
    else {
      try { color = normalizeCommentLabelColor(row.color); }
      catch { problems.push(`${path}.color must be a hex color like #9F3826`); }
    }
    if (typeof row.enabled !== 'boolean') problems.push(`${path}.enabled must be a boolean`);
    const position = row.position;
    if (!Number.isInteger(position) || Number(position) < 1) problems.push(`${path}.position must be a positive integer`);
    else if (positions.has(Number(position))) problems.push(`${path}.position duplicates commentLabels[${positions.get(Number(position))}].position`);
    else positions.set(Number(position), index);

    if (typeof key === 'string' && label && typeof row.description === 'string' && color && typeof row.enabled === 'boolean' && Number.isInteger(position)) {
      labels.push({ key, label, description, color, enabled: row.enabled, position: Number(position) });
    }
  });
  if (problems.length) throw new CommentLabelValidationError(problems);
  return { $schema: COMMENT_LABEL_SCHEMA, version: 1, commentLabels: labels };
}

export function validateCommentLabelKey(key: string): void {
  if (!COMMENT_LABEL_KEY_PATTERN.test(key)) throw new CommentLabelValidationError(['key must match ^[a-z0-9][a-z0-9-]{0,31}$']);
  if (key === 'resolution') throw new CommentLabelValidationError(['"resolution" is reserved']);
}
