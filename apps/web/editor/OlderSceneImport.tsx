import { useEffect, useRef, useState } from "react";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { importOlderSceneFile, readOlderSceneFile } from "../shared/project/legacy-scene-import";
import { MAX_PROJECT_BYTES } from "../shared/project/project-limits";

type Pending = {
  text: string;
  name: string;
  scenes: readonly { id: string; name: string; environmentAssetId: string | null }[];
};
export function OlderSceneImport({
  assets,
  olderSceneFile,
  onImport,
  onError,
}: {
  assets: readonly CatalogueAsset[];
  olderSceneFile?: { text: string; name: string } | null;
  onImport: (file: File) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [environments, setEnvironments] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (pending) dialog.current?.showModal();
  }, [pending]);
  const kinds = new Map(assets.map((a) => [a.id, a.kind]));
  return (
    <>
      {olderSceneFile && (
        <button
          id="older-recovery-import"
          hidden
          type="button"
          onClick={() => {
            const result = readOlderSceneFile(olderSceneFile.text, kinds);
            if (!result.ok) {
              onError(result.error.message);
              return;
            }
            setError("");
            setEnvironments({});
            setPending({ ...olderSceneFile, scenes: result.value.scenes });
          }}
        >
          Import older browser backup
        </button>
      )}
      <input
        id="older-scene-import"
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          if (file.size > MAX_PROJECT_BYTES) {
            onError("Project JSON exceeds the 5 MiB file limit");
            return;
          }
          try {
            const text = await file.text();
            const result = readOlderSceneFile(text, kinds);
            if (!result.ok) {
              onError(`${result.error.path}: ${result.error.message}`);
              return;
            }
            setEnvironments({});
            setError("");
            setPending({ text, name: file.name, scenes: result.value.scenes });
          } catch {
            onError("Could not read the older scene file. The current project is unchanged.");
          }
        }}
      />
      {pending && (
        <dialog
          ref={dialog}
          aria-labelledby="older-import-heading"
          onCancel={() => setPending(null)}
        >
          <h2 id="older-import-heading">Import older scene file</h2>
          <p>
            Convert {pending.name} to project format 2. IDs, objects, view order and the starting
            camera are retained.
          </p>
          <p>
            The original file stays unchanged. Old undo history is not imported. Save the converted
            project as a new file.
          </p>
          <p>
            The new format supports up to 16 scenes and 64 views per scene. Files exceeding these
            limits are rejected without trimming data.
          </p>
          {pending.scenes
            .filter((s) => s.environmentAssetId === null)
            .map((scene) => (
              <label key={scene.id} style={{ display: "block", marginBlock: "1rem" }}>
                Environment for {scene.name} ({scene.id})
                <select
                  value={environments[scene.id] ?? ""}
                  onChange={(event) =>
                    setEnvironments({ ...environments, [scene.id]: event.target.value })
                  }
                >
                  <option value="">Choose an environment</option>
                  {assets
                    .filter((a) => a.kind === "environment")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
          {error && <p role="alert">{error}</p>}
          <button
            type="button"
            onClick={() => {
              const result = importOlderSceneFile(pending.text, kinds, environments);
              if (!result.ok) {
                setError(`${result.error.path}: ${result.error.message}`);
                return;
              }
              const file = new File(
                [JSON.stringify(result.value, null, 2)],
                pending.name.replace(/\.json$/i, "") + "-converted.json",
                { type: "application/json" },
              );
              setPending(null);
              void onImport(file);
            }}
          >
            Convert and open
          </button>
          <button type="button" onClick={() => setPending(null)}>
            Cancel
          </button>
        </dialog>
      )}
    </>
  );
}
