/**
 * Pepper for client IP hashes (rate-limit buckets) and room-scoped LiveKit
 * identities. Only the gateway holds it: these used to be keyed with the RPC
 * secret, which every service has, and an IPv4 hash is cheap to brute-force
 * by anyone holding the key.
 */
export function identityPepper(env: NodeJS.ProcessEnv = process.env): string {
  const pepper = env.IDENTITY_PEPPER?.trim();
  if (pepper) {
    return pepper;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('IDENTITY_PEPPER is required in production');
  }
  return 'anonyma-dev-pepper';
}
