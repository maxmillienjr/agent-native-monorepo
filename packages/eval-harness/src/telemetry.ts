import { ROOT_CONTEXT, TraceFlags, trace, type Context } from '@opentelemetry/api';
import { logs, type LogAttributes } from '@opentelemetry/api-logs';
import {
  AGENT_NATIVE,
  GENAI_SEMCONV,
  GEN_AI,
  GEN_AI_EVALUATION_RESULT,
  GEN_AI_OPERATION,
} from '@repo/telemetry/genai';
import type { Axes, SpanRecord, Transcript, Trial } from './types.js';

/**
 * The trial's `invoke_agent` span: the root of the run the graders judged.
 *
 * Found by what it is rather than by position, so a transcript whose spans
 * arrive in end order — children first, which is how an exporter sees them —
 * still yields the root.
 */
export function rootSpanRecord(transcript: Transcript): SpanRecord | undefined {
  return transcript.spans?.find(
    (span) =>
      span.parentSpanId === undefined &&
      span.attributes[GEN_AI.OPERATION_NAME] === GEN_AI_OPERATION.INVOKE_AGENT,
  );
}

/**
 * The context an event about this trial is emitted in.
 *
 * The run's root span has ended by the time grading runs, and that is
 * allowed: a log record carries a trace and span id, not a live span, so the
 * span context is rebuilt from the transcript's record of it. A transcript
 * with no such record — an `AgentHarness` that collects no spans — gets the
 * root context, and the event is unparented. The convention's fallback for
 * that case is `gen_ai.response.id`, and this repository has no response id
 * to offer.
 */
function parentContext(transcript: Transcript): Context {
  const root = rootSpanRecord(transcript);
  if (root === undefined) return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: root.traceId,
    spanId: root.spanId,
    traceFlags: TraceFlags.SAMPLED,
  });
}

/**
 * One `gen_ai.evaluation.result` event per grader result, parented to the
 * run it judged. Returns how many it emitted.
 *
 * A log record through the Logs API rather than `Span.addEvent`, which OTEP
 * 4430 deprecates; the conventions define the evaluation result as an event in
 * the Logs data model. The graders judge the run — its trajectory and its
 * writes — so the run's `invoke_agent` span is the "GenAI operation span being
 * evaluated".
 *
 * The axes travel with every result. A replayed `pass` is a frozen sample, and
 * a stream of events that did not say which axis produced each one would let a
 * dashboard average it with a live one — the failure `SuiteReport.axes` exists
 * to prevent.
 *
 * The API is a no-op until an SDK registers a logger provider, so a consumer
 * that registers none pays nothing.
 */
export function emitEvaluationResults(
  trial: Pick<Trial<unknown>, 'taskId' | 'index' | 'transcript' | 'results'>,
  axes: Axes,
): number {
  const logger = logs.getLogger('@repo/eval-harness', undefined, {
    schemaUrl: GENAI_SEMCONV.schemaUrl,
  });
  const context = parentContext(trial.transcript);

  for (const result of trial.results) {
    const attributes: LogAttributes = {
      [GEN_AI.EVALUATION_NAME]: result.grader,
      [GEN_AI.EVALUATION_SCORE_VALUE]: result.score.value,
      [GEN_AI.EVALUATION_SCORE_LABEL]: result.score.label,
      [AGENT_NATIVE.EVAL_TASK_ID]: trial.taskId,
      [AGENT_NATIVE.EVAL_TRIAL_INDEX]: trial.index,
      [AGENT_NATIVE.EVAL_GRADER_KIND]: result.kind,
      [AGENT_NATIVE.MODEL_AXIS]: axes.model,
      [AGENT_NATIVE.MEMORY_AXIS]: axes.memory,
    };
    if (result.score.explanation !== undefined) {
      attributes[GEN_AI.EVALUATION_EXPLANATION] = result.score.explanation;
    }

    logger.emit({ eventName: GEN_AI_EVALUATION_RESULT, context, attributes });
  }

  return trial.results.length;
}
