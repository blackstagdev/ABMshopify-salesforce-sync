import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyShopifyHmac } from '../src/shopify/verify.js';

const secret = 'test-secret';
const body = Buffer.from('{"id":1}');
const sign = (b, s = secret) => crypto.createHmac('sha256', s).update(b).digest('base64');

test('accepts a correctly signed body', () => {
  assert.equal(verifyShopifyHmac(body, sign(body), secret), true);
});

test('rejects a tampered body', () => {
  assert.equal(verifyShopifyHmac(Buffer.from('{"id":2}'), sign(body), secret), false);
});

test('rejects the wrong secret, a missing header or a missing secret', () => {
  assert.equal(verifyShopifyHmac(body, sign(body, 'other'), secret), false);
  assert.equal(verifyShopifyHmac(body, undefined, secret), false);
  assert.equal(verifyShopifyHmac(body, sign(body), undefined), false);
  assert.equal(verifyShopifyHmac(body, 'not-base64!!', secret), false);
});
