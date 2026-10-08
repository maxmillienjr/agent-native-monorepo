import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * A time-stamping authority on localhost, for tests: a CA and a signer made in
 * a temporary directory, `openssl ts -reply` behind a Node HTTP server. CI
 * anchors against this and never touches the network.
 *
 * `@repo/decision-ledger/testing` and not the barrel, for the reason
 * `@repo/determination/clinician` is a subpath: the service must never be
 * able to reach it. A ledger anchored by a TSA whose CA key sits in /tmp
 * proves nothing.
 *
 * The signer's certificate carries a critical `timeStamping` extended key
 * usage, which OpenSSL requires of a TSA signer, and both certificates are
 * named synthetic.
 */

const run = promisify(execFile);

async function openssl(cwd: string, args: readonly string[]): Promise<void> {
  await run(process.env['LEDGER_OPENSSL'] ?? 'openssl', [...args], { cwd });
}

export interface TestTsa {
  /** `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** The root that vouches for the signer: what `LEDGER_TSA_CA` names. */
  readonly caFile: string;
  /** How many requests it has answered. */
  readonly requests: () => number;
  close(): Promise<void>;
}

const TSA_CONFIG = `
[ tsa ]
default_tsa = tsa_config

[ tsa_config ]
dir = .
serial = ./serial
crypto_device = builtin
signer_cert = ./tsa.crt
signer_key = ./tsa.key
signer_digest = sha256
default_policy = 1.3.6.1.4.1.99999.1
digests = sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
`;

export async function startTestTsa(): Promise<TestTsa> {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-test-tsa-'));
  const p256 = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];

  await openssl(dir, [
    'req',
    '-x509',
    ...p256,
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=Synthetic Test TSA Root (not a real authority)',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  await openssl(dir, [
    'req',
    ...p256,
    '-keyout',
    'tsa.key',
    '-out',
    'tsa.csr',
    '-subj',
    '/CN=Synthetic Test TSA (not a real authority)',
  ]);
  await writeFile(
    join(dir, 'tsa.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n',
  );
  await openssl(dir, [
    'x509',
    '-req',
    '-in',
    'tsa.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'tsa.crt',
    '-days',
    '2',
    '-extfile',
    'tsa.ext',
  ]);
  await writeFile(join(dir, 'serial'), '01\n');
  await writeFile(join(dir, 'tsa.cnf'), TSA_CONFIG);

  let answered = 0;
  // One request at a time: `openssl ts -reply` increments the serial file.
  let queue: Promise<unknown> = Promise.resolve();

  const reply = async (query: Buffer): Promise<Buffer> => {
    const id = `${Date.now()}-${answered}`;
    const request = join(dir, `${id}.tsq`);
    const response = join(dir, `${id}.tsr`);
    await writeFile(request, query);
    await openssl(dir, [
      'ts',
      '-reply',
      '-config',
      'tsa.cnf',
      '-queryfile',
      request,
      '-out',
      response,
    ]);
    answered += 1;
    return readFile(response);
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const job = queue.then(() => reply(Buffer.concat(chunks)));
      queue = job.catch(() => undefined);
      job.then(
        (body) => {
          res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' });
          res.end(body);
        },
        () => {
          res.writeHead(400);
          res.end();
        },
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test TSA has no port');

  return {
    url: `http://127.0.0.1:${address.port}/`,
    caFile: join(dir, 'ca.pem'),
    requests: () => answered,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
