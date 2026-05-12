function splitStatements(sqlText) {
  return sqlText
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function ensureSchemaMigrationsTable(sql) {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(sql) {
  const rows = await sql.query('SELECT filename FROM schema_migrations');
  return new Set(rows.map((row) => row.filename));
}

async function applyMigrationFile(sql, filename, sqlText) {
  const statements = splitStatements(sqlText);
  if (statements.length === 0) {
    return false;
  }

  await sql.query('BEGIN');
  try {
    for (const stmt of statements) {
      await sql.query(stmt);
    }
    await sql.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await sql.query('COMMIT');
    return true;
  } catch (err) {
    try {
      await sql.query('ROLLBACK');
    } catch {}
    throw err;
  }
}

module.exports = {
  splitStatements,
  ensureSchemaMigrationsTable,
  getAppliedMigrations,
  applyMigrationFile,
};
