import type { Grader, Score, Transcript } from '../types.js';

/**
 * A judge. `provider` is what the family check compares — the vendor, not the
 * model id, because a Gemini Flash model judging a Gemini Pro one is the same
 * self-preference problem as a model judging itself.
 */
export interface ModelJudge {
  readonly provider: string;
  readonly model: string;
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** One human-labelled example, used to measure a judge rather than trust it. */
export interface LabelledExample {
  readonly id: string;
  readonly transcript: Transcript;
  readonly label: 'pass' | 'fail';
}

export interface JudgeCalibration {
  readonly examples: number;
  /** Of the examples a human passed, the fraction the judge passed. */
  readonly truePositiveRate: number;
  /** Of the examples a human failed, the fraction the judge failed. */
  readonly trueNegativeRate: number;
}

export interface ModelGraderOptions {
  readonly name: string;
  readonly judge: ModelJudge;
  /** A binary question. Ordinal rubrics are not supported on purpose. */
  readonly rubric: string;
  /** The provider of the system under test — Gemini on both paths that matter. */
  readonly systemUnderTestProvider: string;
  readonly allowSameFamilyJudge?: boolean;
  /** Required when `allowSameFamilyJudge` is set. Written, not a boolean. */
  readonly sameFamilyJustification?: string;
}

export class SameFamilyJudgeError extends Error {
  constructor(provider: string) {
    super(
      `model grader refuses a judge from the system under test's own family (\`${provider}\`): ` +
        'a model scores its own output higher than a third party scores it. ' +
        'Set `allowSameFamilyJudge` with a written `sameFamilyJustification` to override.',
    );
    this.name = 'SameFamilyJudgeError';
  }
}

/**
 * A judge-backed grader.
 *
 * Two rules are enforced here rather than left to the task author. The judge
 * must come from a different family than the system under test unless the task
 * opts in with a written justification — the agent is Gemini on both paths that
 * matter, so in practice this means a judge that is not Google's, and a second
 * credential this repository does not currently ask for. And a judge is
 * validated, not trusted: `calibrate` measures it against human labels, and a
 * judge with no calibration set is reported as uncalibrated in the summary.
 */
export class ModelGrader<TOutcome = unknown> implements Grader<TOutcome> {
  readonly name: string;
  readonly kind = 'model' as const;
  readonly requires = { model: 'live' } as const;

  private readonly judge: ModelJudge;
  private readonly rubric: string;
  private calibration: JudgeCalibration | undefined;

  constructor(options: ModelGraderOptions) {
    const sameFamily = options.judge.provider === options.systemUnderTestProvider;
    const optedIn =
      options.allowSameFamilyJudge === true &&
      (options.sameFamilyJustification ?? '').trim().length > 0;

    if (sameFamily && !optedIn) throw new SameFamilyJudgeError(options.judge.provider);

    this.name = options.name;
    this.judge = options.judge;
    this.rubric = options.rubric;
  }

  /** `undefined` until `calibrate` has run. Reported, never inferred. */
  get calibrationReport(): JudgeCalibration | undefined {
    return this.calibration;
  }

  async calibrate(examples: readonly LabelledExample[]): Promise<JudgeCalibration> {
    let positives = 0;
    let truePositives = 0;
    let negatives = 0;
    let trueNegatives = 0;

    for (const example of examples) {
      const verdict = await this.ask(example.transcript);
      if (example.label === 'pass') {
        positives += 1;
        if (verdict.label === 'pass') truePositives += 1;
      } else {
        negatives += 1;
        if (verdict.label === 'fail') trueNegatives += 1;
      }
    }

    this.calibration = {
      examples: examples.length,
      truePositiveRate: positives === 0 ? 0 : truePositives / positives,
      trueNegativeRate: negatives === 0 ? 0 : trueNegatives / negatives,
    };
    return this.calibration;
  }

  async grade(transcript: Transcript): Promise<Score> {
    return this.ask(transcript);
  }

  private async ask(transcript: Transcript): Promise<Score> {
    const conversation = transcript.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');

    const raw = await this.judge.complete(
      'You grade an AI agent transcript against one binary criterion. ' +
        'Respond with JSON: {"label": "pass" | "fail", "explanation": "..."}. ' +
        'The explanation is required and must cite the transcript.',
      `Criterion: ${this.rubric}\n\nTranscript:\n${conversation}`,
    );

    // The judge is a system boundary: its response is parsed, not trusted. A
    // malformed verdict throws rather than defaulting, because a model grader
    // that silently returns `fail` on a parse error reports the agent as broken
    // when the judge is.
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('label' in parsed) ||
      ((parsed as { label: unknown }).label !== 'pass' &&
        (parsed as { label: unknown }).label !== 'fail')
    ) {
      throw new Error(`judge \`${this.judge.model}\` returned no usable label: ${raw}`);
    }

    const label = (parsed as { label: 'pass' | 'fail' }).label;
    const explanation = String((parsed as { explanation?: unknown }).explanation ?? '').trim();
    if (explanation === '') {
      throw new Error(`judge \`${this.judge.model}\` returned no explanation`);
    }

    return { value: label === 'pass' ? 1 : 0, label, explanation };
  }
}

/**
 * Imports human labels as a grader.
 *
 * It exists so a judge can be measured against them — a `human` kind in the
 * same interface means the calibration set and the thing it calibrates are the
 * same shape.
 */
export function humanLabelGrader<TOutcome>(
  name: string,
  labels: ReadonlyMap<string, 'pass' | 'fail'>,
): Grader<TOutcome> {
  return {
    name,
    kind: 'human',
    grade: async (transcript): Promise<Score> => {
      const label = labels.get(transcript.runId);
      if (label === undefined) {
        throw new Error(`no human label imported for run ${transcript.runId}`);
      }
      return { value: label === 'pass' ? 1 : 0, label, explanation: 'imported human label' };
    },
  };
}
