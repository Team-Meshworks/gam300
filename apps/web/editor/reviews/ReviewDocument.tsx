import type { ProjectDocument } from "../../shared/project/project-types";

// Read the retained document itself, never a live editor store or mutable catalogue URL.
export function ReviewDocument({
  document,
  revision,
  submitted,
}: {
  document: ProjectDocument;
  revision: number;
  submitted: boolean;
}) {
  return (
    <section
      className="sp-card sp-review-document"
      aria-label={submitted ? "Submitted content" : "Saved content"}
    >
      <h3>
        {submitted ? "Submitted content" : "Saved content"} · Revision {revision}
      </h3>
      <p>{document.title}</p>
      <p className="sp-hint">
        {submitted
          ? "This is the retained submission. Later edits do not change it."
          : "This is the saved server revision. Unsaved editor changes and local files are not included."}
      </p>
      <p className="sp-hint">
        The 3D asset preview is unavailable here. Inspect the scene and object details below.
      </p>
      {document.scenes.map((scene, index) => (
        <details key={scene.id}>
          <summary>
            Scene {index + 1}: {scene.name} · {scene.objects.length} objects
          </summary>
          <p>Environment: {scene.environmentAssetId}</p>
          <details>
            <summary>Starting view and scene settings</summary>
            <pre>{JSON.stringify({ ...scene, objects: undefined }, null, 2)}</pre>
          </details>
          {scene.objects.map((object) => (
            <details key={object.id}>
              <summary>
                {object.name} · {object.assetId}
              </summary>
              <pre>{JSON.stringify(object, null, 2)}</pre>
            </details>
          ))}
        </details>
      ))}
      <details>
        <summary>Complete saved document</summary>
        <pre>{JSON.stringify(document, null, 2)}</pre>
      </details>
    </section>
  );
}
