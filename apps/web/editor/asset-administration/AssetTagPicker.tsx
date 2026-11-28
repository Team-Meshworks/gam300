import { Icon as UiIcon } from "@iconify/react/offline";
import faXmark from "@iconify-icons/lucide/x";
import { useId, useState } from "react";
import { normalizeTag, tagKey } from "./asset-tags";

// Each tag is a bubble; an X appears when the tag can be taken off the asset
export function AssetTagBubbles({
  tags,
  onRemove,
  disabled = false,
}: {
  tags: readonly string[];
  onRemove?: ((tag: string) => void) | undefined;
  disabled?: boolean;
}) {
  return (
    <ul className="asset-admin-tag-bubbles">
      {tags.map((tag) => (
        <li key={tagKey(tag)} className="asset-admin-tag-bubble">
          <span>{tag}</span>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              title={`Remove ${tag}`}
              disabled={disabled}
              onClick={() => onRemove(tag)}
            >
              <UiIcon icon={faXmark} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// Pick from the shared list or type a new tag; typing a near-duplicate reuses the existing spelling
export function AssetTagPicker({
  value,
  available,
  onChange,
  disabled,
  maxTags = 10,
  maxLength = 40,
}: {
  value: readonly string[];
  available: readonly string[];
  onChange: (tags: string[]) => void;
  disabled: boolean;
  // Older servers omit these limits, so the server defaults apply
  maxTags?: number | undefined;
  maxLength?: number | undefined;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const chosen = new Set(value.map(tagKey));
  // Show every known tag plus any new ones added in this form, keeping a stable alphabetical order
  const known = new Map(available.map((tag) => [tagKey(tag), tag]));
  for (const tag of value) if (!known.has(tagKey(tag))) known.set(tagKey(tag), tag);
  const options = [...known.values()].sort((a, b) => a.localeCompare(b));
  // Chosen tags show as removable bubbles, so only the rest are offered to add
  const unused = options.filter((tag) => !chosen.has(tagKey(tag)));
  const full = value.length >= maxTags;

  const typed = draft.trim() ? normalizeTag(draft, maxLength) : null;
  const existing = typed ? known.get(tagKey(typed)) : undefined;
  const hint = !draft.trim()
    ? `Choose up to ${maxTags} tags, or type a new one.`
    : !typed
      ? `Use up to ${maxLength} letters, numbers, spaces or - ' & ( ) . ,`
      : existing && chosen.has(tagKey(existing))
        ? `"${existing}" is already on this asset.`
        : existing
          ? `Press Enter to add the existing tag "${existing}".`
          : full
            ? `This asset already has ${maxTags} tags.`
            : `Press Enter to create the new tag "${typed}".`;

  function toggle(tag: string) {
    if (chosen.has(tagKey(tag))) onChange(value.filter((other) => tagKey(other) !== tagKey(tag)));
    else if (!full) onChange([...value, tag]);
  }

  function add() {
    if (!typed) return;
    const tag = existing ?? typed;
    if (!chosen.has(tagKey(tag)) && !full) onChange([...value, tag]);
    setDraft("");
  }

  return (
    <fieldset className="asset-admin-tags" data-asset-field="tags" disabled={disabled}>
      <legend>Tags</legend>
      {value.length > 0 && <AssetTagBubbles tags={value} onRemove={toggle} disabled={disabled} />}
      {unused.length > 0 && (
        <div className="asset-admin-tag-options" aria-label="Existing tags">
          {unused.map((tag) => (
            <button
              key={tagKey(tag)}
              type="button"
              className="asset-admin-tag"
              aria-label={`Add tag ${tag}`}
              disabled={full}
              onClick={() => toggle(tag)}
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
      <div className="asset-admin-tag-add">
        <input
          aria-label="Add a tag"
          aria-describedby={`${id}-hint`}
          value={draft}
          maxLength={maxLength + 10}
          placeholder="Add a tag"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the tag rather than submitting the whole asset form
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="ui-button"
          disabled={!typed || full || (existing !== undefined && chosen.has(tagKey(existing)))}
          onClick={add}
        >
          Add
        </button>
      </div>
      <p id={`${id}-hint`} className="asset-admin-tag-hint" aria-live="polite">
        {hint}
      </p>
    </fieldset>
  );
}
