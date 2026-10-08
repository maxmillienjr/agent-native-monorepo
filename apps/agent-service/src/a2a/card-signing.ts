import { readFile } from 'node:fs/promises';
import * as jose from 'jose';
import { generateAgentCardSignature, type AgentCard } from '@a2a-js/sdk';
import { A2aConfigError } from './agent-card.js';

export const SIGNING_KEYS_VARIABLE = 'A2A_CARD_SIGNING_KEYS';

/** ES256 on P-256: the specification's example and the SDK sample's curve. */
export const SIGNING_ALGORITHM = 'ES256';

export interface SigningKey {
  /** RFC 7638 thumbprint of the public key, so there is no second name to keep in step. */
  readonly kid: string;
  readonly privateKey: jose.CryptoKey;
  readonly publicJwk: jose.JWK;
}

/**
 * Reads every PKCS#8 PEM named in `A2A_CARD_SIGNING_KEYS`, a comma-separated
 * list of paths. Unset is no keys, and the card is served unsigned: a key
 * generated at boot would sign with something no caller could pin, which is
 * worse than no signature. A path that cannot be read, or a key that is not
 * P-256, refuses boot. Nothing read here is logged.
 */
export async function loadSigningKeys(env: NodeJS.ProcessEnv): Promise<SigningKey[]> {
  const raw = env[SIGNING_KEYS_VARIABLE]?.trim();
  if (raw === undefined || raw === '') return [];

  const paths = raw.split(',').map((path) => path.trim());
  const keys: SigningKey[] = [];
  for (const [index, path] of paths.entries()) {
    keys.push(await loadKey(path, index, paths.length));
  }

  if (new Set(keys.map((k) => k.kid)).size !== keys.length) {
    throw new A2aConfigError(`${SIGNING_KEYS_VARIABLE} names one key twice`);
  }
  return keys;
}

async function loadKey(path: string, index: number, count: number): Promise<SigningKey> {
  const where = `${SIGNING_KEYS_VARIABLE} entry ${index + 1} of ${count}`;

  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch {
    throw new A2aConfigError(`${where} cannot be read`);
  }

  let privateKey: jose.CryptoKey;
  try {
    privateKey = await jose.importPKCS8(pem, SIGNING_ALGORITHM, { extractable: true });
  } catch {
    throw new A2aConfigError(`${where} is not a PKCS#8 P-256 private key`);
  }

  const { kty, crv, x, y } = await jose.exportJWK(privateKey);
  const publicJwk: jose.JWK = { kty, crv, x, y };
  const kid = await jose.calculateJwkThumbprint(publicJwk, 'sha256');
  return { kid, privateKey, publicJwk };
}

/**
 * The card JSON with one signature per configured key, in order. Several
 * signatures are what the specification allows "to support key rotation"
 * (§8.4.3): during a rotation the old and the new key both sign.
 *
 * Signed with the SDK's generator, because SDK verifiers are what callers run.
 * Each signature covers the card without `signatures`, so the order the keys
 * sign in does not change what any one of them signs.
 */
export async function signCard(
  card: Record<string, unknown>,
  keys: readonly SigningKey[],
  jku: string,
): Promise<Record<string, unknown>> {
  let signed = card as unknown as AgentCard;
  for (const key of keys) {
    const sign = generateAgentCardSignature(key.privateKey, {
      alg: SIGNING_ALGORITHM,
      typ: 'JOSE',
      kid: key.kid,
      jku,
    });
    signed = await sign(signed);
  }
  return signed as unknown as Record<string, unknown>;
}

/** The JWKS: every configured public key, and never a private one. */
export function jwks(keys: readonly SigningKey[]): { keys: jose.JWK[] } {
  return {
    keys: keys.map((key) => ({
      ...key.publicJwk,
      kid: key.kid,
      alg: SIGNING_ALGORITHM,
      use: 'sig',
    })),
  };
}
