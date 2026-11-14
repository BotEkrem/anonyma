import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCheckError } from './session-check.ts';

const shape = (err: unknown) =>
  sessionCheckError(err).getError() as { statusCode: number; code: string };

test("core's 401 stays a 401 (the session really is invalid)", () => {
  assert.deepEqual(
    {
      ...shape({ statusCode: 401, message: 'Invalid or expired session', code: 'session_invalid' }),
    },
    { statusCode: 401, message: 'Invalid session', code: 'session_invalid' },
  );
  assert.equal(
    shape({ message: { statusCode: 401, message: 'Invalid or expired session' } }).statusCode,
    401,
  );
});

test('a timeout or an outage is a 503, never a sign-out', () => {
  const timeoutError = Object.assign(new Error('Timeout has occurred'), { name: 'TimeoutError' });
  assert.equal(shape(timeoutError).statusCode, 503);
  assert.equal(shape(timeoutError).code, 'session_check_unavailable');
  assert.equal(shape(new Error('Connection closed')).statusCode, 503);
  assert.equal(shape({ statusCode: 500, message: 'Internal RPC rejected' }).statusCode, 503);
});
