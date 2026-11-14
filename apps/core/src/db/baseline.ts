/**
 * One-off for a database made before migrations were tracked: records
 * drizzle/0000_init as applied, without running it. It changes no app data.
 * Check first that the live schema matches drizzle/0000_init.sql.
 *
 *   node dist/db/baseline.js           (uses DATABASE_URL)
 *   node dist/db/baseline.js --print   (prints the SQL instead)
 */
import { Pool } from 'pg';
import { baselineStatements } from './migrations';

async function main(): Promise<void> {
  const statements = baselineStatements();
  if (process.argv.includes('--print')) {
     
    console.log(['BEGIN', ...statements, 'COMMIT'].join(';\n') + ';');
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT');
     
    console.log('Baseline recorded');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
