import 'reflect-metadata'; // the shared index loads class-validator DTOs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encryptAesGcm } from '@anonyma/shared';
import { Keyring } from './keyring.ts';

const A = Buffer.alloc(32, 1);
const B = Buffer.alloc(32, 2);
const room = (id: string) => Buffer.from(`nick:${id}`);

test('a nickname opens in its room and nowhere else', () => {
  const k = new Keyring(A);
  const sealed = k.seal('nickname', 'anon-x7k2', room('r1'));
  assert.ok(sealed.startsWith('v2.'));
  assert.equal(k.open('nickname', sealed, room('r1')), 'anon-x7k2');
  assert.equal(k.open('nickname', sealed, room('r2')), sealed); // moved: does not open
});

test('blobs sealed before subkeys (plain key, no AAD) still open', () => {
  const { ciphertext, iv } = encryptAesGcm('old-nick', A);
  const legacy = `${iv.toString('base64url')}.${ciphertext.toString('base64url')}`;
  assert.equal(new Keyring(A).open('nickname', legacy, room('r1')), 'old-nick');
});

test('messages: new ones use the subkey, old ones still decrypt', () => {
  const k = new Keyring(A);
  const aad = Buffer.from('room-aad');
  const fresh = k.encrypt('message', 'hello', aad);
  assert.equal(k.decrypt('message', fresh.ciphertext, fresh.iv, aad), 'hello');
  const old = encryptAesGcm('before', A, aad);
  assert.equal(k.decrypt('message', old.ciphertext, old.iv, aad), 'before');
});

test('purposes are separate: an invite blob is not a nickname', () => {
  const k = new Keyring(A);
  const invite = k.seal('invite', 'ABCD2345EFGH', room('r1'));
  assert.equal(k.open('nickname', invite, room('r1')), invite);
});

test('rotation: with the old key as previous, its data still opens', () => {
  const before = new Keyring(A).seal('nickname', 'kept', room('r1'));
  const rotated = new Keyring(B, A);
  assert.equal(rotated.open('nickname', before, room('r1')), 'kept');
  assert.equal(new Keyring(B).open('nickname', before, room('r1')), before);
});
