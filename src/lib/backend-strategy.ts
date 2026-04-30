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

export interface BackendStrategy {
  name: BackendName;
  setup(options: BackendActionOptions): Promise<void>;
  deploy(options: BackendActionOptions): Promise<void>;
  destroy(options: BackendActionOptions): Promise<void>;
}

type StrategyDeps = {
  cloudflare: Omit<BackendStrategy, 'name'>;
  vercel: Omit<BackendStrategy, 'name'>;
};

export function createBackendStrategies(deps: StrategyDeps): Record<BackendName, BackendStrategy> {
  return {
    cloudflare: { name: 'cloudflare', ...deps.cloudflare },
    vercel: { name: 'vercel', ...deps.vercel },
  };
}

const backendStrategies = createBackendStrategies({
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

export function isBackendName(value: unknown): value is BackendName {
  return value === 'cloudflare' || value === 'vercel';
}

export function normalizeBackendName(value?: string): BackendName | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return isBackendName(normalized) ? normalized : undefined;
}

export function getBackendStrategy(name: BackendName): BackendStrategy {
  return backendStrategies[name];
}

export function resolveBackendForCommand(requestedBackend?: string, profileBackend?: string): BackendName {
  const requested = normalizeBackendName(requestedBackend);
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
  const requested = normalizeBackendName(options.requestedBackend);
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
