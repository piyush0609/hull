import { describe, expect, it } from 'vitest';
import {
  deriveDeploymentSuffix,
  getCloudflareResourceNames,
  getVercelProjectName,
} from '../../src/lib/deployment-target.js';

describe('deployment target naming', () => {
  it('keeps the default deployment on toss for owner-like profiles', () => {
    expect(deriveDeploymentSuffix()).toBe('toss');
    expect(deriveDeploymentSuffix('default')).toBe('toss');
    expect(deriveDeploymentSuffix('owner')).toBe('toss');
  });

  it('derives a unique suffix from the profile name when no subdomain is saved', () => {
    expect(deriveDeploymentSuffix('client-a')).toBe('client-a');
    expect(deriveDeploymentSuffix('Demo_Team')).toBe('demo-team');
    expect(deriveDeploymentSuffix('client team')).toBe('client-team');
  });

  it('prefers explicit subdomain values over derived profile names', () => {
    expect(deriveDeploymentSuffix('client-a', 'shared-demo')).toBe('shared-demo');
    expect(deriveDeploymentSuffix('client-a', undefined, 'env-override')).toBe('env-override');
  });

  it('produces different Vercel project names for different profiles', () => {
    const defaultProject = getVercelProjectName(deriveDeploymentSuffix('owner'));
    const clientProject = getVercelProjectName(deriveDeploymentSuffix('client-a'));

    expect(defaultProject).toBe('toss');
    expect(clientProject).toBe('toss-client-a');
    expect(clientProject).not.toBe(defaultProject);
  });

  it('produces different Cloudflare resource names for different profiles', () => {
    const defaultNames = getCloudflareResourceNames(deriveDeploymentSuffix('owner'));
    const clientNames = getCloudflareResourceNames(deriveDeploymentSuffix('client-a'));

    expect(defaultNames).toEqual({
      workerName: 'toss',
      dbName: 'toss-db',
      kvTitle: 'toss-kv',
    });
    expect(clientNames).toEqual({
      workerName: 'toss-client-a',
      dbName: 'toss-db-client-a',
      kvTitle: 'toss-kv-client-a',
    });
  });

  it('reuses the same targets when the same profile is deployed again', () => {
    const firstSuffix = deriveDeploymentSuffix('client-a');
    const secondSuffix = deriveDeploymentSuffix('client-a');

    expect(firstSuffix).toBe(secondSuffix);
    expect(getVercelProjectName(firstSuffix)).toBe(getVercelProjectName(secondSuffix));
    expect(getCloudflareResourceNames(firstSuffix)).toEqual(getCloudflareResourceNames(secondSuffix));
  });
});
