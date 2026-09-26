import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { trace, type Tracer } from '@opentelemetry/api';

type SpanProcessor = NonNullable<NodeSDKConfiguration['spanProcessors']>[number];
type LogRecordProcessor = NonNullable<NodeSDKConfiguration['logRecordProcessors']>[number];

/**
 * The explicit form, for a process that needs to read its own telemetry.
 *
 * The evaluation runner is the case: it keeps every finished span in memory so
 * a transcript can carry its run's trace, and it counts the evaluation events
 * it emitted. Nothing here is read from the environment except the OTLP
 * endpoint, and that only to decide whether to export as well.
 */
export interface TelemetryOptions {
  readonly serviceName?: string;
  /** Processors that see every span, beside the OTLP export when there is one. */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** Processors that see every log record, beside the OTLP export when there is one. */
  readonly logRecordProcessors?: readonly LogRecordProcessor[];
}

let sdk: NodeSDK | undefined;

/**
 * `??` only falls back on undefined, and docker-compose passes
 * OTEL_EXPORTER_OTLP_ENDPOINT through as an empty string when the host has none
 * set. That built the url '/v1/traces', which OTLPTraceExporter rejects in its
 * constructor, so `docker compose --profile full up` died during bootstrap.
 */
function configuredEndpoint(): string | undefined {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  return endpoint ? endpoint : undefined;
}

/**
 * Starts the SDK and registers it globally, context manager included — without
 * one `startActiveSpan` does not propagate and every span is a root.
 *
 * Called with a service name, it is the service's configuration: traces over
 * OTLP to the configured endpoint or `http://localhost:4318`. Called with
 * options, it exports over OTLP only when an endpoint is configured, and
 * registers no metric reader: nothing in this repository reads a metric.
 */
export function initTelemetry(options?: string | TelemetryOptions): void {
  const explicit = typeof options === 'object' ? options : undefined;
  const serviceName =
    (typeof options === 'string' ? options : explicit?.serviceName) ??
    process.env['OTEL_SERVICE_NAME'] ??
    'agent-service';
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });

  if (explicit === undefined) {
    const endpoint = configuredEndpoint() ?? 'http://localhost:4318';
    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    });
    sdk.start();
    return;
  }

  const endpoint = configuredEndpoint();
  const spanProcessors: SpanProcessor[] = [...(explicit.spanProcessors ?? [])];
  const logRecordProcessors: LogRecordProcessor[] = [...(explicit.logRecordProcessors ?? [])];

  if (endpoint !== undefined) {
    spanProcessors.push(
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) }),
    );
    logRecordProcessors.push(
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
      }),
    );
  }

  sdk = new NodeSDK({ resource, spanProcessors, logRecordProcessors, metricReaders: [] });
  sdk.start();
}

/** Flushes and stops whatever `initTelemetry` started. */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}
