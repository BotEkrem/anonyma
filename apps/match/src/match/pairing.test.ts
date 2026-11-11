import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeCandidate } from './pairing.ts';

const ctx = { selfHash: 'me', now: 1_000_000, ttlMs: 600_000, alive: true };

test('a live waiter is taken', () => {
  assert.equal(judgeCandidate({ sessionHash: 'peer', enqueuedAt: 999_000 }, ctx), 'take');
});

test('your own old entry is skipped, not a reason to stop', () => {
  assert.equal(judgeCandidate({ sessionHash: 'me', enqueuedAt: 999_000 }, ctx), 'self');
});

test('a waiter who stopped polling is not paired', () => {
  assert.equal(
    judgeCandidate({ sessionHash: 'peer', enqueuedAt: 999_000 }, { ...ctx, alive: false }),
    'gone',
  );
});

test('a waiter past the queue lifetime is dropped', () => {
  assert.equal(judgeCandidate({ sessionHash: 'peer', enqueuedAt: 1 }, ctx), 'stale');
});
