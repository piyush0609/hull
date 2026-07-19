const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const TOSS_MIGRATION_ADVISORY_LOCK = '8827364510192601';

function databaseSsl(databaseUrl, env = process.env) {
  const url = new URL(databaseUrl);
  const sslMode = (url.searchParams.get('sslmode') || env.PGSSLMODE || '').toLowerCase();
  if (sslMode === 'disable') return false;
  // pg-connection-string supports the explicit non-verifying `no-verify` mode.
  // Never translate require/verify-ca/verify-full into rejectUnauthorized:false.
  if (sslMode === 'no-verify') return { rejectUnauthorized: false };
  if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full') return { rejectUnauthorized: true };
  // allow/prefer have fallback semantics that a boolean ssl override cannot
  // represent, so leave them to pg's connection-string parser.
  if (sslMode === 'allow' || sslMode === 'prefer') return undefined;
  if (env.VERCEL || env.NEON_PROJECT_ID) return { rejectUnauthorized: true };
  return undefined;
}

function splitSqlStatements(source) {
  const statements = [];
  let current = '';
  let single = false;
  let double = false;
  let lineComment = false;
  let blockDepth = 0;
  let dollarTag = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (lineComment) { current += char; if (char === '\n') lineComment = false; continue; }
    if (blockDepth > 0) {
      current += char;
      if (char === '/' && next === '*') { current += next; blockDepth++; i++; }
      else if (char === '*' && next === '/') { current += next; blockDepth--; i++; }
      continue;
    }
    if (dollarTag) {
      if (source.startsWith(dollarTag, i)) { current += dollarTag; i += dollarTag.length - 1; dollarTag = null; }
      else current += char;
      continue;
    }
    if (single) {
      current += char;
      if (char === "'" && next === "'") { current += next; i++; }
      else if (char === "'") single = false;
      continue;
    }
    if (double) {
      current += char;
      if (char === '"' && next === '"') { current += next; i++; }
      else if (char === '"') double = false;
      continue;
    }
    if (char === '-' && next === '-') { current += char + next; lineComment = true; i++; continue; }
    if (char === '/' && next === '*') { current += char + next; blockDepth = 1; i++; continue; }
    if (char === "'") { current += char; single = true; continue; }
    if (char === '"') { current += char; double = true; continue; }
    if (char === '$') {
      const match = source.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; current += dollarTag; i += dollarTag.length - 1; continue; }
    }
    if (char === ';') { if (current.trim()) statements.push(current.trim()); current = ''; }
    else current += char;
  }
  if (single || double || blockDepth || dollarTag) throw new Error('Unterminated SQL quote or comment');
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function migrationFiles(migrationsDir, phase) {
  return fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'))
    .filter((file) => phase === 'post' ? file.endsWith('.post.sql') : !file.endsWith('.post.sql')).sort();
}

function quoteIdentifier(value) { return `"${String(value).replace(/"/g, '""')}"`; }
function validateTargetSchema(schema) {
  if (typeof schema !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid migration target schema');
  return schema;
}
function ledgerName(schema) { return `${quoteIdentifier(validateTargetSchema(schema))}.schema_migrations`; }
function localSearchPath(schema) { return `SET LOCAL search_path = ${quoteIdentifier(validateTargetSchema(schema))}, pg_catalog`; }
async function ensureTargetSchema(client, schema) {
  const result = await client.query('SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1', [validateTargetSchema(schema)]);
  if (!result.rowCount) throw new Error(`Migration target schema does not exist: ${schema}`);
}

async function bootstrapLedger(client, schema = 'public') {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(${TOSS_MIGRATION_ADVISORY_LOCK}::bigint)`);
    await ensureTargetSchema(client, schema);
    await client.query(localSearchPath(schema));
    await client.query(`CREATE TABLE IF NOT EXISTS ${ledgerName(schema)} (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function applyMigration(client, migrationsDir, filename, schema = 'public') {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT pg_advisory_xact_lock(${TOSS_MIGRATION_ADVISORY_LOCK}::bigint)`);
    const marked = await client.query(`SELECT 1 FROM ${ledgerName(schema)} WHERE filename = $1`, [filename]);
    if (marked.rowCount) { await client.query('COMMIT'); return false; }
    await client.query(localSearchPath(schema));
    for (const statement of splitSqlStatements(fs.readFileSync(path.join(migrationsDir, filename), 'utf8'))) await client.query(statement);
    await client.query(`INSERT INTO ${ledgerName(schema)} (filename) VALUES ($1)`, [filename]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

const PROBE_SQL = `
WITH state_shape AS (
  SELECT COUNT(*)::int AS rows, COALESCE(bool_and(singleton = true), false) AS singleton_ok,
    COALESCE(bool_and(revision >= 0), false) AS revision_ok, COALESCE(min(revision), 0) AS revision,
    COALESCE(bool_and(contract_ready), false) AS ready
  FROM comment_label_registry_state
), columns AS (
  SELECT
    (SELECT jsonb_agg(jsonb_build_array(column_name, data_type, is_nullable) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'comment_label_registry_state') =
      $json$[["singleton","boolean","NO"],["revision","bigint","NO"],["contract_ready","boolean","NO"]]$json$::jsonb AS state_columns_ok,
    (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'comment_label_registry_state' AND ((column_name = 'singleton' AND column_default ~ '^(true|''true''::boolean)$') OR (column_name = 'revision' AND column_default ~ '^(0|''0''::bigint)$') OR (column_name = 'contract_ready' AND column_default ~ '^(false|''false''::boolean)$'))) = 3 AS state_defaults_ok,
    (SELECT jsonb_agg(jsonb_build_array(column_name, data_type, is_nullable, column_default) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'comment_labels') =
      $json$[["key","text","NO",null],["label","text","NO",null],["description","text","NO",null],["color","text","NO",null],["enabled","boolean","NO",null],["position","integer","NO",null]]$json$::jsonb AS label_columns_ok,
    (SELECT jsonb_agg(jsonb_build_array(column_name, data_type, is_nullable) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'schema_migrations') =
      $json$[["filename","text","NO"],["applied_at","timestamp with time zone","NO"]]$json$::jsonb AS ledger_columns_ok,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'schema_migrations' AND column_name = 'applied_at' AND column_default IN ('now()', 'CURRENT_TIMESTAMP')) AS ledger_default_ok,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'comment_messages' AND column_name = 'kind' AND data_type = 'text' AND is_nullable = 'YES' AND column_default IS NULL) AS kind_expanded
), constraints AS (
  SELECT
    (SELECT COUNT(*) FROM pg_constraint WHERE conrelid = to_regclass('comment_label_registry_state') AND contype = 'c') = 2 AS state_check_count_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_label_registry_state') AND contype = 'p' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_label_registry_state') AND attname = 'singleton')]::smallint[]) AS state_pk_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('schema_migrations') AND contype = 'p' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('schema_migrations') AND attname = 'filename')]::smallint[]) AS ledger_pk_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_label_registry_state') AND contype = 'c' AND convalidated AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_label_registry_state') AND attname = 'singleton')]::smallint[] AND regexp_replace(pg_get_expr(conbin, conrelid), '[()"[:space:]]', '', 'g') = 'singleton=true') AS singleton_check_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_label_registry_state') AND contype = 'c' AND convalidated AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_label_registry_state') AND attname = 'revision')]::smallint[] AND regexp_replace(pg_get_expr(conbin, conrelid), '[()"[:space:]]|::bigint', '', 'g') = 'revision>=0') AS revision_check_ok,
    (SELECT COUNT(*) FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND contype = 'c') = 5 AS label_check_count_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND contype = 'p' AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_labels') AND attname = 'key')]::smallint[]) AS label_pk_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%key ~ ''^[a-z0-9][a-z0-9-]{0,31}$''%') AS key_check_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%length(btrim(label)) >= 1%' AND pg_get_constraintdef(oid) LIKE '%length(btrim(label)) <= 80%' AND pg_get_constraintdef(oid) LIKE '%label = btrim(label)%') AS label_check_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%length(description) <= 240%' AND pg_get_constraintdef(oid) LIKE '%description = btrim(description)%') AS description_check_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%color ~ ''^#[0-9A-F]{6}$''%') AS color_check_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND conname = 'comment_labels_resolution_shape' AND contype = 'c' AND convalidated AND conkey = ARRAY(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_labels') AND attname = ANY (ARRAY['key','label','description','color','enabled','position']) ORDER BY attnum)::smallint[] AND pg_get_expr(conbin, conrelid) LIKE '%System-generated resolution note%' AND regexp_replace(pg_get_expr(conbin, conrelid), '["[:space:]]', '', 'g') LIKE '%position=0%' AND regexp_replace(pg_get_expr(conbin, conrelid), '["[:space:]]', '', 'g') LIKE '%position>0%') AS resolution_check_ok,
    EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND conname = 'comment_labels_position_unique' AND contype = 'u' AND condeferrable AND condeferred AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_labels') AND attname = 'position')]::smallint[]) AS position_constraint_ok,
    (SELECT COUNT(*) FROM pg_constraint WHERE conrelid = to_regclass('comment_labels') AND contype = 'u') = 1 AS label_unique_count_ok,
    NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('comment_messages') AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%') AS old_kind_check_absent,
    (SELECT COUNT(*) FROM pg_constraint fk WHERE fk.conrelid = to_regclass('comment_messages') AND fk.contype = 'f' AND fk.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_messages') AND attname = 'kind')]::smallint[]) AS kind_fk_count,
    EXISTS (SELECT 1 FROM pg_constraint fk WHERE fk.conrelid = to_regclass('comment_messages') AND fk.conname = 'comment_messages_kind_comment_labels_fk' AND fk.contype = 'f' AND fk.confrelid = to_regclass('comment_labels') AND fk.convalidated AND fk.condeferrable AND NOT fk.condeferred AND fk.confupdtype = 'r' AND fk.confdeltype = 'r' AND fk.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_messages') AND attname = 'kind')]::smallint[] AND fk.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('comment_labels') AND attname = 'key')]::smallint[]) AS exact_fk
), catalog AS (
  SELECT
    EXISTS (SELECT 1 FROM comment_labels WHERE key = 'resolution' AND label = 'Resolution' AND description = 'System-generated resolution note' AND color = '#667085' AND enabled = false AND position = 0) AS hidden_resolution_ok,
    (SELECT COUNT(*) FROM comment_labels WHERE key = 'resolution') = 1 AS one_hidden_resolution,
    EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '0010_configurable_comment_labels_expand.sql') AS expand_marker,
    EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '0011_configurable_comment_labels_contract.post.sql') AS contract_marker
)
SELECT state_shape.*, columns.*, constraints.*, catalog.* FROM state_shape, columns, constraints, catalog`;

async function probeSchema(client) {
  const objects = (await client.query(`SELECT to_regclass('comment_label_registry_state') IS NOT NULL AS has_state, to_regclass('comment_labels') IS NOT NULL AS has_labels, to_regclass('comment_messages') IS NOT NULL AS has_messages, to_regclass('schema_migrations') IS NOT NULL AS has_ledger`)).rows[0];
  if (!objects.has_state || !objects.has_labels || !objects.has_messages || !objects.has_ledger) return { valid: false, state: 'unexpanded', reason: 'comment label expansion is not installed' };
  const result = (await client.query(PROBE_SQL)).rows[0];
  const expanded = result.rows === 1 && result.singleton_ok && result.revision_ok && result.kind_expanded
    && result.state_columns_ok && result.state_defaults_ok && result.label_columns_ok && result.ledger_columns_ok && result.ledger_default_ok
    && result.state_check_count_ok && result.state_pk_ok && result.ledger_pk_ok && result.singleton_check_ok && result.revision_check_ok
    && result.label_check_count_ok && result.label_pk_ok && result.key_check_ok && result.label_check_ok
    && result.description_check_ok && result.color_check_ok && result.resolution_check_ok && result.position_constraint_ok && result.label_unique_count_ok
    && result.hidden_resolution_ok && result.one_hidden_resolution && result.old_kind_check_absent && result.expand_marker;
  if (expanded && result.ready && Number(result.revision) >= 1 && Number(result.kind_fk_count) === 1 && result.exact_fk && result.contract_marker) return { valid: true, state: 'contracted' };
  if (expanded && !result.ready && Number(result.kind_fk_count) === 0 && !result.contract_marker) return { valid: true, state: 'expanded' };
  return { valid: false, state: 'inconsistent', reason: 'comment label migration markers, readiness, and foreign key do not agree' };
}

async function run(options = {}) {
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or POSTGRES_URL not set');
  const phase = options.phase || 'pre';
  if (!['pre', 'post', 'probe'].includes(phase)) throw new Error(`Invalid migration phase: ${phase}`);
  const client = options.client || new Client({ connectionString: databaseUrl, ssl: databaseSsl(databaseUrl) });
  const targetSchema = validateTargetSchema(options.schema || 'public');
  let originalError;
  try {
    await client.connect();
    if (phase === 'probe') {
      await client.query('BEGIN');
      try {
        await ensureTargetSchema(client, targetSchema);
        await client.query(localSearchPath(targetSchema));
        const result = await probeSchema(client);
        await client.query('ROLLBACK');
        return result;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    }
    await bootstrapLedger(client, targetSchema);
    const migrationsDir = options.migrationsDir || path.join(__dirname, 'migrations');
    for (const filename of migrationFiles(migrationsDir, phase)) if (await applyMigration(client, migrationsDir, filename, targetSchema)) console.log(`Applied: ${filename}`);
    console.log(`Migrations complete (${phase}).`);
    return { valid: true, state: phase };
  } catch (error) { originalError = error; throw error; }
  finally { try { await client.end(); } catch (endError) { if (!originalError) throw endError; } }
}

function parsePhase(argv) { const index = argv.indexOf('--phase'); return index === -1 ? 'pre' : argv[index + 1]; }

if (require.main === module) {
  const phase = parsePhase(process.argv.slice(2));
  run({ phase }).then((result) => {
    if (result && result.valid === false) { console.error(`Schema probe failed (${result.state}): ${result.reason}`); process.exitCode = 2; }
    else if (phase === 'probe') console.log(`Schema probe passed (${result.state}).`);
  }).catch((error) => { console.error('Migration failed:', error.message); process.exitCode = 1; });
}

module.exports = { TOSS_MIGRATION_ADVISORY_LOCK, databaseSsl, splitSqlStatements, migrationFiles, validateTargetSchema, bootstrapLedger, applyMigration, probeSchema, run };
