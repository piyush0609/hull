import { describe, it, expect } from 'vitest';
import { chooseEndpoint, isVercelAppEndpoint, isAlreadyCurrentProduction } from '../../src/commands/deploy-vercel.js';

describe('chooseEndpoint', () => {
  const deployUrl = 'https://toss-team-abc123-scope.vercel.app';

  it('uses an explicit --domain when provided', () => {
    expect(chooseEndpoint('share.example.com', 'https://old.example.com', deployUrl))
      .toBe('https://share.example.com');
  });

  it('preserves an existing custom-domain endpoint (does not clobber it with the deploy URL)', () => {
    expect(chooseEndpoint(undefined, 'https://share.realfast.ai', deployUrl))
      .toBe('https://share.realfast.ai');
  });

  it('replaces a per-deploy *.vercel.app endpoint with the new deploy URL', () => {
    expect(chooseEndpoint(undefined, 'https://toss-team-old-scope.vercel.app', deployUrl))
      .toBe(deployUrl);
  });

  it('uses the deploy URL on a first deploy (no existing endpoint)', () => {
    expect(chooseEndpoint(undefined, undefined, deployUrl)).toBe(deployUrl);
    expect(chooseEndpoint(undefined, null, deployUrl)).toBe(deployUrl);
  });
});

describe('isVercelAppEndpoint', () => {
  it('detects vercel.app hosts (stable alias and per-deploy)', () => {
    expect(isVercelAppEndpoint('https://toss-team.vercel.app')).toBe(true);
    expect(isVercelAppEndpoint('https://toss-team-abc123-scope.vercel.app')).toBe(true);
  });

  it('treats custom domains and junk as non-vercel.app', () => {
    expect(isVercelAppEndpoint('https://share.realfast.ai')).toBe(false);
    expect(isVercelAppEndpoint(undefined)).toBe(false);
    expect(isVercelAppEndpoint(null)).toBe(false);
    expect(isVercelAppEndpoint('not-a-url')).toBe(false);
  });
});

describe('isAlreadyCurrentProduction', () => {
  it('detects the 409 "already current" promote response (success, not failure)', () => {
    expect(isAlreadyCurrentProduction('Error: The provided deploymentId (dpl_x) is already the current production deployment. (409)')).toBe(true);
    expect(isAlreadyCurrentProduction('already the current production deployment')).toBe(true);
  });

  it('treats real promote failures and empty input as not-already-current', () => {
    expect(isAlreadyCurrentProduction('Error: deployment not found')).toBe(false);
    expect(isAlreadyCurrentProduction('')).toBe(false);
    expect(isAlreadyCurrentProduction(undefined)).toBe(false);
    expect(isAlreadyCurrentProduction(null)).toBe(false);
  });
});
