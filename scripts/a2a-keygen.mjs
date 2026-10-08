#!/usr/bin/env node
// Writes a P-256 private key, PKCS#8 PEM, for signing the Agent Card (P5-A),
// unless one is already there. Compose runs it once, as the `a2a-keygen`
// service, into a named volume; the key never enters the repository.
//
//   node scripts/a2a-keygen.mjs <path> [--owner <uid>:<gid>]
//
// --owner chowns the file, because compose runs this as root and the service
// runs as an unprivileged user that has to read it.
import { generateKeyPairSync } from 'node:crypto';
import { chownSync, existsSync, writeFileSync } from 'node:fs';

const [path, flag, owner] = process.argv.slice(2);
if (path === undefined || (flag !== undefined && (flag !== '--owner' || owner === undefined))) {
  process.stderr.write('usage: a2a-keygen.mjs <path> [--owner <uid>:<gid>]\n');
  process.exit(2);
}

if (existsSync(path)) {
  process.stdout.write(`a2a-keygen: ${path} exists, left as it is\n`);
} else {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o400 });
  process.stdout.write(`a2a-keygen: wrote a P-256 key to ${path}\n`);
}

if (owner !== undefined) {
  const [uid, gid] = owner.split(':').map(Number);
  chownSync(path, uid, gid);
}
