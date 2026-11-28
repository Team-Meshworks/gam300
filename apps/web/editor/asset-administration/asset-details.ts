import type { AssetCandidate, AssetDetails, AssetReview } from "./asset-administration";

type Draft = {
  name: string;
  kind: AssetCandidate["kind"];
  category: string | null;
  review: AssetReview;
  tags: readonly string[];
};

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

// Builds a details save from the form. Tags go out only when this admin changed them, so a
// rename never restores or drops tags someone else changed meanwhile. The snapshot of what the
// form opened with lets the server reject the save if any field it writes has changed since.
export function detailsUpdate(original: AssetCandidate, draft: Draft): AssetDetails {
  const before = original.tags ?? [];
  return {
    name: draft.name,
    kind: draft.kind,
    category: draft.category,
    review: draft.review,
    ...(sameTags(before, draft.tags) ? {} : { tags: draft.tags }),
    expected: {
      name: original.name,
      category: original.category ?? null,
      review: {
        source: original.source ?? "",
        license: original.license ?? "",
        reviewNotes: original.reviewNotes ?? "",
      },
      tags: before,
    },
  };
}
