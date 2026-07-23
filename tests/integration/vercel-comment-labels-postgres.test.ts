import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { insertCommentReply, readCommentSnapshot } from '../../src/templates/vercel/api/index.ts';

const databaseUrl = process.env.TOSS_TEST_DATABASE_URL;
const designatedHost = process.env.TOSS_TEST_DATABASE_HOST;
const designatedDatabase = process.env.TOSS_TEST_DATABASE_NAME;
const RUN = Boolean(databaseUrl && designatedHost && designatedDatabase);
const templateRequire = createRequire(new URL('../../src/templates/vercel/migrate.js', import.meta.url));
const migrations = templateRequire('./migrate.js');

function validateDesignation() {
  if (!databaseUrl || !designatedHost || !designatedDatabase) throw new Error('Dedicated PostgreSQL test variables are required');
  const parsed = new URL(databaseUrl);
  const actualDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (parsed.hostname !== designatedHost || actualDatabase !== designatedDatabase) throw new Error('Dedicated PostgreSQL host/database designations do not match the URL');
  const productionPattern = /(^|[.-])(prod|production)([.-]|$)/i;
  if (productionPattern.test(designatedHost) || productionPattern.test(designatedDatabase)) throw new Error('Production-like PostgreSQL designations are forbidden');
}

async function withIsolatedSchema(run: (context: { Client: any; schema: string; connect: () => Promise<any>; inspector: any }) => Promise<void>) {
  validateDesignation();
  const { Client } = templateRequire('pg');
  const schema = `toss_comment_labels_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const connect = async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); return client; };
  const inspector = await connect();
  let originalSearchPath = '';
  let originalPublicTables = '';
  try {
    await inspector.query('BEGIN READ ONLY');
    originalSearchPath = (await inspector.query('SHOW search_path')).rows[0].search_path;
    const identity = (await inspector.query('SELECT current_database() AS database')).rows[0];
    expect(identity.database).toBe(designatedDatabase);
    originalPublicTables = JSON.stringify((await inspector.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows);
    await inspector.query('ROLLBACK');
    await inspector.query(`CREATE SCHEMA "${schema}"`);
    await run({ Client, schema, connect, inspector });
  } finally {
    await inspector.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await inspector.end();
    const verifier = await connect();
    try {
      expect((await verifier.query('SHOW search_path')).rows[0].search_path).toBe(originalSearchPath);
      expect(JSON.stringify((await verifier.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows)).toBe(originalPublicTables);
    } finally { await verifier.end(); }
  }
}

function postgresTag(client: any) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((result, part, index) => result + part + (index < values.length ? `$${index + 1}` : ''), '');
    return (await client.query(text, values)).rows;
  };
}

function postgresNeonAdapter(client: any, schema: string) {
  const query = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((result, part, index) => result + part + (index < values.length ? `$${index + 1}` : ''), '');
    return { text, values };
  };
  const sql: any = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = query(strings, ...values);
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL search_path = "${schema}", pg_catalog`);
      const result = await client.query(statement.text, statement.values);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  };
  sql.transaction = async (builder: (tx: any) => Array<{ text: string; values: unknown[] }>) => {
    const statements = builder(query);
    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL search_path = "${schema}", pg_catalog`);
      const results = [];
      for (const statement of statements) results.push((await client.query(statement.text, statement.values)).rows);
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  };
  return sql;
}

describe.skipIf(!RUN)('Vercel comment labels PostgreSQL migrations', () => {
  it('uses only an isolated schema and leaves public unchanged', async () => {
    validateDesignation();
    const { Client } = templateRequire('pg');
    const schema = `toss_comment_labels_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
    const connect = async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); return client; };
    const inspector = await connect();
    let originalSearchPath = '';
    let originalPublicTables = '';
    try {
      await inspector.query('BEGIN READ ONLY');
      originalSearchPath = (await inspector.query('SHOW search_path')).rows[0].search_path;
      const identity = (await inspector.query('SELECT current_database() AS database, current_user AS username')).rows[0];
      expect(identity.database).toBe(designatedDatabase);
      originalPublicTables = JSON.stringify((await inspector.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows);
      await inspector.query('ROLLBACK');

      await inspector.query(`CREATE SCHEMA "${schema}"`);
      const preClient = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: preClient });
      const postClient = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
      await migrations.run({ databaseUrl, phase: 'post', schema, client: postClient });
      const replayPre = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: replayPre });
      const replayPost = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
      await migrations.run({ databaseUrl, phase: 'post', schema, client: replayPost });

      const state = (await inspector.query(`SELECT revision, contract_ready FROM "${schema}".comment_label_registry_state`)).rows[0];
      expect(Number(state.revision)).toBe(1);
      expect(state.contract_ready).toBe(true);
      const labels = (await inspector.query(`SELECT key, enabled, position FROM "${schema}".comment_labels ORDER BY position`)).rows;
      expect(labels).toEqual([{ key: 'resolution', enabled: false, position: 0 }]);
      const kind = (await inspector.query(`SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'comment_messages' AND column_name = 'kind'`, [schema])).rows[0];
      expect(kind).toEqual({ is_nullable: 'YES', column_default: null });
      const markers = await inspector.query(`SELECT filename FROM "${schema}".schema_migrations WHERE filename LIKE '001%' ORDER BY filename`);
      expect(markers.rows.map((row: any) => row.filename)).toEqual(['0010_configurable_comment_labels_expand.sql', '0011_configurable_comment_labels_contract.post.sql', '0012_password_session_epoch_rollout.sql']);

      const probeClient = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
      const probe = await migrations.run({ databaseUrl, phase: 'probe', schema, client: probeClient });
      expect(probe).toEqual({ valid: true, state: 'contracted' });
    } finally {
      await inspector.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await inspector.end();
      const verifier = await connect();
      try {
        expect((await verifier.query('SHOW search_path')).rows[0].search_path).toBe(originalSearchPath);
        expect(JSON.stringify((await verifier.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows)).toBe(originalPublicTables);
      } finally { await verifier.end(); }
    }
  }, 120_000);

  it('serializes concurrent runners and executes every migration once', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      const first = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
      const second = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
      await Promise.all([
        migrations.run({ databaseUrl, phase: 'pre', schema, client: first }),
        migrations.run({ databaseUrl, phase: 'pre', schema, client: second }),
      ]);
      const markers = await inspector.query(`SELECT filename, COUNT(*)::int AS count FROM "${schema}".schema_migrations GROUP BY filename HAVING COUNT(*) <> 1`);
      expect(markers.rows).toEqual([]);
      expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".schema_migrations`)).rows[0].count)).toBeGreaterThan(0);
    });
  }, 120_000);

  it('releases advisory locks and rolls back work after abrupt connection termination', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      const directory = await mkdtemp(join(tmpdir(), 'toss-abrupt-migration-'));
      try {
        const filename = '0099_abrupt.sql';
        await writeFile(join(directory, filename), 'CREATE TABLE abrupt_work (id integer); SELECT pg_sleep(30);');
        const raw = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) });
        let connected!: () => void;
        const connectedPromise = new Promise<void>((resolve) => { connected = resolve; });
        const wrapped = {
          get processID() { return raw.processID; },
          async connect() { await raw.connect(); connected(); },
          query: (...args: any[]) => raw.query(...args),
          end: () => raw.end(),
        };
        const running = migrations.run({ databaseUrl, phase: 'pre', schema, migrationsDir: directory, client: wrapped });
        await connectedPromise;
        await new Promise((resolve) => setTimeout(resolve, 250));
        await writeFile(join(directory, filename), 'CREATE TABLE abrupt_work (id integer);');
        const waiting = migrations.run({ databaseUrl, phase: 'pre', schema, migrationsDir: directory, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await inspector.query('SELECT pg_terminate_backend($1) AS terminated', [raw.processID])).rows[0].terminated).toBe(true);
        await expect(running).rejects.toThrow();
        await waiting;
        expect((await inspector.query(`SELECT to_regclass('"${schema}".abrupt_work') AS table_name`)).rows[0].table_name).not.toBeNull();
        expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".schema_migrations WHERE filename = $1`, [filename])).rows[0].count)).toBe(1);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }, 120_000);

  it('rolls back normal statement, expand, and contract failures without markers and retries cleanly', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      const normalDir = await mkdtemp(join(tmpdir(), 'toss-normal-failure-'));
      const stagedDir = await mkdtemp(join(tmpdir(), 'toss-staged-failure-'));
      try {
        await writeFile(join(normalDir, '0001_failure.sql'), 'CREATE TABLE normal_work (id integer); SELECT * FROM missing_relation;');
        await expect(migrations.run({ databaseUrl, phase: 'pre', schema, migrationsDir: normalDir, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) })).rejects.toThrow();
        expect((await inspector.query(`SELECT to_regclass('"${schema}".normal_work') AS value`)).rows[0].value).toBeNull();
        expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".schema_migrations WHERE filename='0001_failure.sql'`)).rows[0].count)).toBe(0);
        await writeFile(join(normalDir, '0001_failure.sql'), 'CREATE TABLE normal_work (id integer);');
        await migrations.run({ databaseUrl, phase: 'pre', schema, migrationsDir: normalDir, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });

        await inspector.query(`CREATE TABLE "${schema}".comment_threads (id text primary key, artifact_id text not null, created_by_token_hash text not null, created_by_label text not null, scope_type text not null, anchor_json text, status text not null default 'open', resolved_by_token_hash text, resolved_by_label text, resolved_at integer, deleted_at integer, deleted_by_token_hash text, created_at integer not null, updated_at integer not null, page_path text not null default 'index.html', version_id text)`);
        await inspector.query(`CREATE TABLE "${schema}".comment_messages (id text primary key, thread_id text not null, author_token_hash text not null, author_label text not null, body text not null, created_at integer not null, updated_at integer not null, deleted_at integer, deleted_by_token_hash text, kind text not null default 'note' CONSTRAINT comment_messages_kind_check CHECK (kind IN ('note','resolution')))`);
        const expandName = '0010_configurable_comment_labels_expand.sql';
        const contractName = '0011_configurable_comment_labels_contract.post.sql';
        const expand = await readFile('src/templates/vercel/migrations/0010_configurable_comment_labels_expand.sql', 'utf8');
        const contract = await readFile('src/templates/vercel/migrations/0011_configurable_comment_labels_contract.post.sql', 'utf8');
        await writeFile(join(stagedDir, expandName), `${expand}\nSELECT * FROM missing_expand_relation;`);
        await expect(migrations.run({ databaseUrl, phase: 'pre', schema, migrationsDir: stagedDir, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) })).rejects.toThrow();
        expect((await inspector.query(`SELECT to_regclass('"${schema}".comment_labels') AS value`)).rows[0].value).toBeNull();
        expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".schema_migrations WHERE filename=$1`, [expandName])).rows[0].count)).toBe(0);
        await writeFile(join(stagedDir, expandName), expand);
        await migrations.run({ databaseUrl, phase: 'pre', schema, migrationsDir: stagedDir, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
        await inspector.query(`INSERT INTO "${schema}".comment_threads (id,artifact_id,created_by_token_hash,created_by_label,scope_type,status,created_at,updated_at) VALUES ('rollback-thread','artifact','','Old','artifact','open',1,1)`);
        await inspector.query(`INSERT INTO "${schema}".comment_messages (id,thread_id,author_token_hash,author_label,body,kind,created_at,updated_at) VALUES ('rollback-message','rollback-thread','','Old','Body','note',1,1)`);
        await writeFile(join(stagedDir, contractName), `${contract}\nSELECT * FROM missing_contract_relation;`);
        await expect(migrations.run({ databaseUrl, phase: 'post', schema, migrationsDir: stagedDir, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) })).rejects.toThrow();
        expect((await inspector.query(`SELECT kind FROM "${schema}".comment_messages WHERE id='rollback-message'`)).rows[0].kind).toBe('note');
        expect((await inspector.query(`SELECT contract_ready FROM "${schema}".comment_label_registry_state`)).rows[0].contract_ready).toBe(false);
        expect(Number((await inspector.query(`SELECT COUNT(*) FROM pg_constraint WHERE conrelid='"${schema}".comment_messages'::regclass AND conname='comment_messages_kind_comment_labels_fk'`)).rows[0].count)).toBe(0);
        expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".schema_migrations WHERE filename=$1`, [contractName])).rows[0].count)).toBe(0);
        await writeFile(join(stagedDir, contractName), contract);
        await migrations.run({ databaseUrl, phase: 'post', schema, migrationsDir: stagedDir, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
        expect((await inspector.query(`SELECT kind FROM "${schema}".comment_messages WHERE id='rollback-message'`)).rows[0].kind).toBeNull();
      } finally {
        await Promise.all([rm(normalDir, { recursive: true, force: true }), rm(stagedDir, { recursive: true, force: true })]);
      }
    });
  }, 120_000);

  it('waits for an old writer, clears its ordinary kind, then validates the contract', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      const writer = await (async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); return client; })();
      await writer.query('BEGIN');
      await writer.query(`SET LOCAL search_path = "${schema}", pg_catalog`);
      await writer.query(`INSERT INTO comment_threads (id, artifact_id, created_by_token_hash, created_by_label, scope_type, status, created_at, updated_at) VALUES ('held-thread', 'artifact', '', 'Old', 'artifact', 'open', 1, 1)`);
      await writer.query(`INSERT INTO comment_messages (id, thread_id, author_token_hash, author_label, body, kind, created_at, updated_at) VALUES ('held-message', 'held-thread', '', 'Old', 'legacy-kind', 'note', 1, 1)`);
      let settled = false;
      const post = migrations.run({ databaseUrl, phase: 'post', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) }).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(settled).toBe(false);
      await writer.query('COMMIT');
      await writer.end();
      await post;
      expect((await inspector.query(`SELECT kind FROM "${schema}".comment_messages WHERE id = 'held-message'`)).rows[0].kind).toBeNull();
      expect((await inspector.query(`SELECT contract_ready FROM "${schema}".comment_label_registry_state`)).rows[0].contract_ready).toBe(true);
    });
  }, 120_000);

  it('rejects malformed expanded and contracted probe fixtures', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await inspector.query(`ALTER TABLE "${schema}".comment_labels DROP CONSTRAINT comment_labels_position_unique`);
      await inspector.query(`ALTER TABLE "${schema}".comment_labels ADD CONSTRAINT comment_labels_position_unique UNIQUE (position) NOT DEFERRABLE`);
      const malformedExpanded = await migrations.run({ databaseUrl, phase: 'probe', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      expect(malformedExpanded).toMatchObject({ valid: false, state: 'inconsistent' });
      await inspector.query(`ALTER TABLE "${schema}".comment_labels DROP CONSTRAINT comment_labels_position_unique`);
      await inspector.query(`ALTER TABLE "${schema}".comment_labels ADD CONSTRAINT comment_labels_position_unique UNIQUE (position) DEFERRABLE INITIALLY DEFERRED`);
      await migrations.run({ databaseUrl, phase: 'post', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await inspector.query(`ALTER TABLE "${schema}".comment_messages ALTER CONSTRAINT comment_messages_kind_comment_labels_fk NOT DEFERRABLE`);
      const malformedContract = await migrations.run({ databaseUrl, phase: 'probe', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      expect(malformedContract).toMatchObject({ valid: false, state: 'inconsistent' });
    });
  }, 120_000);

  it('uses the production one-statement GET snapshot and serial write-versus-disable/delete outcomes', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await migrations.run({ databaseUrl, phase: 'post', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await inspector.query(`INSERT INTO "${schema}".comment_labels (key,label,description,color,enabled,position) VALUES ('review','Review','Review feedback','#AABBCC',true,1)`);
      await inspector.query(`UPDATE "${schema}".comment_label_registry_state SET revision = revision + 1`);
      await inspector.query(`INSERT INTO "${schema}".artifacts (id,comments_enabled) VALUES ('snapshot-artifact',1)`);
      await inspector.query(`INSERT INTO "${schema}".comment_threads (id,artifact_id,created_by_token_hash,created_by_label,scope_type,status,created_at,updated_at) VALUES ('snapshot-old','snapshot-artifact','','Race','artifact','open',1,1)`);
      const snapshotClient = await (async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); await client.query('BEGIN'); await client.query(`SET LOCAL search_path = "${schema}", pg_catalog`); return client; })();
      const readProductionSnapshot = async () => (await readCommentSnapshot(postgresTag(snapshotClient), { artifactId: 'snapshot-artifact', requestedVersion: null, pagePath: 'index.html', includeActivity: true }))[0];
      const oldSnapshot = await readProductionSnapshot();
      const mutation = await (async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); return client; })();
      await mutation.query('BEGIN');
      await mutation.query(`UPDATE "${schema}".comment_labels SET label = 'Changed' WHERE key = 'review'`);
      await mutation.query(`INSERT INTO "${schema}".comment_threads (id,artifact_id,created_by_token_hash,created_by_label,scope_type,status,created_at,updated_at) VALUES ('snapshot-new','snapshot-artifact','','Race','artifact','open',2,2)`);
      await mutation.query(`UPDATE "${schema}".comment_label_registry_state SET revision = revision + 1`);
      const racingSnapshot = await readProductionSnapshot();
      expect(racingSnapshot).toEqual(oldSnapshot);
      await snapshotClient.query('ROLLBACK'); await snapshotClient.query('BEGIN'); await snapshotClient.query(`SET LOCAL search_path = "${schema}", pg_catalog`);
      await mutation.query('COMMIT'); await mutation.end();
      const newSnapshot = await readProductionSnapshot();
      await snapshotClient.query('ROLLBACK'); await snapshotClient.end();
      expect(Number(newSnapshot.revision)).toBe(Number(oldSnapshot.revision) + 1);
      expect(oldSnapshot.comment_labels[0].label).toBe('Review');
      expect(newSnapshot.comment_labels[0].label).toBe('Changed');
      expect(oldSnapshot.threads.map((thread: any) => thread.id)).toEqual(['snapshot-old']);
      expect(newSnapshot.threads.map((thread: any) => thread.id)).toEqual(['snapshot-new', 'snapshot-old']);

      await inspector.query(`INSERT INTO "${schema}".comment_threads (id, artifact_id, created_by_token_hash, created_by_label, scope_type, status, created_at, updated_at) VALUES ('race-thread', 'artifact', '', 'Race', 'artifact', 'open', 1, 1)`);
      const writer = await (async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); return client; })();
      await writer.query('BEGIN');
      await writer.query(`SET LOCAL search_path = "${schema}", pg_catalog`);
      await writer.query(`SELECT contract_ready FROM comment_label_registry_state WHERE singleton = true FOR UPDATE`);
      await writer.query(`INSERT INTO comment_messages (id,thread_id,author_token_hash,author_label,body,kind,created_at,updated_at) SELECT 'race-message','race-thread','','Race','Body','review',1,1 WHERE EXISTS (SELECT 1 FROM comment_labels WHERE key='review' AND enabled)`);
      const disable = inspector.query(`WITH locked AS (SELECT revision FROM "${schema}".comment_label_registry_state FOR UPDATE), changed AS (UPDATE "${schema}".comment_labels SET enabled=false WHERE key='review' RETURNING key) UPDATE "${schema}".comment_label_registry_state SET revision=revision+1 WHERE EXISTS (SELECT 1 FROM changed)`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writer.query('COMMIT'); await writer.end(); await disable;
      expect((await inspector.query(`SELECT kind FROM "${schema}".comment_messages WHERE id='race-message'`)).rows[0].kind).toBe('review');
      expect((await inspector.query(`SELECT enabled FROM "${schema}".comment_labels WHERE key='review'`)).rows[0].enabled).toBe(false);
      const rejectedWriter = await inspector.query(`WITH state AS MATERIALIZED (SELECT contract_ready FROM "${schema}".comment_label_registry_state WHERE singleton=true FOR UPDATE), inserted AS (INSERT INTO "${schema}".comment_messages (id,thread_id,author_token_hash,author_label,body,kind,created_at,updated_at) SELECT 'rejected-message','race-thread','','Race','Body','review',2,2 FROM state WHERE contract_ready AND EXISTS (SELECT 1 FROM "${schema}".comment_labels WHERE key='review' AND enabled) RETURNING id) SELECT id FROM inserted`);
      expect(rejectedWriter.rows).toEqual([]);
      expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".comment_messages WHERE id='rejected-message'`)).rows[0].count)).toBe(0);

      await inspector.query(`UPDATE "${schema}".comment_labels SET enabled=true WHERE key='review'`);
      const deleteWriter = await (async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); return client; })();
      await deleteWriter.query('BEGIN');
      await deleteWriter.query(`SET LOCAL search_path = "${schema}", pg_catalog`);
      await deleteWriter.query(`SELECT revision FROM comment_label_registry_state WHERE singleton=true FOR UPDATE`);
      await deleteWriter.query(`INSERT INTO comment_messages (id,thread_id,author_token_hash,author_label,body,kind,created_at,updated_at) VALUES ('delete-race-message','race-thread','','Race','Body','review',3,3)`);
      const deleting = inspector.query(`WITH locked AS MATERIALIZED (SELECT revision FROM "${schema}".comment_label_registry_state WHERE singleton=true FOR UPDATE), removed AS (DELETE FROM "${schema}".comment_labels label WHERE key='review' AND EXISTS (SELECT 1 FROM locked) AND NOT EXISTS (SELECT 1 FROM "${schema}".comment_messages message WHERE message.kind=label.key) RETURNING key) SELECT key FROM removed`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await deleteWriter.query('COMMIT'); await deleteWriter.end();
      expect((await deleting).rows).toEqual([]);
      expect((await inspector.query(`SELECT key FROM "${schema}".comment_labels WHERE key='review'`)).rows[0].key).toBe('review');
    });
  }, 120_000);

  it('rejects direct resolved replies and serializes resolve-versus-reply', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await migrations.run({ databaseUrl, phase: 'post', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await inspector.query(`INSERT INTO "${schema}".comment_threads (id,artifact_id,created_by_token_hash,created_by_label,scope_type,status,created_at,updated_at) VALUES ('resolved-thread','artifact','','Race','artifact','resolved',1,1),('racing-thread','artifact','','Race','artifact','open',1,1)`);
      const direct = await (async () => { await inspector.query('BEGIN'); await inspector.query(`SET LOCAL search_path = "${schema}", pg_catalog`); const rows = await insertCommentReply(postgresTag(inspector), { threadId: 'resolved-thread', messageId: 'direct-reply', name: 'Race', message: 'No', kind: null, now: 2 }); await inspector.query('ROLLBACK'); return rows[0]; })();
      expect(direct).toMatchObject({ thread_exists: true, thread_status: 'resolved', inserted: false });
      expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".comment_messages WHERE id='direct-reply'`)).rows[0].count)).toBe(0);

      const resolver = await (async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); await client.query('BEGIN'); await client.query(`UPDATE "${schema}".comment_threads SET status='resolved' WHERE id='racing-thread'`); return client; })();
      const replyClient = await (async () => { const client = new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }); await client.connect(); await client.query('BEGIN'); await client.query(`SET LOCAL search_path = "${schema}", pg_catalog`); return client; })();
      let replySettled = false;
      const racingReply = insertCommentReply(postgresTag(replyClient), { threadId: 'racing-thread', messageId: 'racing-reply', name: 'Race', message: 'No', kind: null, now: 3 }).finally(() => { replySettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(replySettled).toBe(false);
      await resolver.query('COMMIT'); await resolver.end();
      const outcome = (await racingReply)[0];
      await replyClient.query('COMMIT'); await replyClient.end();
      expect(outcome).toMatchObject({ thread_status: 'resolved', inserted: false });
      expect(Number((await inspector.query(`SELECT COUNT(*) FROM "${schema}".comment_messages WHERE id='racing-reply'`)).rows[0].count)).toBe(0);
    });
  }, 120_000);

  it('patches each target once and clears mixed registries with contiguous order and one revision bump', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await migrations.run({ databaseUrl, phase: 'post', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await inspector.query(`INSERT INTO "${schema}".comment_labels (key,label,description,color,enabled,position) VALUES ('alpha','Alpha','A','#111111',true,1),('beta','Beta','B','#222222',true,2),('gamma','Gamma','G','#333333',true,3),('delta','Delta','D','#444444',false,4)`);
      await inspector.query(`UPDATE "${schema}".comment_label_registry_state SET revision = 10`);
      await inspector.query(`INSERT INTO "${schema}".comment_threads (id,artifact_id,created_by_token_hash,created_by_label,scope_type,status,created_at,updated_at) VALUES ('owner-mutation-thread','artifact','','Owner','artifact','open',1,1)`);
      await inspector.query(`INSERT INTO "${schema}".comment_messages (id,thread_id,author_token_hash,author_label,body,kind,created_at,updated_at) VALUES ('used-beta','owner-mutation-thread','','Owner','Beta','beta',1,1),('used-delta','owner-mutation-thread','','Owner','Delta','delta',2,2)`);

      process.env.OWNER_TOKEN = 'postgres-owner-secret';
      process.env.MULTI_TENANT = 'false';
      process.env.DATABASE_URL = 'postgres://example.invalid/toss';
      vi.resetModules();
      try {
        const backend = await import('../../src/templates/vercel/api/index.ts');
        backend.setVercelSqlForTests(postgresNeonAdapter(inspector, schema));
        const request = (path: string, body: unknown) => backend.default(new Request(`https://toss.test${path}`, {
          method: path === '/comment-labels/clear' ? 'POST' : 'PATCH',
          headers: { authorization: 'Bearer postgres-owner-secret', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }));

        const metadata = await request('/comment-labels/beta', { expectedRevision: 10, changes: { label: 'Beta updated' } });
        expect(metadata.status).toBe(200);
        expect((await metadata.json() as any).revision).toBe(11);
        const position = await request('/comment-labels/gamma', { expectedRevision: 11, changes: { position: 1 } });
        expect(position.status).toBe(200);
        expect((await position.json() as any).revision).toBe(12);
        const combined = await request('/comment-labels/alpha', { expectedRevision: 12, changes: { label: 'Alpha updated', enabled: false, position: 3 } });
        expect(combined.status).toBe(200);
        const combinedBody = await combined.json() as any;
        expect(combinedBody.revision).toBe(13);
        expect(combinedBody.commentLabels.map((label: any) => [label.key, label.position])).toEqual([['gamma', 1], ['beta', 2], ['alpha', 3], ['delta', 4]]);
        expect(combinedBody.commentLabels.find((label: any) => label.key === 'alpha')).toMatchObject({ label: 'Alpha updated', enabled: false, position: 3 });
        expect(combinedBody.commentLabels.find((label: any) => label.key === 'beta')).toMatchObject({ label: 'Beta updated', position: 2 });

        const cleared = await request('/comment-labels/clear', { expectedRevision: 13 });
        expect(cleared.status).toBe(200);
        const clearedBody = await cleared.json() as any;
        expect(clearedBody.revision).toBe(14);
        expect(clearedBody.commentLabels).toEqual([
          { key: 'beta', label: 'Beta updated', description: 'B', color: '#222222', enabled: false, position: 1, usageCount: 1 },
          { key: 'delta', label: 'Delta', description: 'D', color: '#444444', enabled: false, position: 2, usageCount: 1 },
        ]);
        expect((await inspector.query(`SELECT key, enabled, position FROM "${schema}".comment_labels WHERE key <> 'resolution' ORDER BY position`)).rows).toEqual([
          { key: 'beta', enabled: false, position: 1 },
          { key: 'delta', enabled: false, position: 2 },
        ]);
        expect(Number((await inspector.query(`SELECT revision FROM "${schema}".comment_label_registry_state`)).rows[0].revision)).toBe(14);
      } finally {
        delete process.env.OWNER_TOKEN;
        delete process.env.MULTI_TENANT;
        delete process.env.DATABASE_URL;
      }
    });
  }, 120_000);

  it('enforces label and description limits by non-BMP Unicode code point in PostgreSQL CHECK constraints', async () => {
    await withIsolatedSchema(async ({ Client, schema, inspector }) => {
      await migrations.run({ databaseUrl, phase: 'pre', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      await migrations.run({ databaseUrl, phase: 'post', schema, client: new Client({ connectionString: databaseUrl, ssl: migrations.databaseSsl(databaseUrl) }) });
      const emoji = '😀';
      const label80 = emoji.repeat(80);
      const description240 = emoji.repeat(240);

      await inspector.query(
        `INSERT INTO "${schema}".comment_labels (key,label,description,color,enabled,position) VALUES ($1,$2,$3,$4,$5,$6)`,
        ['unicode-boundary', label80, description240, '#AABBCC', true, 1],
      );
      const accepted = (await inspector.query(
        `SELECT length(label)::int AS label_length, length(description)::int AS description_length FROM "${schema}".comment_labels WHERE key = $1`,
        ['unicode-boundary'],
      )).rows[0];
      expect(accepted).toEqual({ label_length: 80, description_length: 240 });

      await expect(inspector.query(
        `INSERT INTO "${schema}".comment_labels (key,label,description,color,enabled,position) VALUES ($1,$2,$3,$4,$5,$6)`,
        ['unicode-label-over', emoji.repeat(81), '', '#BBCCDD', true, 2],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(inspector.query(
        `INSERT INTO "${schema}".comment_labels (key,label,description,color,enabled,position) VALUES ($1,$2,$3,$4,$5,$6)`,
        ['unicode-description-over', 'Valid', emoji.repeat(241), '#CCDDEE', true, 2],
      )).rejects.toMatchObject({ code: '23514' });
      expect(Number((await inspector.query(
        `SELECT COUNT(*) FROM "${schema}".comment_labels WHERE key IN ($1,$2,$3)`,
        ['unicode-boundary', 'unicode-label-over', 'unicode-description-over'],
      )).rows[0].count)).toBe(1);
    });
  }, 120_000);
});
