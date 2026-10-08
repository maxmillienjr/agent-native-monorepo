import type { RetrievalCandidate } from '@repo/memory-core';

/**
 * Reciprocal Rank Fusion constant. Higher values produce more uniform
 * blending between result sources; 60 is the standard default from
 * the original RRF paper (Cormack et al., 2009).
 */
const RRF_K = 60;

/**
 * Merges ranked lists using Reciprocal Rank Fusion: the fusion the service ran
 * over the vector and graph lists until ADR 0009.
 *
 * It lives here, beside the ablation, because the ablation is its only caller.
 * The service stopped fusing when ADR 0009 made retrieval vector-only, and
 * `memory-core` no longer carries it. P2-B's `hybrid` conditions call it, and
 * so does every in-memory re-fusion behind the tie-sensitivity range, so a
 * re-run of `yarn eval:retrieval` measures the fusion that was deployed when
 * the ablation decided ADR 0002. A successor that measures a graph condition
 * against that baseline (ADR 0009, "What a positive result would need")
 * starts from here.
 *
 * For each candidate, the RRF score is `1 / (k + rank)`, with rank
 * 1-indexed. A candidate in more than one list scores the sum.
 *
 * The key is `contentHash`, falling back to `content`. A fact's hash is
 * sha256 of the text `content` carries, so both spellings identify a fact
 * identically. It is the key because both readers return facts from one
 * universe (ADR 0004); it was once `entityId ?? content`, under which the two
 * lists never intersected. The first candidate seen under a key is the one
 * kept, so a fact both lists hold reports the `source` of the first list.
 */
export function rrfMerge(lists: RetrievalCandidate[][], topK: number): RetrievalCandidate[] {
  const scoreMap = new Map<string, { candidate: RetrievalCandidate; rrfScore: number }>();

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const candidate = list[rank]!;
      const key = candidate.contentHash ?? candidate.content;
      const rrfScore = 1 / (RRF_K + rank + 1);

      const existing = scoreMap.get(key);
      if (existing) {
        existing.rrfScore += rrfScore;
      } else {
        scoreMap.set(key, { candidate, rrfScore });
      }
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
    .map(({ candidate, rrfScore }) => ({
      ...candidate,
      score: rrfScore,
    }));
}
