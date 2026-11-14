import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUniqueViolation } from './pg-errors.ts';

const pgError = { code: '23505', constraint: 'room_members_room_session_uidx' };

test('a bare driver error is recognised', () => {
  assert.equal(isUniqueViolation(pgError, 'room_members_room_session_uidx'), true);
});

test('a Drizzle-wrapped error is recognised through its cause', () => {
  const wrapped = Object.assign(new Error('Failed query'), { cause: pgError });
  assert.equal(isUniqueViolation(wrapped, 'room_members_room_session_uidx'), true);
});

test('another unique constraint is not taken for a rejoin', () => {
  assert.equal(
    isUniqueViolation(
      { code: '23505', constraint: 'rooms_slug_key' },
      'room_members_room_session_uidx',
    ),
    false,
  );
});

test('other errors are not unique violations', () => {
  assert.equal(isUniqueViolation(new Error('connection terminated')), false);
  assert.equal(isUniqueViolation({ cause: { code: '23503' } }), false);
  assert.equal(isUniqueViolation(undefined), false);
});
