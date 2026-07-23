import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const migrations = require('../../src/templates/vercel/migrate.js');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fakeClient(handler?: (text: string, values?: unknown[]) => unknown) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  return {
    queries,
    connect: vi.fn(async () => undefined),
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      const value = handler?.(text, values);
      if (text.includes('FROM pg_catalog.pg_namespace')) return value ?? { rows: [{ '?column?': 1 }], rowCount: 1 };
      return value ?? { rows: [], rowCount: 0 };
    }),
    end: vi.fn(async () => undefined),
  };
}

describe('Vercel migration runner', () => {
  it('pins pg and the Node-18-compatible Neon client exactly', () => {
    const pkg = require('../../src/templates/vercel/package.json');
    const lock = require('../../src/templates/vercel/package-lock.json');
    expect(pkg.dependencies.pg).toBe('8.22.0');
    expect(pkg.dependencies['@neondatabase/serverless']).toBe('0.10.4');
    expect(lock.packages['node_modules/pg'].version).toBe('8.22.0');
    expect(lock.packages['node_modules/@neondatabase/serverless'].version).toBe('0.10.4');
    expect(lock.packages['node_modules/@neondatabase/serverless'].engines?.node || '').not.toMatch(/>=19/);
  });

  it('exposes the gated PostgreSQL suite as an exactly sequential script', () => {
    const root = require('../../package.json');
    expect(root.scripts['test:postgres:comment-labels']).toBe('vitest run tests/integration/vercel-comment-labels-postgres.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism');
  });

  it('splits only semicolons outside quotes, dollar blocks, and comments', () => {
    const sql = `SELECT ';'; DO $$ BEGIN PERFORM 1; PERFORM 'x;y'; END $$; -- ignored ;\n/* nested /* ; */ ; */ SELECT 2`;
    expect(migrations.splitSqlStatements(sql)).toHaveLength(3);
  });

  it('selects pre and post phases without mixing contract files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'toss-migrations-'));
    temporaryDirectories.push(directory);
    await Promise.all(['0001.sql', '0010.sql', '0011.post.sql'].map((file) => writeFile(join(directory, file), 'SELECT 1;')));
    expect(migrations.migrationFiles(directory, 'pre')).toEqual(['0001.sql', '0010.sql']);
    expect(migrations.migrationFiles(directory, 'post')).toEqual(['0011.post.sql']);
  });

  it('takes the advisory lock then rechecks the marker before executing a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'toss-migrations-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, '0010.sql'), 'SELECT 42;');
    const client = fakeClient();
    await migrations.applyMigration(client, directory, '0010.sql');
    expect(client.queries.map((query) => query.text)).toEqual([
      'BEGIN',
      `SELECT pg_advisory_xact_lock(${migrations.TOSS_MIGRATION_ADVISORY_LOCK}::bigint)`,
      'SELECT 1 FROM "public".schema_migrations WHERE filename = $1',
      'SET LOCAL search_path = "public", pg_catalog',
      'SELECT 42',
      'INSERT INTO "public".schema_migrations (filename) VALUES ($1)',
      'COMMIT',
    ]);
  });

  it('skips an already marked file while retaining the same transaction lock', async () => {
    const client = fakeClient((text) => text.includes('.schema_migrations WHERE filename') ? { rows: [{ '?column?': 1 }], rowCount: 1 } : undefined);
    await expect(migrations.applyMigration(client, '.', 'missing.sql')).resolves.toBe(false);
    expect(client.queries.at(-1)?.text).toBe('COMMIT');
    expect(client.queries.some((query) => query.text.includes('INSERT INTO') && query.text.includes('schema_migrations'))).toBe(false);
  });

  it('rolls back a failed statement and always ends the one session client', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'toss-migrations-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, '0010.sql'), 'SELECT broken;');
    const client = fakeClient((text) => { if (text === 'SELECT broken') throw new Error('injected failure'); });
    await expect(migrations.run({ databaseUrl: 'postgres://localhost/test?sslmode=disable', phase: 'pre', migrationsDir: directory, client })).rejects.toThrow('injected failure');
    expect(client.queries.some((query) => query.text === 'ROLLBACK')).toBe(true);
    expect(client.queries.some((query) => query.text.includes('INSERT INTO') && query.text.includes('schema_migrations'))).toBe(false);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('derives SSL without exposing or rewriting the database URL', () => {
    expect(migrations.databaseSsl('postgres://localhost/db?sslmode=disable')).toBe(false);
    expect(migrations.databaseSsl('postgres://host/db?sslmode=no-verify')).toEqual({ rejectUnauthorized: false });
    for (const mode of ['require', 'verify-ca', 'verify-full']) {
      expect(migrations.databaseSsl(`postgres://host/db?sslmode=${mode}`), mode).toEqual({ rejectUnauthorized: true });
    }
    expect(migrations.databaseSsl('postgres://host/db?sslmode=prefer')).toBeUndefined();
    expect(migrations.databaseSsl('postgres://host/db?sslmode=allow')).toBeUndefined();
    expect(migrations.databaseSsl('postgres://host/db', { VERCEL: '1' })).toEqual({ rejectUnauthorized: true });
    expect(migrations.databaseSsl('postgres://localhost/db', {})).toBeUndefined();
  });

  it('rejects an unexpanded database and accepts only consistent expanded states', async () => {
    const unexpanded = fakeClient(() => ({ rows: [{ has_state: false, has_labels: false, has_messages: true, has_ledger: false }], rowCount: 1 }));
    await expect(migrations.probeSchema(unexpanded)).resolves.toMatchObject({ valid: false, state: 'unexpanded' });

    const expandedRow = {
      rows: 1, singleton_ok: true, revision_ok: true, revision: 0, ready: false, kind_expanded: true,
      state_columns_ok: true, state_defaults_ok: true, label_columns_ok: true, ledger_columns_ok: true, ledger_default_ok: true,
      state_check_count_ok: true, state_pk_ok: true, ledger_pk_ok: true, singleton_check_ok: true, revision_check_ok: true,
      label_check_count_ok: true, label_pk_ok: true, key_check_ok: true, label_check_ok: true,
      description_check_ok: true, color_check_ok: true, resolution_check_ok: true,
      hidden_resolution_ok: true, one_hidden_resolution: true, position_constraint_ok: true, label_unique_count_ok: true,
      old_kind_check_absent: true, kind_fk_count: 0, exact_fk: false, expand_marker: true, contract_marker: false,
      epoch_rollout_marker: true,
    };
    let calls = 0;
    const expanded = fakeClient(() => ({ rows: [calls++ === 0 ? { has_state: true, has_labels: true, has_messages: true, has_ledger: true } : expandedRow], rowCount: 1 }));
    await expect(migrations.probeSchema(expanded)).resolves.toEqual({ valid: true, state: 'expanded' });

    for (const field of ['state_columns_ok', 'state_defaults_ok', 'label_columns_ok', 'ledger_columns_ok', 'singleton_check_ok', 'key_check_ok', 'description_check_ok', 'color_check_ok', 'resolution_check_ok', 'position_constraint_ok', 'hidden_resolution_ok', 'epoch_rollout_marker']) {
      calls = 0;
      const malformed = fakeClient(() => ({ rows: [calls++ === 0 ? { has_state: true, has_labels: true, has_messages: true, has_ledger: true } : { ...expandedRow, [field]: false }], rowCount: 1 }));
      await expect(migrations.probeSchema(malformed), field).resolves.toMatchObject({ valid: false, state: 'inconsistent' });
    }

    calls = 0;
    const inconsistent = fakeClient(() => ({ rows: [calls++ === 0 ? { has_state: true, has_labels: true, has_messages: true, has_ledger: true } : { ...expandedRow, ready: true, revision: 1, kind_fk_count: 1, exact_fk: false, contract_marker: true }], rowCount: 1 }));
    await expect(migrations.probeSchema(inconsistent)).resolves.toMatchObject({ valid: false, state: 'inconsistent' });
  });

  it('gates the epoch rollout marker in the contracted state so a missing 0012 aborts --skip-migrate', async () => {
    const contractedRow = {
      rows: 1, singleton_ok: true, revision_ok: true, revision: 1, ready: true, kind_expanded: true,
      state_columns_ok: true, state_defaults_ok: true, label_columns_ok: true, ledger_columns_ok: true, ledger_default_ok: true,
      state_check_count_ok: true, state_pk_ok: true, ledger_pk_ok: true, singleton_check_ok: true, revision_check_ok: true,
      label_check_count_ok: true, label_pk_ok: true, key_check_ok: true, label_check_ok: true,
      description_check_ok: true, color_check_ok: true, resolution_check_ok: true,
      hidden_resolution_ok: true, one_hidden_resolution: true, position_constraint_ok: true, label_unique_count_ok: true,
      old_kind_check_absent: true, kind_fk_count: 1, exact_fk: true, expand_marker: true, contract_marker: true,
    };

    let calls = 0;
    const withoutRollout = fakeClient(() => ({ rows: [calls++ === 0 ? { has_state: true, has_labels: true, has_messages: true, has_ledger: true } : { ...contractedRow, epoch_rollout_marker: false }], rowCount: 1 }));
    await expect(migrations.probeSchema(withoutRollout)).resolves.toMatchObject({ valid: false, state: 'inconsistent' });

    calls = 0;
    const withRollout = fakeClient(() => ({ rows: [calls++ === 0 ? { has_state: true, has_labels: true, has_messages: true, has_ledger: true } : { ...contractedRow, epoch_rollout_marker: true }], rowCount: 1 }));
    await expect(migrations.probeSchema(withRollout)).resolves.toEqual({ valid: true, state: 'contracted' });
  });

  it('applies the real 0012 epoch rollout file once and short-circuits on the ledger marker', async () => {
    const migrationsDir = fileURLToPath(new URL('../../src/templates/vercel/migrations/', import.meta.url));
    const filename = '0012_password_session_epoch_rollout.sql';

    let markerPresent = false;
    const client = fakeClient((text) => {
      if (text.includes('.schema_migrations WHERE filename')) return markerPresent ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO') && text.includes('schema_migrations')) { markerPresent = true; return undefined; }
      return undefined;
    });

    await expect(migrations.applyMigration(client, migrationsDir, filename)).resolves.toBe(true);
    const updates = client.queries.filter((query) => /UPDATE artifacts SET password_epoch = password_epoch \+ 1 WHERE password_hash IS NOT NULL/.test(query.text));
    expect(updates).toHaveLength(1);
    const inserts = client.queries.filter((query) => query.text.includes('INSERT INTO') && query.text.includes('schema_migrations'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].values).toEqual([filename]);

    const before = client.queries.length;
    await expect(migrations.applyMigration(client, migrationsDir, filename)).resolves.toBe(false);
    const secondRun = client.queries.slice(before);
    expect(secondRun.some((query) => query.text.includes('UPDATE artifacts'))).toBe(false);
    expect(secondRun.some((query) => query.text.includes('INSERT INTO') && query.text.includes('schema_migrations'))).toBe(false);
    expect(secondRun.at(-1)?.text).toBe('COMMIT');
  });

  it('pins production to public and isolated tests to a transaction-local schema', async () => {
    expect(() => migrations.validateTargetSchema('bad-name')).toThrow('Invalid migration target schema');
    const directory = await mkdtemp(join(tmpdir(), 'toss-migrations-'));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, '0010.sql'), 'SELECT current_schema();');
    const client = fakeClient();
    await migrations.applyMigration(client, directory, '0010.sql', 'isolated_test');
    expect(client.queries[1].text).toContain('pg_advisory_xact_lock');
    expect(client.queries[2].text).toBe('SELECT 1 FROM "isolated_test".schema_migrations WHERE filename = $1');
    expect(client.queries[3].text).toBe('SET LOCAL search_path = "isolated_test", pg_catalog');
    expect(client.queries.every((query) => !/ALTER (ROLE|DATABASE)/i.test(query.text))).toBe(true);
  });
});
