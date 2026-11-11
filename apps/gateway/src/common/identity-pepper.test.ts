import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityPepper } from './identity-pepper.ts';

test('the configured pepper is used', () => {
  assert.equal(identityPepper({ IDENTITY_PEPPER: ' p1 ', NODE_ENV: 'production' }), 'p1');
});

test('production refuses to start without its own pepper', () => {
  // The RPC secret is no longer a stand-in: every service holds it.
  assert.throws(
    () => identityPepper({ NODE_ENV: 'production', INTERNAL_RPC_SECRET: 'x' }),
    /IDENTITY_PEPPER/,
  );
});

test('development falls back to a fixed pepper', () => {
  assert.equal(identityPepper({ NODE_ENV: 'development' }), 'anonyma-dev-pepper');
});
