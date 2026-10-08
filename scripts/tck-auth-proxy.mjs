#!/usr/bin/env node
// Adds the bearer credential the A2A TCK cannot send (P5-A). The TCK's
// JSON-RPC client sets only A2A-Version, so it runs against this proxy, and
// the card's interface URL points here too, so every call it makes comes back
// through it. Streams both ways, SSE included.
//
//   TCK_TOKEN=... node scripts/tck-auth-proxy.mjs <listen-port> <target-url>
import { createServer, request } from 'node:http';

const [port, target] = process.argv.slice(2);
const token = process.env.TCK_TOKEN;
if (port === undefined || target === undefined || !token) {
  process.stderr.write('usage: TCK_TOKEN=... tck-auth-proxy.mjs <listen-port> <target-url>\n');
  process.exit(2);
}

const upstream = new URL(target);

createServer((req, res) => {
  const headers = { ...req.headers, host: upstream.host, authorization: `Bearer ${token}` };
  const forward = request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
    },
  );
  forward.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`tck-auth-proxy: ${error.message}\n`);
  });
  req.pipe(forward);
}).listen(Number(port), () => {
  process.stdout.write(`tck-auth-proxy: :${port} -> ${upstream.origin}\n`);
});
