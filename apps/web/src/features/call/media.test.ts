import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARE_QUALITIES,
  canShareScreen,
  deviceOptions,
  gridCountClass,
  permissionHint,
  pickDeviceId,
  shareErrorHint,
  shareQuality,
} from './media.ts';

test('grid classes by tile count', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 12].map(gridCountClass), [
    'count-1',
    'count-1',
    'count-2',
    'count-4',
    'count-4',
    'count-6',
    'count-6',
    'count-9',
    'count-9',
  ]);
});

test('the remembered device is kept while it exists', () => {
  const list = [
    { deviceId: 'a', label: 'A' },
    { deviceId: 'b', label: 'B' },
  ];
  assert.equal(pickDeviceId(list, 'b'), 'b');
  assert.equal(pickDeviceId(list, 'gone'), 'a');
  assert.equal(pickDeviceId([], 'b'), '');
});

test('devices without labels get numbered names per kind', () => {
  const { mics, cams } = deviceOptions([
    { deviceId: 'm1', kind: 'audioinput', label: '' },
    { deviceId: 'o1', kind: 'audiooutput', label: 'Speakers' },
    { deviceId: 'm2', kind: 'audioinput', label: 'USB mic' },
    { deviceId: 'c1', kind: 'videoinput', label: '' },
  ]);
  assert.deepEqual(mics, [
    { deviceId: 'm1', label: 'Microphone 1' },
    { deviceId: 'm2', label: 'USB mic' },
  ]);
  assert.deepEqual(cams, [{ deviceId: 'c1', label: 'Camera 1' }]);
});

test('permission and missing-device errors get plain advice', () => {
  assert.match(
    permissionHint(new Error('NotAllowedError: Permission denied'), 'video'),
    /permission denied/,
  );
  assert.match(
    permissionHint(new Error('NotFoundError: Requested device not found'), 'voice'),
    /No microphone/,
  );
  assert.equal(permissionHint(new Error('Boom'), 'voice'), 'Boom');
  assert.equal(permissionHint(undefined, 'voice'), 'Could not join call');
});

test('share presets: unknown ids fall back to Sharp text', () => {
  assert.equal(shareQuality('motion').fps, 30);
  assert.equal(shareQuality('nope').id, 'text');
  assert.equal(shareQuality(null).id, 'text');
  assert.equal(new Set(SHARE_QUALITIES.map((q) => q.id)).size, SHARE_QUALITIES.length);
});

test('screen sharing is offered only where the browser has it', () => {
  assert.equal(canShareScreen({ getDisplayMedia: () => undefined }), true);
  assert.equal(canShareScreen({}), false);
  assert.equal(canShareScreen(undefined), false);
});

test('closing the share picker is not an error; a system block is explained', () => {
  const err = (name: string, message: string) => Object.assign(new Error(message), { name });
  assert.equal(shareErrorHint(err('NotAllowedError', 'Permission denied')), null);
  assert.match(shareErrorHint(err('NotAllowedError', 'Permission denied by system')) ?? '', /Screen Recording/);
  assert.match(shareErrorHint(err('NotReadableError', 'Could not start video source')) ?? '', /another window/);
  assert.match(shareErrorHint(new Error('boom')) ?? '', /did not start/);
});
