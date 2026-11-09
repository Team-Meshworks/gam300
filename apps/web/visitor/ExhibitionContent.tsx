import { useEffect, useRef, useState } from "react";
import type { ContentComponent } from "../shared/project/project-content";
import type { VisitorScene } from "./visitor-playback";
import type { CatalogueAsset } from "../shared/asset-runtime/catalogue";
import { fetchPublicationAsset } from "./publication-asset";

function Media({
  component,
  assets,
  ownerId,
}: {
  component: Extract<ContentComponent, { type: "image" | "audio" | "video" }>;
  assets: readonly CatalogueAsset[];
  ownerId?: string;
}) {
  // Each media component owns a verified object URL and releases it when its scene leaves
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const media = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let blobUrl = "";
    const asset = assets.find(
      (item) => item.id === component.assetId && item.kind === component.type,
    );
    // Fetch through the publication route and verify the edition's exact bytes before displaying media
    void (async () => {
      if (!asset) throw new Error("This exhibition media is unavailable");
      const response = await fetchPublicationAsset(asset.url, controller.signal);
      if (!response.ok)
        throw new Error("This exhibition media is unavailable or your access changed");
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== asset.sha256) throw new Error("This exhibition media could not be verified");
      if (controller.signal.aborted) return;
      blobUrl = URL.createObjectURL(
        new Blob([bytes], {
          type: response.headers.get("Content-Type") ?? "application/octet-stream",
        }),
      );
      setUrl(blobUrl);
    })().catch((cause: unknown) => {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "Media could not be loaded");
    });
    const node = media.current;
    return () => {
      controller.abort();
      node?.pause();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [assets, component.assetId, component.type]);
  if (error) return <p role="alert">{error}</p>;
  if (component.type === "image")
    return url ? <img src={url} alt={component.alt} /> : <p role="status">Loading image…</p>;
  // Native Play also unlocks the scene's spatial graph before the media becomes audible
  const common = {
    onPlay: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      event.currentTarget.dispatchEvent(new CustomEvent("exhibit-start", { bubbles: true })),
    src: url || undefined,
    controls: true,
    loop: component.loop,
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      event.currentTarget.volume = component.volume;
    },
    onError: () => setError("This media could not be played"),
  };
  return component.type === "audio" ? (
    <audio
      {...common}
      ref={media as React.RefObject<HTMLAudioElement>}
      data-spatial-owner={component.mode === "spatial" ? ownerId : undefined}
      data-background="true"
      aria-label={component.caption || "Exhibition audio"}
    />
  ) : (
    <video
      {...common}
      ref={media as React.RefObject<HTMLVideoElement>}
      aria-label={component.caption || "Exhibition video"}
      playsInline
    />
  );
}

export function ExhibitionContent({
  scene,
  assets,
  navigate,
}: {
  scene: VisitorScene;
  assets: readonly CatalogueAsset[];
  navigate: (sceneId: string, viewpointId: string) => void;
}) {
  const hotspots = "hotspots" in scene ? scene.hotspots : [];
  const components = (object: VisitorScene["objects"][number]): readonly ContentComponent[] =>
    "components" in object ? (object.components as readonly ContentComponent[]) : [];
  const section = useRef<HTMLElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const content = section.current;
    const open = () => {
      if (details.current) details.current.open = true;
      if (document.pointerLockElement) document.exitPointerLock();
    };
    const inspect = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const object = scene.objects.find((item) => item.id === id);
      if (
        object &&
        "components" in object &&
        Array.isArray(object.components) &&
        object.components.length
      )
        open();
    };
    content?.addEventListener("exhibit-inspect", inspect);
    content?.addEventListener("exhibit-show-panel", open);
    return () => {
      content?.removeEventListener("exhibit-inspect", inspect);
      content?.removeEventListener("exhibit-show-panel", open);
    };
  }, [scene]);
  const activate = (id: string) =>
    section.current?.dispatchEvent(new CustomEvent("exhibit-activate", { detail: id }));
  // Keep literal text and native media controls accessible beside the 3D view
  // Panel events stay scoped to this scene so old timers cannot operate on new content
  function component(item: ContentComponent, ownerId?: string) {
    if (item.type === "hotspot")
      return (
        <button key={item.id} onClick={() => ownerId && activate(ownerId)}>
          {item.label || "Activate exhibit"}
        </button>
      );
    if (item.type === "navigationPoint")
      return (
        <button key={item.id} onClick={() => navigate(item.sceneId, item.viewpointId)}>
          {item.label}
        </button>
      );
    return (
      <figure key={item.id} data-component-id={item.id}>
        {item.type === "text" ? (
          <p
            style={{
              whiteSpace: "pre-wrap",
              fontSize: item.fontSize,
              color: item.color,
              backgroundColor: item.background,
            }}
          >
            {item.runs.map((run, index) => (
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
        ) : (
          <Media
            key={item.assetId}
            component={item}
            assets={assets}
            {...(ownerId ? { ownerId } : {})}
          />
        )}
        {item.caption && <figcaption>{item.caption}</figcaption>}
        {(item.type === "text" || item.type === "image") && (
          <button
            onClick={(event) => {
              const panel = event.currentTarget.closest("figure");
              if (panel) panel.hidden = true;
              section.current?.dispatchEvent(
                new CustomEvent("exhibit-panel-close", { detail: item.id }),
              );
            }}
          >
            Close panel
          </button>
        )}
      </figure>
    );
  }
  return (
    <details className="visitor-information" ref={details}>
      <summary>Exhibit information</summary>
      <section ref={section} aria-label="Exhibit information" data-exhibition-scene={scene.id}>
        {("audio" in scene ? scene.audio : [])?.map((item) => component(item))}
        {scene.objects
          .filter(
            (object) =>
              components(object).length ||
              hotspots.some(
                (hotspot) => hotspot.objectId.toLowerCase() === object.id.toLowerCase(),
              ),
          )
          .map((object) => (
            <article
              key={object.id}
              data-owner-id={object.id}
              hidden={"visible" in object && object.visible === false}
            >
              <h2>{object.name}</h2>
              {hotspots.some(
                (hotspot) => hotspot.objectId.toLowerCase() === object.id.toLowerCase(),
              ) && <button onClick={() => activate(object.id)}>Activate {object.name}</button>}
              {components(object).map((item) => component(item, object.id))}
            </article>
          ))}
      </section>
    </details>
  );
}
