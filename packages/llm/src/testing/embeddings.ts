// Fixed-seed pseudo-embeddings (32 §6): deterministic unit vectors derived
// from a content hash — the memory pipeline is fully testable without a
// model. Same text ⇒ same vector; similar-but-different texts diverge.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string, seed: number): number {
  let hash = (FNV_OFFSET ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

/** Deterministic pseudo-embedding, L2-normalized. Default dim 768 (ADR-020). */
export function pseudoEmbedding(text: string, dimension = 768): number[] {
  const vector = new Array<number>(dimension);
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    // hash per component: [-1, 1) uniform-ish, fully content-determined
    const h = fnv1a(text, i * 2654435761);
    const value = (h / 0xffffffff) * 2 - 1;
    vector[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dimension; i++) vector[i] = vector[i]! / norm;
  return vector;
}

/** Canned consolidation extractions (32 §6) — fixture-keyed, stable shapes
 *  for memory-pipeline tests (T44). */
export interface CannedConsolidation {
  memories: Array<{
    title: string;
    content: string;
    kind: "procedure" | "fact" | "decision" | "lesson";
    importance: number;
    confidence: number;
  }>;
}

const CANNED: Record<string, CannedConsolidation> = {
  "csv-implementation": {
    memories: [
      {
        title: "CSV export uses streaming writes",
        content: "Large exports must stream rows; buffering the whole file OOMs at ~100k rows.",
        kind: "lesson",
        importance: 0.7,
        confidence: 0.9,
      },
      {
        title: "npm test is the gate before review",
        content: "Run the full test suite before requesting review; reviewers reject red builds.",
        kind: "procedure",
        importance: 0.6,
        confidence: 0.95,
      },
    ],
  },
};

export function cannedConsolidation(fixtureKey: string): CannedConsolidation {
  return (
    CANNED[fixtureKey] ?? {
      memories: [
        {
          title: `Consolidated: ${fixtureKey}`,
          content: `Deterministic canned extraction for fixture "${fixtureKey}".`,
          kind: "fact",
          importance: 0.5,
          confidence: 0.8,
        },
      ],
    }
  );
}
