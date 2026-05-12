const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');
const {
  ensureSchemaMigrationsTable,
  getAppliedMigrations,
  applyMigrationFile,
} = require('./migration-runner.cjs');

async function run() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL or POSTGRES_URL not set');
    process.exit(1);
  }
  const sql = neon(databaseUrl);
  try {
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    await ensureSchemaMigrationsTable(sql);
    const applied = await getAppliedMigrations(sql);
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipped: ${file}`);
        continue;
      }
      const sqlText = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const appliedNow = await applyMigrationFile(sql, file, sqlText);
      if (appliedNow) {
        console.log(`Applied: ${file}`);
      }
    }
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
