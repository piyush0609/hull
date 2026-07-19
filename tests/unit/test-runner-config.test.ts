import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('test runner configuration', () => {
  it('keeps unit, integration, and e2e tests in Vitest while excluding Playwright browser tests', async () => {
    const config = await readFile('vitest.config.ts', 'utf8');

    expect(config).toContain("include: ['tests/**/*.test.ts']");
    expect(config).toContain("exclude: ['tests/browser/**']");
  });
});
