import { useState } from "react";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type {
  ContentComponent,
  ContentObject,
  TextMark,
} from "../../shared/project/project-content";
import type { ProjectDocument, ProjectObject } from "../../shared/project/project-types";
import { Dialog } from "../../shared/ui/Dialog";
import { Button } from "../../shared/ui/Button";
import type { createDocumentStore } from "../document-store";
import "./display-editor.css";
import { displayPosition } from "../display-position";

export function DisplayEditor({
  object,
  asset,
  assets,
  project,
  store,
  onClose,
}: {
  object: ProjectObject;
  asset: CatalogueAsset;
  assets: readonly CatalogueAsset[];
  project: ProjectDocument;
  store: ReturnType<typeof createDocumentStore>;
  onClose: () => void;
}) {
  const [openedProject] = useState(project);
  const existing = (object as ContentObject).components?.find((c) =>
    ["text", "image", "video"].includes(c.type),
  );
  const [type, setType] = useState<"text" | "image" | "video">(
    existing?.type === "image" || existing?.type === "video" ? existing.type : "text",
  );
  const [text, setText] = useState(
    existing?.type === "text" ? existing.runs.map((r) => r.text).join("") : "",
  );
  const [marks, setMarks] = useState<readonly TextMark[]>(
    existing?.type === "text" ? (existing.runs[0]?.marks ?? []) : [],
  );
  const [caption, setCaption] = useState(existing && "caption" in existing ? existing.caption : "");
  const [chosen, setChosen] = useState(existing && "assetId" in existing ? existing.assetId : "");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const physical = asset.displayRole === "physical";
  const candidates = assets.filter(
    (a) =>
      (physical ? a.kind === "model" && !a.displayRole : a.kind === type) &&
      a.name.toLowerCase().includes(query.toLowerCase()),
  );
  function current() {
    if (store.getSnapshot().project !== openedProject) {
      setError("The project changed. Close this editor and select the display again.");
      return false;
    }
    return true;
  }
  function save() {
    if (!current()) return;
    if (physical) {
      const result = store.addAttachedObject(
        chosen,
        object.id,
        displayPosition(object, asset.displayTop ?? 0),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
    } else {
      const id = existing?.id ?? crypto.randomUUID();
      const component: ContentComponent =
        type === "text"
          ? { id, type, runs: [{ text, marks }], caption }
          : type === "image"
            ? { id, type, assetId: chosen, caption, alt: caption }
            : { id, type, assetId: chosen, caption, loop: false, volume: 1 };
      const result = store.setDisplayContent(object.id, component);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
    }
    onClose();
  }
  function remove() {
    if (!current()) return;
    const result = physical
      ? store.removeDisplayedAsset(object.id)
      : store.setDisplayContent(object.id, null);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onClose();
  }
  return (
    <Dialog
      title={physical ? "Place an object on this display" : "Edit display content"}
      onClose={onClose}
      variant="wide"
    >
      <div className="display-editor">
        <p>{object.name}</p>
        {!physical && (
          <div className="display-kind" role="group" aria-label="Content type">
            {(["image", "text", "video"] as const).map((kind) => (
              <Button
                key={kind}
                aria-pressed={type === kind}
                onClick={() => {
                  setType(kind);
                  setChosen("");
                  setError("");
                }}
              >
                {kind === "image" ? "Photo" : kind === "text" ? "Text" : "Video"}
              </Button>
            ))}
          </div>
        )}
        {!physical && type === "text" ? (
          <>
            <label>
              Text
              <textarea maxLength={65536} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <div role="group" aria-label="Text formatting">
              {(["bold", "italic", "underline"] as const).map((mark) => (
                <Button
                  key={mark}
                  aria-pressed={marks.includes(mark)}
                  onClick={() =>
                    setMarks(
                      marks.includes(mark) ? marks.filter((m) => m !== mark) : [...marks, mark],
                    )
                  }
                >
                  {mark}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <>
            <label>
              Search library
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="display-choices">
              {candidates.map((entry) => (
                <Button
                  key={entry.id}
                  aria-pressed={chosen === entry.id}
                  onClick={() => setChosen(entry.id)}
                >
                  {entry.name}
                </Button>
              ))}
            </div>
            {candidates.length === 0 && (
              <p role="status">
                No {physical ? "objects" : type === "image" ? "photos" : "videos"} in the approved
                library match. Media must be registered in the asset catalogue before use.
              </p>
            )}
          </>
        )}
        {!physical && (
          <label>
            Caption (optional)
            <textarea
              maxLength={4096}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="display-actions">
          <Button
            variant="primary"
            disabled={
              physical || type !== "text" ? !candidates.some((a) => a.id === chosen) : !text.trim()
            }
            onClick={save}
          >
            Apply
          </Button>
          <Button onClick={remove}>Remove content</Button>
        </div>
      </div>
    </Dialog>
  );
}
