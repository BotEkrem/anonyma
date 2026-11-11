import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envValidator } from '@anonyma/shared';

const validate = envValidator({
  requiredInProduction: ['A_SECRET'],
  positiveInts: ['A_PORT', 'A_TTL'],
});

test('production needs its secrets; development does not', () => {
  assert.throws(() => validate({ NODE_ENV: 'production' }), /A_SECRET is required/);
  assert.doesNotThrow(() => validate({ NODE_ENV: 'production', A_SECRET: 'x' }));
  assert.doesNotThrow(() => validate({ NODE_ENV: 'development' }));
});

test('numbers must be whole and above zero when set', () => {
  assert.doesNotThrow(() => validate({ A_PORT: '3000', A_TTL: '600' }));
  assert.throws(() => validate({ A_TTL: '10m' }), /A_TTL must be a whole number/);
  assert.throws(() => validate({ A_TTL: '0' }), /A_TTL/);
  assert.throws(() => validate({ A_PORT: '-1' }), /A_PORT/);
  assert.doesNotThrow(() => validate({ A_TTL: '' }));
});
