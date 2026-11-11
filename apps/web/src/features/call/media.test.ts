import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceOptions, gridCountClass, permissionHint, pickDeviceId } from './media.ts';

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
