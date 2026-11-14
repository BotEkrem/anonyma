import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextExpiry, toMemberViews } from './members.ts';

const at = (s: number) => new Date(Date.UTC(2026, 10, 12, 12, 0, s));

test('two people with the same nickname stay two members', () => {
  const views = toMemberViews(
    [
      { sessionHash: 'a'.repeat(64), nickname: 'anon', joinedAt: at(1) },
      { sessionHash: 'b'.repeat(64), nickname: 'anon', joinedAt: at(2) },
    ],
    'b'.repeat(64),
  );
  assert.equal(views.length, 2);
  assert.deepEqual(
    views.map((v) => [v.sessionId, v.isSelf]),
    [
      ['a'.repeat(12), false],
      ['b'.repeat(12), true],
    ],
  );
});

test('one entry per session, oldest member first, nobody is self without a viewer', () => {
  const views = toMemberViews([
    { sessionHash: 'c'.repeat(64), nickname: 'late', joinedAt: at(9) },
    { sessionHash: 'd'.repeat(64), nickname: 'early', joinedAt: at(3) },
    { sessionHash: 'd'.repeat(64), nickname: 'early', joinedAt: at(4) },
  ]);
  assert.deepEqual(
    views.map((v) => v.nickname),
    ['early', 'late'],
  );
  assert.ok(views.every((v) => v.isSelf === false));
});

test('activity never shortens a room', () => {
  const now = at(0).getTime();
  const long = new Date(now + 30 * 60_000);
  assert.equal(nextExpiry(long, now, 10 * 60_000).getTime(), long.getTime());
  const soon = new Date(now + 60_000);
  assert.equal(nextExpiry(soon, now, 10 * 60_000).getTime(), now + 10 * 60_000);
  assert.equal(nextExpiry(null, now, 10 * 60_000).getTime(), now + 10 * 60_000);
});
