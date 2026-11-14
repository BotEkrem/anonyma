import { runMigrations } from './migrations';

/** `pnpm db:migrate`: the same step core runs at start. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required');
  }
  await runMigrations(url);
   
  console.log('Migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
