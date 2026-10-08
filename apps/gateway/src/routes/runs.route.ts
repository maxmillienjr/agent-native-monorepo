import { Router } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { ROOT_CONTEXT, propagation } from '@opentelemetry/api';

const AGENT_SERVICE_URL = process.env['AGENT_SERVICE_URL'] ?? 'http://localhost:3000';

export const runsRouter = Router();

// Selection is done with `pathFilter`, not an Express mount path. A mount path
// is stripped from req.url before the proxy sees it, so `/runs` would reach the
// agent service as `/` and 404. pathFilter prefix-matches without rewriting,
// which is what makes /runs and /runs/stream arrive intact.
//
// `/a2a` and `/.well-known` are the A2A server and its discovery documents
// (P5-A). The gateway checks no credential: the service does, because compose
// publishes its port too. The caller's `Authorization` header is passed
// through untouched, as every request header is.
runsRouter.use(
  createProxyMiddleware({
    target: AGENT_SERVICE_URL,
    pathFilter: ['/runs', '/a2a', '/.well-known'],
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        // Forward correlation ID
        const correlationId = req.headers['x-correlation-id'];
        if (correlationId) {
          proxyReq.setHeader('x-correlation-id', correlationId as string);
        }
        // The caller's W3C trace context, re-injected by the propagator rather
        // than copied as raw headers. The gateway opens no span of its own (an
        // HTTP server span is a P5-A non-goal), so the context it forwards is
        // the caller's, and the service's run joins the caller's trace.
        propagation.inject(propagation.extract(ROOT_CONTEXT, req.headers), proxyReq, {
          set: (carrier, key, value) => carrier.setHeader(key, value),
        });
        // express.json() upstream of this router has already consumed the
        // request stream, so the proxied request would never be finalized and
        // the client would hang. Re-serialize the parsed body onto it. Applies
        // to the request only — SSE responses stream through untouched.
        fixRequestBody(proxyReq, req);
      },
    },
  }),
);
