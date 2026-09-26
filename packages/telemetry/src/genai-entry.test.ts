import { describe, it, expect, vi } from 'vitest';

// Flips when anything in the module graph under test imports the SDK.
const loaded = vi.hoisted(() => ({ sdkNode: false }));

vi.mock('@opentelemetry/sdk-node', async (importOriginal) => {
  loaded.sdkNode = true;
  return importOriginal();
});

/**
 * `@repo/telemetry/genai` is what `memory-core` and `eval-harness` import for
 * the attribute names. If it pulled in `sdk-node`, every consumer of a name
 * would load the whole SDK, exporters included.
 */
describe('@repo/telemetry/genai', () => {
  it('does not load @opentelemetry/sdk-node', async () => {
    const genai = await import('./genai.js');

    expect(genai.GENAI_SEMCONV.commit).toBe('e57c543b4889619eb2a05702471937db5119165d');
    expect(typeof genai.withInferenceSpan).toBe('function');
    expect(loaded.sdkNode).toBe(false);
  });

  it('would have seen it: the root entry point does load it', async () => {
    // The control. Without it a probe that never fires passes the test above.
    await import('./otel.setup.js');
    expect(loaded.sdkNode).toBe(true);
  });
});
