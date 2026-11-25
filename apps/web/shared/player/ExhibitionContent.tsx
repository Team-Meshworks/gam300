import { cancelStandPlaybackAttempt, playStandVideo } from "../asset-runtime/stand-video";
import { useEffect, useRef, useState } from "react";
import type { ContentComponent } from "../project/project-content";
import type { VisitorScene } from "./playback";
import type { CatalogueAsset } from "../asset-runtime/catalogue";
import { fetchPlayerAsset } from "./player-asset";

type DisplayComponent = Extract<ContentComponent, { type: "text" | "image" | "video" }>;

function Text({ component }: { component: Extract<ContentComponent, { type: "text" }> }) {
  return (
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
  );
}

function Media({
  component,
  assets,
  ownerId,
  standVideo,
  visit,
}: {
  component: Extract<ContentComponent, { type: "image" | "audio" | "video" }>;
  assets: readonly CatalogueAsset[];
  ownerId?: string;
  standVideo: boolean;
  visit: number;
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
      const response = await fetchPlayerAsset(asset.url, controller.signal);
      if (!response.ok)
        throw new Error("This exhibition media is unavailable or your access changed");
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== asset.sha256.toLowerCase())
        throw new Error("This exhibition media could not be verified");
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
  useEffect(() => {
    const node = media.current;
    if (!standVideo || !url || !(node instanceof HTMLVideoElement)) return;
    if (!node.closest("[hidden]")) playStandVideo(node);
    return () => cancelStandPlaybackAttempt(node);
  }, [standVideo, url, visit]);
  if (error) return <p role="alert">{error}</p>;
  if (component.type === "image")
    return url ? <img src={url} alt={component.alt} /> : <p role="status">Loading image…</p>;
  // Native Play also unlocks the scene's spatial graph before the media becomes audible
  const common = {
    onPlay: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      const node = event.currentTarget;
      if (
        !(node instanceof HTMLVideoElement && node.muted) &&
        (!standVideo || navigator.userActivation?.isActive)
      )
        node.dispatchEvent(new CustomEvent("exhibit-start", { bubbles: true }));
    },
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
      loop={standVideo || component.loop}
      preload={standVideo ? "auto" : undefined}
      data-stand-video={standVideo || undefined}
      onPause={(event) => {
        if (standVideo && event.currentTarget.paused && !document.hidden)
          cancelStandPlaybackAttempt(event.currentTarget);
      }}
      aria-label={component.caption || "Exhibition video"}
      playsInline
    />
  );
}

export function ExhibitionContent({
  visit,
  scene,
  assets,
  navigate,
  playbackReady,
}: {
  visit: number;
  scene: VisitorScene;
  assets: readonly CatalogueAsset[];
  navigate: (sceneId: string, viewpointId: string) => void;
  playbackReady: boolean;
}) {
  const hotspots = "hotspots" in scene ? scene.hotspots : [];
  const components = (object: VisitorScene["objects"][number]): readonly ContentComponent[] =>
    "components" in object ? (object.components as readonly ContentComponent[]) : [];
  const section = useRef<HTMLElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [modalItem, setModalItem] = useState<DisplayComponent | null>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (modalItem) {
      if (document.pointerLockElement) document.exitPointerLock();
      if (!node.open) node.showModal();
    } else if (node.open) node.close();
    node.dispatchEvent(
      new CustomEvent("exhibit-modal", { detail: Boolean(modalItem), bubbles: true }),
    );
  }, [modalItem]);
  useEffect(() => {
    setModalItem(null);
    const content = section.current;
    const open = () => {
      if (details.current) details.current.open = true;
      if (document.pointerLockElement) document.exitPointerLock();
    };
    const inspect = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const object = scene.objects.find((item) => item.id === id);
      if (!object || !("components" in object) || !Array.isArray(object.components)) return;
      const asset = assets.find((entry) => entry.id === object.assetId);
      if (asset?.displayRole === "digital" || asset?.displaySurface) {
        const item = object.components.find(
          (entry): entry is DisplayComponent =>
            entry.type === "text" || entry.type === "image" || entry.type === "video",
        );
        if (item) {
          setModalItem(item);
          return;
        }
      }
      if (object.components.length) open();
    };
    content?.addEventListener("exhibit-inspect", inspect);
    content?.addEventListener("exhibit-show-panel", open);
    return () => {
      content?.removeEventListener("exhibit-inspect", inspect);
      content?.removeEventListener("exhibit-show-panel", open);
    };
  }, [scene, assets]);
  const activate = (id: string) =>
    section.current?.dispatchEvent(new CustomEvent("exhibit-activate", { detail: id }));
  // Keep literal text and native media controls accessible beside the 3D view
  // Panel events stay scoped to this scene so old timers cannot operate on new content
  function component(item: ContentComponent, ownerId?: string, standVideo = false) {
    if (item.type === "hotspot")
      return (
        <button
          key={item.id}
          disabled={!playbackReady}
          onClick={() => ownerId && activate(ownerId)}
        >
          {item.label || "Activate exhibit"}
        </button>
      );
    if (item.type === "navigationPoint")
      return (
        <button
          key={item.id}
          disabled={!playbackReady}
          onClick={() => {
            const action = new CustomEvent("exhibit-navigation-point", {
              detail: item.id,
              cancelable: true,
            });
            if (section.current?.dispatchEvent(action)) navigate(item.sceneId, item.viewpointId);
          }}
        >
          {item.label}
        </button>
      );
    return (
      <figure key={item.id} data-component-id={item.id}>
        {item.type === "text" ? (
          <Text component={item} />
        ) : (
          <Media
            key={item.assetId}
            component={item}
            standVideo={standVideo}
            visit={standVideo ? visit : 0}
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
    <>
      <details className={`visitor-information${modalItem ? " is-hidden" : ""}`} ref={details}>
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
                ) && (
                  <button disabled={!playbackReady} onClick={() => activate(object.id)}>
                    Activate {object.name}
                  </button>
                )}
                {components(object).map((item) =>
                  component(
                    item,
                    object.id,
                    item.type === "video" &&
                      assets.some((asset) => asset.id === object.assetId && !!asset.displaySurface),
                  ),
                )}
              </article>
            ))}
        </section>
      </details>
      <dialog
        ref={dialog}
        className="visitor-media-dialog"
        aria-label="Exhibit media"
        onClose={() => setModalItem(null)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          ) {
            event.currentTarget.close();
          }
        }}
      >
        {modalItem && (
          <>
            {modalItem.type === "text" ? (
              <Text component={modalItem} />
            ) : modalItem.type === "image" || modalItem.type === "video" ? (
              <Media
                key={modalItem.assetId}
                component={modalItem}
                assets={assets}
                standVideo={false}
                visit={0}
              />
            ) : null}
            {modalItem.caption && (
              <p className="visitor-media-dialog-caption">{modalItem.caption}</p>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
