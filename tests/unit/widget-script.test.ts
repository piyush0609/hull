import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('Vercel comment widget script', () => {
  it('keeps the embedded STYLE declaration valid JavaScript', async () => {
    const source = await readFile('src/templates/vercel/api/index.ts', 'utf8');
    const declaration = source.match(/^  const STYLE = '<style>.*<\/style>';$/m)?.[0];

    expect(declaration).toBeTruthy();
    expect(() => new Function(declaration!)).not.toThrow();
  });
});
