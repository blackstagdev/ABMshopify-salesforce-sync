import crypto from 'node:crypto';

// Shopify signs every webhook body with HMAC-SHA256 using the app's client
// secret and sends it base64-encoded in X-Shopify-Hmac-Sha256.
export function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!rawBody || !hmacHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(hmacHeader, 'base64');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
