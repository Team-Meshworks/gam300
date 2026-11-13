import { useEffect, useMemo, useState } from "react";
import { uniqueRoomAssets, type CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { Icon } from "../ui/Icon";
import { Button } from "../../shared/ui/Button";
import { useModal } from "../../shared/ui/useModal";
import "./base-model-chooser.css";

export function BaseModelChooser({
  assets,
  busy,
  error,
  onContinue,
  onCancel,
}: {
  assets: readonly CatalogueAsset[];
  busy: boolean;
  error: string;
  onContinue: (assetId: string) => void;
  onCancel: () => void;
}) {
  const dialog = useModal(true);
  const models = useMemo(() => uniqueRoomAssets(assets), [assets]);
  const [selected, setSelected] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    // Reuse the library renderer; previews are local and release their models on departure.
    void import("../graphics/library-previews").then(({ generateLibraryPreviews }) => {
      if (!disposed)
        stop = generateLibraryPreviews(
          models.map((asset) => ({ ...asset, thumbnail: null })),
          (id, image) => {
            if (!disposed) setPreviews((previous) => ({ ...previous, [id]: image }));
          },
          true,
        );
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [models]);
  return (
    <dialog
      ref={dialog}
      className="sp-base-model-dialog"
      aria-labelledby="base-model-heading"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <section
        className="sp-base-model-panel"
        aria-labelledby="base-model-heading"
        aria-busy={busy}
      >
        <header>
          <button
            className="sp-base-model-close"
            aria-label="Close base model chooser"
            disabled={busy}
            onClick={onCancel}
          >
            <Icon name="close" />
          </button>
          <h1 id="base-model-heading">Choose your base model...</h1>
          <p>
            Use this model as a starting point. You can customise it in the editor and change it
            later.
          </p>
        </header>
        <div className="sp-base-model-grid" role="group" aria-label="Base models">
          {models.map((asset) => (
            <button
              key={asset.id}
              type="button"
              aria-label={asset.name}
              aria-pressed={selected === asset.id}
              disabled={busy}
              onClick={() => setSelected(asset.id)}
            >
              {previews[asset.id] ? (
                <img src={previews[asset.id]} alt="" />
              ) : (
                <span>{asset.name}</span>
              )}
            </button>
          ))}
        </div>
        {!models.length && (
          <p role="status">
            No base models are available. Try again when your organisation has an approved 3D space.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !models.some((asset) => asset.id === selected)}
            onClick={() => selected && onContinue(selected)}
          >
            Continue Editing
          </Button>
        </footer>
      </section>
    </dialog>
  );
}
