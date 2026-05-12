import { describe, expect, it } from 'vitest';
import { extractVercelStorageEnv, parseVercelEnvValue } from '../../src/lib/vercel-env.js';

describe('vercel env parsing', () => {
  it('parses quoted and unquoted env values', () => {
    const content = [
      'DATABASE_URL="postgres://db.example"',
      'BLOB_READ_WRITE_TOKEN=vercel_blob_rw_123',
    ].join('\n');

    expect(parseVercelEnvValue(content, 'DATABASE_URL')).toBe('postgres://db.example');
    expect(parseVercelEnvValue(content, 'BLOB_READ_WRITE_TOKEN')).toBe('vercel_blob_rw_123');
  });

  it('prefers DATABASE_URL and falls back to POSTGRES_URL', () => {
    expect(
      extractVercelStorageEnv('POSTGRES_URL="postgres://from-postgres"\nBLOB_READ_WRITE_TOKEN="blob_1"')
    ).toEqual({
      databaseUrl: 'postgres://from-postgres',
      blobToken: 'blob_1',
    });

    expect(
      extractVercelStorageEnv(
        'DATABASE_URL="postgres://from-database"\nPOSTGRES_URL="postgres://from-postgres"\nBLOB_READ_WRITE_TOKEN="blob_2"'
      )
    ).toEqual({
      databaseUrl: 'postgres://from-database',
      blobToken: 'blob_2',
    });
  });
});
