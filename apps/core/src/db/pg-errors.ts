/** Postgres' code for a unique constraint (or unique index) violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when `err` is a unique violation, optionally on one constraint or
 * unique index. Drizzle wraps the driver's error (`DrizzleQueryError` with the
 * pg error as `cause`), so the cause chain is followed a few levels.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth++) {
    const o = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (o.code === UNIQUE_VIOLATION) {
      return constraint === undefined || o.constraint === constraint;
    }
    e = o.cause;
  }
  return false;
}
