import 'reflect-metadata'; // the shared index loads class-validator DTOs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomPseudonym } from '@anonyma/shared';

// Shared with apps/realtime/src/room/pseudonym.rs: both must give these exact values.
const KEY = Buffer.alloc(32, 7);

test('known values (the Rust side checks the same ones)', () => {
  assert.equal(roomPseudonym(KEY, 'room-1', '0123456789ABCDEF0123456789abcdef'), '4d172428cfcacae7');
  assert.equal(roomPseudonym(KEY, 'room-2', '0123456789abcdef'), 'e24e4c3dcc850d2d');
});

test('one person, a different id in every room; only the 16-char prefix counts', () => {
  const hash = 'aa'.repeat(32);
  assert.notEqual(roomPseudonym(KEY, 'r1', hash), roomPseudonym(KEY, 'r2', hash));
  assert.equal(roomPseudonym(KEY, 'r1', hash), roomPseudonym(KEY, 'r1', hash.slice(0, 16)));
  assert.match(roomPseudonym(KEY, 'r1', hash), /^[0-9a-f]{16}$/);
});
