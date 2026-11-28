const SHOWN = 2;

// Era and theme tags on a library card; the rest stay in the tooltip so cards keep one size
export function AssetTagList({ tags }: { tags: readonly string[] | undefined }) {
  if (!tags?.length) return null;
  const hidden = tags.length - SHOWN;
  return (
    <span className="asset-tag-list" title={tags.join(", ")}>
      {tags.slice(0, SHOWN).map((tag) => (
        <span key={tag} className="asset-tag asset-tag--label">
          {tag}
        </span>
      ))}
      {hidden > 0 && (
        <span className="asset-tag asset-tag--label" aria-label={`${hidden} more tags`}>
          +{hidden}
        </span>
      )}
    </span>
  );
}
