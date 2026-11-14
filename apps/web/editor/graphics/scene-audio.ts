import * as THREE from "three";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import type { ContentObject } from "../../shared/project/project-content";
import type { SceneObject } from "../../shared/project/scene-object";

// Spatial tracks borrow their owner's live transform and stay silent outside Preview
export function createSceneAudio(
  camera: THREE.Camera,
  assets: readonly CatalogueAsset[],
  reportError: (message: string) => void,
) {
  let listener: THREE.AudioListener | undefined;
  let controller = new AbortController();
  let preview = false;
  let visible = true;
  let objects: readonly SceneObject[] = [];
  let instances: ReadonlyMap<string, THREE.Object3D> = new Map();
  const buffers = new Map<string, Promise<AudioBuffer>>();
  const tracks = new Map<string, { sound: THREE.PositionalAudio; key: string; paused: boolean }>();

  function release(sound: THREE.PositionalAudio) {
    if (sound.isPlaying) {
      sound.stop();
    }
    if (sound.source) {
      sound.disconnect();
    }
    sound.panner.disconnect();
    sound.gain.disconnect();
    sound.removeFromParent();
  }
  function clear() {
    controller.abort();
    controller = new AbortController();
    for (const { sound } of tracks.values()) {
      release(sound);
    }
    tracks.clear();
    buffers.clear();
  }
  function sync() {
    if (!preview || !listener) {
      return;
    }
    const current = new Set<string>();
    for (const object of objects) {
      const owner = instances.get(object.id);
      if (!owner || (object as Partial<ContentObject>).visible === false) {
        continue;
      }
      for (const component of (object as Partial<ContentObject>).components ?? []) {
        if (component.type !== "audio" || component.mode !== "spatial") {
          continue;
        }
        const asset = assets.find(
          (asset) => asset.id === component.assetId && asset.kind === "audio",
        );
        if (!asset) {
          continue;
        }
        current.add(component.id);
        const key = JSON.stringify([asset.id, asset.url, component.loop, component.volume]);
        const previous = tracks.get(component.id);
        if (previous?.key === key) {
          owner.add(previous.sound);
          continue;
        }
        if (previous) {
          release(previous.sound);
        }
        const sound = new THREE.PositionalAudio(listener);
        sound.setRefDistance(3).setMaxDistance(25).setRolloffFactor(1);
        sound.setLoop(component.loop);
        sound.setVolume(component.volume);
        owner.add(sound);
        const track = { sound, key, paused: false };
        tracks.set(component.id, track);

        // Share decoded bytes within this preview, then discard them when it ends
        // A late response from a removed or replaced track must never start playback
        const signal = controller.signal;
        let buffer = buffers.get(asset.url);
        if (!buffer) {
          const context = listener.context;
          buffer = fetch(asset.url, { credentials: "same-origin", signal })
            .then((response) => {
              if (!response.ok) {
                throw new Error("Audio request failed");
              }
              return response.arrayBuffer();
            })
            .then((bytes) => context.decodeAudioData(bytes));
          buffers.set(asset.url, buffer);
        }
        void buffer
          .then((decoded) => {
            if (signal.aborted || tracks.get(component.id)?.sound !== sound) {
              return;
            }
            sound.setBuffer(decoded);
            if (visible) {
              sound.play();
            } else {
              track.paused = true;
            }
          })
          .catch(() => {
            if (!signal.aborted && tracks.get(component.id)?.sound === sound) {
              reportError(`Could not play ${asset.name}; exit Preview and try again`);
            }
          });
      }
    }
    for (const [id, { sound }] of tracks) {
      if (!current.has(id)) {
        release(sound);
        tracks.delete(id);
      }
    }
  }
  return {
    sync(nextObjects: readonly SceneObject[], nextInstances: ReadonlyMap<string, THREE.Object3D>) {
      objects = nextObjects;
      instances = nextInstances;
      sync();
    },
    play(id: string) {
      const track = [...tracks].find(([key]) => key.toLowerCase() === id.toLowerCase())?.[1];
      if (preview && visible && track?.sound.buffer && !track.sound.isPlaying) {
        track.sound.play();
      }
    },
    setPreview(active: boolean) {
      if (active === preview) {
        return;
      }
      preview = active;
      if (!active) {
        clear();
        return;
      }
      // Entering Preview is a user gesture, allowing the browser to unlock Web Audio
      listener ??= new THREE.AudioListener();
      camera.add(listener);
      void listener.context
        .resume()
        .catch(() => reportError("Allow audio playback and retry Preview"));
      sync();
    },
    setVisible(active: boolean) {
      visible = active;
      if (active && preview) {
        void listener?.context
          .resume()
          .catch(() => reportError("Allow audio playback and retry Preview"));
      }
      for (const track of tracks.values()) {
        if (!active && track.sound.isPlaying) {
          track.paused = true;
          track.sound.pause();
        } else if (active && track.paused && track.sound.buffer) {
          track.paused = false;
          track.sound.play();
        }
      }
    },
    dispose() {
      preview = false;
      clear();
      listener?.removeFromParent();
      listener?.gain.disconnect();
    },
  };
}
