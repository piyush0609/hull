const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');

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
    for (const file of files) {
      const sqlText = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      const statements = sqlText
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      for (const stmt of statements) {
        await sql.query(stmt);
      }
      console.log(`Applied: ${file}`);
    }
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

run();
