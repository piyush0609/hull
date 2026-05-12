import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  applyMigrationFile,
  ensureSchemaMigrationsTable,
  getAppliedMigrations,
  splitStatements,
} = require('../../src/templates/vercel/migration-runner.cjs');

describe('vercel migration runner', () => {
  it('splits SQL files into executable statements', () => {
    expect(splitStatements('CREATE TABLE a();\n\nALTER TABLE a ADD COLUMN b INT;\n')).toEqual([
      'CREATE TABLE a()',
      'ALTER TABLE a ADD COLUMN b INT',
    ]);
  });

  it('creates and reads schema migrations state', async () => {
    const queries: any[] = [];
    const sql = {
      query: vi.fn(async (statement: string) => {
        queries.push(statement);
        if (statement.includes('SELECT filename FROM schema_migrations')) {
          return [{ filename: '0001_init.sql' }];
        }
        return [];
      }),
    };

    await ensureSchemaMigrationsTable(sql);
    const applied = await getAppliedMigrations(sql);

    expect(applied.has('0001_init.sql')).toBe(true);
    expect(queries[0]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
  });

  it('wraps each migration file in a transaction and records it once', async () => {
    const calls: any[] = [];
    const sql = {
      query: vi.fn(async (...args: any[]) => {
        calls.push(args);
        return [];
      }),
    };

    const changed = await applyMigrationFile(
      sql,
      '0004_comments_page_path.sql',
      "ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS page_path TEXT NOT NULL DEFAULT 'index.html';"
    );

    expect(changed).toBe(true);
    expect(calls.map((args) => args[0])).toEqual([
      'BEGIN',
      "ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS page_path TEXT NOT NULL DEFAULT 'index.html'",
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      'COMMIT',
    ]);
    expect(calls[2][1]).toEqual(['0004_comments_page_path.sql']);
  });

  it('rolls back when a migration statement fails', async () => {
    const sql = {
      query: vi.fn(async (statement: string) => {
        if (statement === 'BROKEN SQL') {
          throw new Error('boom');
        }
        return [];
      }),
    };

    await expect(applyMigrationFile(sql, '0005_broken.sql', 'BROKEN SQL;')).rejects.toThrow('boom');
    expect(sql.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
