/**
 * The seed linker as `retrieve` ran it until ADR 0009: the graph retriever's
 * only way in from a query.
 *
 * It keeps capitalized words longer than two characters, lowercases them and
 * deletes every character outside `[a-z0-9-]`. It does not match concepts:
 * each word becomes a candidate id on its own, so `Prior Authorization` is
 * `["prior", "authorization"]`, and an id containing `_` — which the live
 * extraction writes for most entities — can never be produced.
 *
 * No request runs it. ADR 0009 made retrieval vector-only and took this off
 * the request path. It lives beside the P2-B ablation runner, its one caller,
 * so that `yarn eval:retrieval` still measures the linker that was deployed
 * when the ablation decided ADR 0002. It is frozen for that reason: a fix
 * belongs in a new linker, measured as a new condition (ADR 0009, "What a
 * positive result would need"), and not in an edit here that would quietly
 * change a historical measurement.
 */
export function extractSeedEntityIds(
  messages: readonly { readonly role: string; readonly content: string }[],
): string[] {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) return [];

  const words = lastUserMessage.content.split(/\s+/);
  return words
    .filter((w) => w.length > 2 && /^[A-Z]/.test(w))
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ''));
}
