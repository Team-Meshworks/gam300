import type { ContentScene } from "../shared/project/project-content";

export function ExhibitionContent({
  scene,
  navigate,
}: {
  scene: ContentScene;
  navigate: (sceneId: string, viewpointId: string) => void;
}) {
  // Show information only for visible exhibits in the current scene
  return (
    <section aria-label="Exhibit information">
      {scene.objects
        .filter((object) => object.visible && object.components.length)
        .map((object) => (
          <article key={object.id}>
            <h2>{object.name}</h2>
            {object.components.map((component) => {
              // Keep navigation targets as saved IDs so they still work after scenes are reordered
              if (component.type === "navigationPoint") {
                return (
                  <button
                    key={component.id}
                    onClick={() => navigate(component.sceneId, component.viewpointId)}
                  >
                    {component.label}
                  </button>
                );
              }
              if (component.type !== "text") {
                return null;
              }

              // Render each run as text; saved formatting never becomes HTML
              // Keep the caption separate from the formatted exhibit text
              return (
                <figure key={component.id}>
                  <p
                    style={{
                      whiteSpace: "pre-wrap",
                      fontSize: component.fontSize,
                      color: component.color,
                      backgroundColor: component.background,
                    }}
                  >
                    {component.runs.map((run, index) => (
                      <span
                        key={index}
                        style={{
                          fontWeight: run.marks.includes("bold") ? "bold" : undefined,
                          fontStyle: run.marks.includes("italic") ? "italic" : undefined,
                          textDecoration: run.marks.includes("underline") ? "underline" : undefined,
                        }}
                      >
                        {run.text}
                      </span>
                    ))}
                  </p>
                  {component.caption && <figcaption>{component.caption}</figcaption>}
                </figure>
              );
            })}
          </article>
        ))}
    </section>
  );
}
