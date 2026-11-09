import * as THREE from "three";
import type { ProjectAction, ProjectRule } from "../shared/project/project-content";
import type { InteractionAction } from "../shared/project/project-types";
import type { PublishedExhibition } from "./publication";
import { isPortableHttpsUrl } from "../shared/project/portable-url";

export type VisitorScene = PublishedExhibition["document"]["scenes"][number];

// Web Audio allows only one source per element, including after a saved-view change
const audioSources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

// Playback owns only runtime state; no action writes to the published document
export function createVisitorPlayback(
  source: VisitorScene,
  camera: THREE.PerspectiveCamera,
  controls: { target: THREE.Vector3; update(): void },
  roots: Map<string, THREE.Object3D>,
  content: HTMLElement,
  navigate: (sceneId: string, viewpointId: string) => void,
  report: (message: string) => void,
) {
  // Keep timing, zone entry and camera movement scoped to this visit rather than the saved rules
  let started = false,
    departing = false,
    disposed = false,
    elapsed = 0;
  let listener: THREE.AudioListener | undefined;
  const sounds: THREE.PositionalAudio[] = [];
  const pendingMedia = new Set<string>();
  const timers = new Set<string>();
  const inside = new Set<string>();
  const gaze = new Map<string, number>();
  const hotspots = "hotspots" in source ? source.hotspots : [];
  const interactions = "interactions" in source ? source.interactions : [];
  const rules = "rules" in source ? source.rules.filter((rule) => rule.enabled) : [];
  let movement:
    | {
        from: THREE.Vector3;
        rotation: THREE.Quaternion;
        to: THREE.Vector3;
        turn: THREE.Quaternion;
        elapsed: number;
        seconds: number;
        fov: number;
      }
    | undefined;
  const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const element = (id: string) =>
    [...content.querySelectorAll<HTMLElement>("[data-component-id]")].find((node) =>
      equal(node.dataset.componentId ?? "", id),
    );
  const root = (id: string) => [...roots].find(([key]) => equal(key, id))?.[1];

  // Repeated Play actions resume the same track; hiding its owner must keep it silent
  function media(id: string) {
    const node = element(id)?.querySelector<HTMLMediaElement>("audio,video");
    if (!node || node.closest("[hidden]")) {
      pendingMedia.delete(id.toLowerCase());
      return;
    }
    // A verified media download may finish after Start or a scene-start rule
    // Resume the requested track when it becomes playable, unless its owner has since hidden
    if (node.readyState < 2 || document.hidden) {
      pendingMedia.add(id.toLowerCase());
      return;
    }
    pendingMedia.delete(id.toLowerCase());
    if (node.ended) {
      node.currentTime = 0;
    }
    if (node.paused) {
      void node.play().catch(() => {
        if (disposed || departing) return;
        pendingMedia.add(id.toLowerCase());
        report("Select Enable audio to allow playback");
      });
    }
  }
  const mediaReady = (event: Event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-component-id]")?.dataset
      .componentId;
    if (id && pendingMedia.has(id.toLowerCase()) && !disposed && !departing) {
      media(id);
    }
  };

  // Capture the current camera once so each frame interpolates from a stable starting pose
  function view(id: string, seconds = 0) {
    const pose = source.viewpoints?.find((item) => equal(item.id, id))?.camera;
    if (!pose) return;
    movement = {
      from: camera.position.clone(),
      rotation: camera.quaternion.clone(),
      to: new THREE.Vector3(...pose.position),
      turn: new THREE.Quaternion(...pose.rotation),
      elapsed: 0,
      seconds,
      fov: pose.fovDegrees,
    };
  }
  // Keep authored links on the same portable HTTPS boundary used by both project readers
  function link(url: string | undefined) {
    if (!url || !isPortableHttpsUrl(url)) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.click();
  }
  // Older WHEN/DO rows share the same effect handlers as the versioned rule vocabulary
  function legacy(action: InteractionAction) {
    switch (action.type) {
      case "open-link":
        link(action.url);
        break;
      case "play-audio":
        if (action.mediaId) media(action.mediaId);
        break;
      case "print-hi":
        window.alert("hi");
        break;
      case "move-to-viewpoint":
        view(action.viewpointId);
        break;
      case "navigate-scene":
        departing = true;
        navigate(action.sceneId, "");
        break;
    }
  }
  // Execute in authored order and stop the old scene immediately after navigation
  function execute(actions: readonly ProjectAction[]) {
    for (const action of actions) {
      if (departing || disposed) break;
      switch (action.type) {
        case "openLink":
          link(action.url);
          break;
        case "playMedia":
          media(action.mediaId);
          break;
        case "showPanel": {
          const panel = element(action.panelId);
          if (panel) {
            panel.hidden = false;
            content.dispatchEvent(new CustomEvent("exhibit-show-panel"));
            panel.scrollIntoView({ block: "nearest" });
          }
          break;
        }
        case "setVisible": {
          const object = root(action.objectId);
          if (object) object.visible = action.visible;
          const article = [...content.querySelectorAll<HTMLElement>("[data-owner-id]")].find(
            (node) => equal(node.dataset.ownerId ?? "", action.objectId),
          );
          if (article) {
            article.hidden = !action.visible;
            if (!action.visible)
              article
                .querySelectorAll<HTMLMediaElement>("audio,video")
                .forEach((node) => node.pause());
          }
          break;
        }
        case "moveCamera":
          view(action.viewpointId, action.durationSeconds);
          break;
        case "navigateScene":
          departing = true;
          navigate(action.sceneId, action.viewpointId);
          break;
      }
    }
  }
  // Disabled rules were excluded at startup; runtime dispatch never edits their saved state
  function run(matches: (rule: ProjectRule) => boolean) {
    for (const rule of rules) {
      if (departing || disposed) break;
      if (matches(rule)) execute(rule.actions);
    }
  }
  function start() {
    if (disposed) return;
    // A user gesture unlocks browser audio; tracks keep their own play/pause controls
    if (!listener) {
      listener = new THREE.AudioListener();
      camera.add(listener);
      content.querySelectorAll<HTMLAudioElement>("audio[data-spatial-owner]").forEach((node) => {
        const owner = root(node.dataset.spatialOwner ?? "");
        if (!owner) return;
        const sound = new THREE.PositionalAudio(listener!);
        let audioSource = audioSources.get(node);
        if (!audioSource) {
          audioSource = listener!.context.createMediaElementSource(node);
          audioSources.set(node, audioSource);
        }
        sound.setNodeSource(audioSource);
        sound.setRefDistance(3).setMaxDistance(25).setRolloffFactor(1);
        owner.add(sound);
        sounds.push(sound);
      });
    }
    void listener.context.resume().catch(() => report("Select Enable audio to allow playback"));
    begin();
    for (const id of pendingMedia) media(id);
  }
  // Enter the published scene immediately; audio permissions still need a user gesture
  function begin() {
    if (disposed || departing) return;
    // Initial BGM starts once; later object clicks respect tracks the visitor paused manually
    if (started) return;
    started = true;
    content.querySelectorAll<HTMLMediaElement>("audio[data-background]").forEach((node) => {
      const id = node.closest<HTMLElement>("[data-component-id]")?.dataset.componentId;
      if (id) {
        media(id);
      }
    });
    for (const interaction of interactions) {
      if (departing) break;
      if (interaction.when.type === "scene-starts") legacy(interaction.do);
    }
    run((rule) => rule.trigger.type === "sceneStart");
  }
  // A clicked model also activates its attached legacy and component hotspot identities
  function click(objectId: string) {
    if (disposed || departing) {
      return;
    }
    start();
    if (root(objectId)?.visible === false) return;
    const targets = [
      objectId,
      ...hotspots.filter((item) => equal(item.objectId, objectId)).map((item) => item.id),
    ];
    if ("rules" in source)
      targets.push(
        ...(source.objects
          .find((item) => equal(item.id, objectId))
          ?.components.filter((item) => item.type === "hotspot")
          .map((item) => item.id) ?? []),
      );
    for (const interaction of interactions) {
      if (departing) break;
      if (
        interaction.when.type === "visitor-clicks-hotspot" &&
        targets.some((id) =>
          equal(
            id,
            interaction.when.type === "visitor-clicks-hotspot"
              ? interaction.when.targetHotspotId
              : "",
          ),
        )
      )
        legacy(interaction.do);
    }
    run(
      (rule) =>
        rule.trigger.type === "click" &&
        targets.some((id) => equal(id, rule.trigger.type === "click" ? rule.trigger.targetId : "")),
    );
  }
  const activate = (event: Event) => click((event as CustomEvent<string>).detail);
  const closePanel = (event: Event) => {
    start();
    run(
      (rule) =>
        rule.trigger.type === "panelClose" &&
        equal(rule.trigger.panelId, (event as CustomEvent<string>).detail),
    );
  };

  // Resume only media that was playing before backgrounding, including hidden-owner checks
  const visibility = () => {
    if (disposed || departing) return;
    content.querySelectorAll<HTMLMediaElement>("audio,video").forEach((node) => {
      if (document.hidden) {
        node.dataset.wasPlaying = String(!node.paused);
        node.pause();
      } else if (node.dataset.wasPlaying === "true" && !node.closest("[hidden]")) {
        node.dataset.wasPlaying = "false";
        void node.play().catch(() => {
          /* Native controls remain available if automatic resume is denied */
        });
      }
    });
    if (!document.hidden) {
      for (const id of pendingMedia) media(id);
    }
  };
  content.addEventListener("loadeddata", mediaReady, true);
  content.addEventListener("exhibit-start", start);
  content.addEventListener("exhibit-activate", activate);
  content.addEventListener("exhibit-panel-close", closePanel);
  document.addEventListener("visibilitychange", visibility);

  return {
    begin,
    start,
    click,
    update(delta: number, lookingAt?: string) {
      if (!started || disposed || departing || document.hidden) return;
      elapsed += delta;
      // Timed triggers fire once per scene visit; re-entering creates a fresh playback session
      interactions.forEach((interaction, index) => {
        const key = `legacy-${index}`;
        if (
          interaction.when.type === "time-elapsed" &&
          elapsed >= (interaction.when.seconds ?? 2) &&
          !timers.has(key)
        ) {
          timers.add(key);
          if (!departing) legacy(interaction.do);
        }
      });
      run((rule) => {
        const trigger = rule.trigger;
        if (trigger.type === "elapsed" && elapsed >= trigger.seconds && !timers.has(rule.id)) {
          timers.add(rule.id);
          return true;
        }
        // Looking away resets dwell time so brief separate glances cannot accumulate
        if (trigger.type === "gaze") {
          const owner =
            hotspots.find((item) => equal(item.id, trigger.targetId))?.objectId ??
            ("rules" in source
              ? source.objects.find(
                  (item) =>
                    equal(item.id, trigger.targetId) ||
                    item.components.some((component) => equal(component.id, trigger.targetId)),
                )?.id
              : undefined);
          const duration =
            owner && lookingAt && equal(owner, lookingAt) ? (gaze.get(rule.id) ?? 0) + delta : 0;
          gaze.set(rule.id, duration);
          if (!duration) timers.delete(rule.id);
          if (duration >= trigger.seconds && !timers.has(rule.id)) {
            timers.add(rule.id);
            return true;
          }
        }
        // Test the camera in the rotated box's local space and fire only on an entry edge
        if (trigger.type === "zoneEnter" && "zones" in source) {
          const zone = source.zones.find((item) => equal(item.id, trigger.zoneId));
          if (!zone) return false;
          const pose = zone.transform;
          const point = camera.position
            .clone()
            .sub(new THREE.Vector3(...pose.position))
            .applyQuaternion(new THREE.Quaternion(...pose.rotation).invert());
          const contains = [point.x, point.y, point.z].every(
            (value, index) => Math.abs(value) <= pose.scale[index]! / 2,
          );
          const entered = contains && !inside.has(rule.id);
          if (contains) inside.add(rule.id);
          else inside.delete(rule.id);
          return entered;
        }
        return false;
      });
      // Run camera motion after effects so navigation and view actions retain their saved order
      if (movement) {
        movement.elapsed += delta;
        const t = movement.seconds === 0 ? 1 : Math.min(1, movement.elapsed / movement.seconds);
        camera.position.lerpVectors(movement.from, movement.to, t);
        camera.quaternion.slerpQuaternions(movement.rotation, movement.turn, t);
        camera.fov = movement.fov;
        camera.updateProjectionMatrix();
        controls.target
          .copy(camera.position)
          .add(new THREE.Vector3(0, 0, -5).applyQuaternion(camera.quaternion));
        controls.update();
        if (t === 1) movement = undefined;
      }
    },
    dispose() {
      disposed = true;
      // Release subscriptions and audio connections before the canvas or content is replaced
      pendingMedia.clear();
      content.removeEventListener("loadeddata", mediaReady, true);
      content.removeEventListener("exhibit-start", start);
      content.removeEventListener("exhibit-activate", activate);
      content.removeEventListener("exhibit-panel-close", closePanel);
      document.removeEventListener("visibilitychange", visibility);
      content.querySelectorAll<HTMLMediaElement>("audio,video").forEach((node) => node.pause());
      sounds.forEach((sound) => {
        sound.disconnect();
        sound.panner.disconnect();
        sound.gain.disconnect();
        sound.removeFromParent();
      });
      listener?.removeFromParent();
      listener?.gain.disconnect();
    },
  };
}
