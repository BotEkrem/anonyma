import * as path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { Pool, type PoolClient } from 'pg';

/** apps/core/drizzle, from both src/db (tests) and dist/db (the image). */
export const MIGRATIONS_FOLDER = path.join(__dirname, '../../drizzle');

/** Any fixed number: core pods take turns applying migrations. */
const MIGRATION_LOCK_ID = 727_001;

const LEGACY_MESSAGE =
  'This database was created before migrations were tracked (it has tables but no ' +
  'drizzle.__drizzle_migrations rows). Check it matches drizzle/0000_init.sql, then ' +
  'run `node dist/db/baseline.js` once (or `--print` for the SQL) and start again.';

/** True when the app's tables exist but no migration was ever recorded. */
async function isUnbaselined(client: PoolClient): Promise<boolean> {
  const tables = await client.query<{ present: boolean }>(
    `SELECT to_regclass('public.rooms') IS NOT NULL AS present`,
  );
  if (!tables.rows[0]?.present) return false;
  const tracker = await client.query<{ present: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  if (!tracker.rows[0]?.present) return true;
  const rows = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations`,
  );
  return rows.rows[0]?.n === '0';
}

/**
 * Brings the database up to drizzle/ (the schema's single source: edit
 * src/db/schema.ts, run `pnpm db:generate`, commit the new migration). One pod
 * at a time; a failure throws, so the process exits instead of serving.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      if (await isUnbaselined(client)) throw new Error(LEGACY_MESSAGE);
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Marks drizzle/'s first migration as applied without running it, for a
 * database whose tables were made before migrations were tracked. The row is
 * what drizzle's migrator writes itself (hash and journal time of 0000).
 */
export function baselineStatements(): string[] {
  const [first] = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  if (!first) throw new Error(`no migrations in ${MIGRATIONS_FOLDER}`);
  if (!/^[0-9a-f]{64}$/.test(first.hash) || !Number.isSafeInteger(first.folderMillis)) {
    throw new Error('unexpected migration metadata');
  }
  return [
    'CREATE SCHEMA IF NOT EXISTS "drizzle"',
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
)`,
    `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
  SELECT '${first.hash}', ${first.folderMillis}
  WHERE NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations")`,
  ];
}
