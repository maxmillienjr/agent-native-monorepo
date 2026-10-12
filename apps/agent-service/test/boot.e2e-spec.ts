import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The compiled service as a process, for what only a process shows: its boot
 * log and its exit code. `test:service` depends on `build`, so `dist/` exists.
 *
 * The child gets no axis variable, and its working directory is an empty
 * directory, so no `.env` is read: the quickstart's clone with no `.env`.
 */
const MAIN = resolve('dist/main.js');

const AXIS_VARIABLES = [
  'GOOGLE_API_KEY',
  'DATABASE_URL',
  'NEO4J_URI',
  'SERVICE_CREDENTIALS',
  'A2A_PUBLIC_URL',
  'A2A_CARD_SIGNING_KEYS',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
];

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => done(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

interface Boot {
  readonly child: ChildProcess;
  readonly output: () => string;
  /** Milliseconds from spawn until `text` first appeared in the output, if it has. */
  readonly seenAt: (text: string) => number | undefined;
  readonly exited: Promise<{ code: number | null; ms: number }>;
}

function boot(cwd: string, env: Record<string, string>): Boot {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, LOG_LEVEL: 'info' };
  for (const name of AXIS_VARIABLES) if (!(name in env)) delete childEnv[name];

  const started = Date.now();
  const child = spawn(process.execPath, [MAIN], { cwd, env: childEnv });
  let output = '';
  // When each chunk arrived, as the output's length after it, so `seenAt` can
  // date any text in the output without the test naming it in advance.
  const arrivals: { ms: number; length: number }[] = [];
  const append = (chunk: Buffer) => {
    output += chunk.toString();
    arrivals.push({ ms: Date.now() - started, length: output.length });
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const seenAt = (text: string) => {
    const at = output.indexOf(text);
    if (at === -1) return undefined;
    return arrivals.find((arrival) => arrival.length >= at + text.length)?.ms;
  };
  const exited = new Promise<{ code: number | null; ms: number }>((done) =>
    child.once('exit', (code) => done({ code, ms: Date.now() - started })),
  );
  return { child, output: () => output, seenAt, exited };
}

async function waitFor(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const RUN_BODY = JSON.stringify({
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  messages: [{ role: 'user', content: 'What is LangGraph?' }],
});

describe('agent-service as a process', () => {
  let cwd: string;

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'agent-service-boot-'));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('boots open with no SERVICE_CREDENTIALS, says so, and serves both quickstart routes', async () => {
    const port = await freePort();
    const service = boot(cwd, { PORT: String(port) });

    try {
      await waitFor(() => service.output().includes('agent-service.ready'), 20_000);
      expect(service.output()).toContain('"msg":"auth.open"');
      expect(service.output()).toContain('"msg":"a2a.card.unsigned"');

      const base = `http://127.0.0.1:${port}`;
      const headers = { 'Content-Type': 'application/json' };
      const run = await fetch(`${base}/runs`, { method: 'POST', headers, body: RUN_BODY });
      expect(run.status).toBe(200);
      const stream = await fetch(`${base}/runs/stream`, {
        method: 'POST',
        headers,
        body: RUN_BODY,
      });
      expect(stream.status).toBe(200);
      expect(await stream.text()).toContain('"node":"done"');

      const card = await fetch(`${base}/.well-known/agent-card.json`, {
        headers: { 'A2A-Version': '1.0' },
      });
      expect(((await card.json()) as Record<string, unknown>)['securitySchemes']).toBeUndefined();
    } finally {
      service.child.kill();
      await service.exited;
    }
  }, 30_000);

  it('exits 1 within two seconds of naming SERVICE_CREDENTIALS when it is malformed', async () => {
    const service = boot(cwd, { PORT: String(await freePort()), SERVICE_CREDENTIALS: 'nocolon' });

    const { code, ms } = await service.exited;
    const named = service.seenAt('SERVICE_CREDENTIALS');

    expect(code).toBe(1);
    expect(named).toBeDefined();
    // Timed from the error, not from spawn. The defect this guards is the exit
    // itself: a pino transport per logger deadlocked `process.exit`, so the
    // service printed Nest's error naming the variable and then never exited
    // (P5-A). Exiting takes about 200 ms after the error. From spawn it took
    // about 900 ms locally, and once 2156 ms on a busy CI runner, because
    // loading the compiled service is most of it and that slows with the
    // machine. A hang never exits, so it fails here at any bound, or at the
    // test's timeout if it hangs before the error is printed.
    expect(ms - (named ?? 0)).toBeLessThan(2_000);
    expect(service.output()).not.toContain('nocolon');
  }, 20_000);
});
