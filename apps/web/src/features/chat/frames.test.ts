import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MessageView } from '@anonyma/contracts';
import {
  applyMessageChange,
  applyNewMessage,
  applyReaction,
  mergeLatest,
  normalizeMessage,
  peerSeenCount,
} from './frames.ts';

const msg = (id: string, extra: Partial<MessageView> = {}): MessageView => ({
  id,
  roomId: 'r',
  senderSessionId: 'a',
  nickname: 'anon',
  content: `text ${id}`,
  createdAt: '2026-11-13T00:00:00.000Z',
  expiresAt: '2026-11-13T00:10:00.000Z',
  reactions: {},
  ...extra,
});

test('a message from both the POST answer and the socket is listed once', () => {
  const once = applyNewMessage([], msg('01'));
  const twice = applyNewMessage(once, msg('01'));
  assert.equal(twice.length, 1);
  assert.equal(twice, once, 'the list is left as it was');
});

test('new messages are normalised (reactions, deleted, editedAt)', () => {
  const raw = { ...msg('01'), reactions: undefined } as unknown as MessageView;
  assert.deepEqual(normalizeMessage(raw).reactions, {});
  assert.equal(normalizeMessage(raw).deleted, false);
  assert.equal(normalizeMessage(raw).editedAt, null);
});

test('an edit replaces the message and the quote on its replies', () => {
  const list = [msg('01'), msg('02', { replyToId: '01', replyPreview: 'text 01' })];
  const edited = applyMessageChange(list, msg('01', { content: 'new words' }), 'message_updated');
  assert.equal(edited[0]!.content, 'new words');
  assert.equal(edited[1]!.replyPreview, 'new words');
});

test('a long edited parent is quoted shortened', () => {
  const list = [msg('01'), msg('02', { replyToId: '01' })];
  const long = 'x'.repeat(130);
  const edited = applyMessageChange(list, msg('01', { content: long }), 'message_updated');
  assert.equal(edited[1]!.replyPreview, `${'x'.repeat(120)}…`);
});

test('editing a reply does not touch other quotes', () => {
  const list = [msg('01'), msg('02', { replyToId: '01', replyPreview: 'text 01' })];
  const edited = applyMessageChange(
    list,
    msg('02', { replyToId: '01', content: 'changed' }),
    'message_updated',
  );
  assert.equal(edited[1]!.content, 'changed');
  assert.equal(edited[1]!.replyPreview, undefined, 'the reply carries what the server sent');
});

test('a deleted message marks the quotes of its replies', () => {
  const list = [msg('01'), msg('02', { replyToId: '01', replyPreview: 'text 01' })];
  const after = applyMessageChange(
    list,
    msg('01', { deleted: true, content: '' }),
    'message_deleted',
  );
  assert.equal(after[0]!.deleted, true);
  assert.equal(after[1]!.replyPreview, 'Message deleted');
});

test('an update for a message not on screen changes nothing', () => {
  const list = [msg('01')];
  const after = applyMessageChange(list, msg('99', { content: 'x' }), 'message_updated');
  assert.deepEqual(after, list);
});

test('reactions are replaced as a whole', () => {
  const list = [msg('01', { reactions: { '👍': ['a'] } })];
  const after = applyReaction(list, '01', { '❤️': ['b'] });
  assert.deepEqual(after[0]!.reactions, { '❤️': ['b'] });
  assert.deepEqual(applyReaction(list, 'nope', {}), list);
});

test('a fresh latest page keeps older pages and newer socket messages, in order', () => {
  const prev = [msg('01'), msg('02'), msg('03'), msg('06')];
  const fresh = [msg('03', { content: 'edited' }), msg('04'), msg('05')];
  const merged = mergeLatest(prev, fresh);
  assert.deepEqual(
    merged.map((m) => m.id),
    ['01', '02', '03', '04', '05', '06'],
  );
  assert.equal(merged[2]!.content, 'edited', 'the overlap takes the server version');
});

test('an empty latest page only drops expired messages', () => {
  const now = Date.parse('2026-11-13T00:05:00.000Z');
  const prev = [msg('01', { expiresAt: '2026-11-13T00:01:00.000Z' }), msg('02')];
  assert.deepEqual(
    mergeLatest(prev, [], now).map((m) => m.id),
    ['02'],
  );
});

test('read receipts count other people only', () => {
  const reads = { me: '05', p1: '05', p2: '03' };
  const self = (id: string) => id === 'me';
  assert.equal(peerSeenCount(msg('04'), self, reads), 1);
  assert.equal(peerSeenCount(msg('03'), self, reads), 2);
});
