import { deployCommand } from '../commands/deploy.js';
import { deployVercelCommand } from '../commands/deploy-vercel.js';
import { destroyCommand } from '../commands/destroy.js';
import { destroyVercelCommand } from '../commands/destroy-vercel.js';
import { setupCommand } from '../commands/setup.js';
import { setupVercelCommand } from '../commands/setup-vercel.js';
import { promptSelect } from './prompt.js';

export type BackendName = 'cloudflare' | 'vercel';

export type BackendActionOptions = {
  backend?: string;
  profile?: string;
  yes?: boolean;
  [key: string]: unknown;
};

export interface BackendHandler {
  name: BackendName;
  setup(options: BackendActionOptions): Promise<void>;
  deploy(options: BackendActionOptions): Promise<void>;
  destroy(options: BackendActionOptions): Promise<void>;
}

type HandlerDeps = {
  cloudflare: Omit<BackendHandler, 'name'>;
  vercel: Omit<BackendHandler, 'name'>;
};

export function createBackendHandlers(deps: HandlerDeps): Record<BackendName, BackendHandler> {
  return {
    cloudflare: { name: 'cloudflare', ...deps.cloudflare },
    vercel: { name: 'vercel', ...deps.vercel },
  };
}

const backendHandlers = createBackendHandlers({
  cloudflare: {
    setup: setupCommand,
    deploy: deployCommand,
    destroy: destroyCommand,
  },
  vercel: {
    setup: setupVercelCommand,
    deploy: deployVercelCommand,
    destroy: destroyVercelCommand,
  },
});

export class BackendValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendValidationError';
  }
}

export function isBackendName(value: unknown): value is BackendName {
  return value === 'cloudflare' || value === 'vercel';
}

// Coerce a missing/empty value to undefined; otherwise return a valid backend
// or throw. Used for explicit caller input (e.g. --backend) where a typo must
// fail fast rather than silently fall through to a default.
export function parseBackendName(value: string | undefined, source: string): BackendName | undefined {
  if (value === undefined || value === '') return undefined;
  const normalized = value.toLowerCase();
  if (!isBackendName(normalized)) {
    throw new BackendValidationError(
      `Invalid backend "${value}" from ${source}. Must be one of: cloudflare, vercel.`
    );
  }
  return normalized;
}

// Lenient variant for stored values (e.g. an old profile written before we
// validated): unknown values become undefined so the caller can fall back.
export function normalizeBackendName(value?: string): BackendName | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return isBackendName(normalized) ? normalized : undefined;
}

export function getBackendHandler(name: BackendName): BackendHandler {
  return backendHandlers[name];
}

export function resolveBackendForCommand(requestedBackend?: string, profileBackend?: string): BackendName {
  const requested = parseBackendName(requestedBackend, '--backend');
  if (requested) return requested;

  const saved = normalizeBackendName(profileBackend);
  if (saved) return saved;

  return 'cloudflare';
}

export async function resolveBackendForSetup(options: {
  requestedBackend?: string;
  profileBackend?: string;
  promptOnMissing?: boolean;
} = {}): Promise<BackendName> {
  const requested = parseBackendName(options.requestedBackend, '--backend');
  if (requested) return requested;

  const saved = normalizeBackendName(options.profileBackend);
  if (saved) return saved;

  if (options.promptOnMissing) {
    const backend = await promptSelect('Where do you want to deploy toss?', [
      { label: 'Cloudflare', value: 'cloudflare' as const },
      { label: 'Vercel', value: 'vercel' as const },
    ]);
    return backend;
  }

  return 'cloudflare';
}
