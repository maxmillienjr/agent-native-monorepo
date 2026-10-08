import { context, propagation } from '@opentelemetry/api';
import type { RequestHandler } from 'express';

/**
 * Continues a caller's trace (P5-A, handed over by P2-C).
 *
 * The propagator `initTelemetry` registers is W3C trace context, so a
 * `traceparent` on the request becomes the parent of the run's root span and,
 * through it, of every `agent.node.*` span. With no header, or a malformed
 * one, the extracted context is the active one and the run starts its own
 * trace, as before. It reaches the Nest controllers and the A2A executor alike,
 * because both run inside `next()`.
 *
 * The extracted context carries a remote span and no span of this service's:
 * an HTTP server span is a non-goal of P5-A, so the caller's span is the
 * parent of the run's `invoke_agent` root.
 */
export const extractTraceContext: RequestHandler = (req, _res, next) => {
  const extracted = propagation.extract(context.active(), req.headers);
  context.with(extracted, next);
};
