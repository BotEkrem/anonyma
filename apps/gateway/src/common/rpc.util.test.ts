import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpErrorFromRpc } from './rpc.util.ts';

const answer = (err: unknown) => {
  const e = httpErrorFromRpc(err);
  return { status: e.getStatus(), body: e.getResponse() };
};

test('a coded error keeps its status, message and code', () => {
  assert.deepEqual(answer({ statusCode: 404, message: 'Room not found', code: 'room_not_found' }), {
    status: 404,
    body: { statusCode: 404, message: 'Room not found', code: 'room_not_found' },
  });
  // The same object nested under `message`, as Nest sometimes delivers it.
  assert.equal(
    answer({ message: { statusCode: 403, message: 'Invalid invite', code: 'invite_invalid' } })
      .status,
    403,
  );
});

test('a coded 500 is never turned into a 401 by its wording', () => {
  const out = answer({ statusCode: 500, message: 'Unauthorized RPC', code: 'internal' });
  assert.equal(out.status, 500);
  assert.equal((out.body as { code: string }).code, 'internal');
});

test('uncoded errors still get their status from the wording', () => {
  assert.equal(answer('Not a room member').status, 403);
  assert.equal(answer({ message: 'Invalid or expired session' }).status, 401);
  assert.equal(answer({ statusCode: 404, message: 'Room expired' }).status, 404);
  assert.equal(answer({ message: 'Internal server error' }).status, 500);
  // Nest's generic text says nothing useful; it is answered as before.
  assert.equal(answer({ message: 'Internal server error' }).body, 'Upstream error');
});

test('a timeout is a 503, not a 500', () => {
  const timeoutError = Object.assign(new Error('Timeout has occurred'), { name: 'TimeoutError' });
  const out = answer(timeoutError);
  assert.equal(out.status, 503);
  assert.equal((out.body as { code: string }).code, 'upstream_unavailable');
});
