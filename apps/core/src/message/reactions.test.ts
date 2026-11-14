import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toggleReaction } from './reactions.ts';

test('a reaction moves, and the same emoji again takes it off', () => {
  let r = toggleReaction({}, 'me', '👍');
  assert.deepEqual(r, { '👍': ['me'] });
  r = toggleReaction({ ...r, '❤️': ['you'] }, 'me', '❤️');
  assert.deepEqual(r, { '❤️': ['you', 'me'] });
  r = toggleReaction(r, 'me', '❤️');
  assert.deepEqual(r, { '❤️': ['you'] });
});

test('other people keep their reactions', () => {
  const r = toggleReaction({ '👍': ['a', 'me'], '😂': ['b'] }, 'me', '😂');
  assert.deepEqual(r, { '👍': ['a'], '😂': ['b', 'me'] });
});
