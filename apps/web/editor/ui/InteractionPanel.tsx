import type { SceneObject } from "../../shared/project/scene-object";
import type { ProjectHotspot, ProjectScene } from "../../shared/project/project-types";
import { ACTIONS, type ActionType } from "../interaction/actionHandler";
import { AUDIO_TRACKS } from "../interaction/audio";
import type { Interaction } from "../interaction/interactionHandler";
import { DEFAULT_ELAPSED_SECONDS, TRIGGERS, type TriggerType } from "../interaction/triggerHandler";
import { Icon } from "./Icon";

type Choice = { value: string; label: string; disabled?: boolean };

const triggerChoices: Choice[] = TRIGGERS.map(({ type, label }) => ({ value: type, label }));
const actionChoices: Choice[] = ACTIONS.map(({ type, label }) => ({ value: type, label }));
const secondChoices: Choice[] = [2, 5, 10, 15].map((seconds) => ({
  value: String(seconds),
  label: `${seconds} seconds`,
}));
const audioChoices: Choice[] = AUDIO_TRACKS.map(({ label, url }) => ({ value: url, label }));

function hotspotChoices(
  hotspots: readonly ProjectHotspot[],
  objects: readonly Pick<SceneObject, "id" | "name" | "assetId">[],
): Choice[] {
  // Display old generated names consistently with the tree without rewriting authored names
  const names = new Map(
    objects.map((object) => {
      const name =
        object.assetId === "test-crate-v1"
          ? object.name.replace(
              /^test-crate([ -]\d+)?$/,
              (_, suffix) => `Sample crate${suffix?.replace("-", " ") ?? ""}`,
            )
          : object.assetId === "test-room-module-v1"
            ? object.name.replace(
                /^test-room([ -]\d+)?$/,
                (_, suffix) => `Starter room${suffix?.replace("-", " ") ?? ""}`,
              )
            : object.name;
      return [object.id.toLowerCase(), name];
    }),
  );
  return hotspots.map((hotspot) => ({
    value: hotspot.id,
    label: names.get(hotspot.objectId.toLowerCase()) ?? "Object",
  }));
}

function firstHotspotId(hotspots: readonly ProjectHotspot[]): string {
  return hotspots[0]?.id ?? "";
}

function newInteraction(hotspots: readonly ProjectHotspot[]): Interaction {
  return hotspots.length === 0
    ? { when: { type: "scene-starts" }, do: { type: "print-hi" } }
    : {
        when: { type: "visitor-clicks-hotspot", targetHotspotId: firstHotspotId(hotspots) },
        do: { type: "print-hi" },
      };
}

function withTriggerType(
  interaction: Interaction,
  type: TriggerType,
  hotspots: readonly ProjectHotspot[],
): Interaction {
  switch (type) {
    case "visitor-clicks-hotspot": {
      const targetHotspotId =
        interaction.when.type === "visitor-clicks-hotspot"
          ? interaction.when.targetHotspotId
          : firstHotspotId(hotspots);
      return { ...interaction, when: { type, targetHotspotId } };
    }
    case "scene-starts":
      return { ...interaction, when: { type } };
    case "time-elapsed": {
      const seconds =
        interaction.when.type === "time-elapsed" ? interaction.when.seconds : undefined;
      return {
        ...interaction,
        when: { type, seconds: seconds ?? DEFAULT_ELAPSED_SECONDS },
      };
    }
  }
}

function withTriggerTarget(interaction: Interaction, targetHotspotId: string): Interaction {
  return { ...interaction, when: { type: "visitor-clicks-hotspot", targetHotspotId } };
}

function withActionType(
  interaction: Interaction,
  type: ActionType,
  scenes: readonly ProjectScene[],
  activeSceneId: string | null,
  audioTargets: readonly Choice[],
): Interaction {
  const scene = scenes.find((entry) => entry.id === activeSceneId);
  switch (type) {
    case "open-link": {
      const url = interaction.do.type === "open-link" ? (interaction.do.url ?? "") : "";
      return { ...interaction, do: { type, url } };
    }
    case "play-audio": {
      if (audioTargets.length) {
        const mediaId = interaction.do.type === "play-audio" ? interaction.do.mediaId : undefined;
        return { ...interaction, do: { type, mediaId: mediaId ?? audioTargets[0]!.value } };
      }
      const url =
        interaction.do.type === "play-audio"
          ? (interaction.do.url ?? "")
          : (AUDIO_TRACKS[0]?.url ?? "");
      return { ...interaction, do: { type, url } };
    }
    case "navigate-scene": {
      const destination = scenes.find((entry) => entry.id !== activeSceneId);
      return destination ? { ...interaction, do: { type, sceneId: destination.id } } : interaction;
    }
    case "move-to-viewpoint": {
      const view = scene?.viewpoints?.[0];
      return view ? { ...interaction, do: { type, viewpointId: view.id } } : interaction;
    }
    case "print-hi":
      return { ...interaction, do: { type } };
  }
}

export function InteractionPanel({
  interactions,
  hotspots,
  objects,
  scenes = [],
  activeSceneId = null,
  audioTargets = [],
  selectedObjectId,
  onHotspotRemove,
  onChange,
  onLocate,
}: {
  interactions: readonly Interaction[];
  hotspots: readonly ProjectHotspot[];
  objects: readonly SceneObject[];
  scenes?: readonly ProjectScene[];
  activeSceneId?: string | null;
  audioTargets?: readonly Choice[];
  selectedObjectId?: string | undefined;
  onHotspotRemove?: ((id: string) => void) | undefined;
  onChange: (next: Interaction[]) => void;
  onLocate: (objectId: string) => void;
}) {
  // Only the selected exhibit exposes removal; the store preserves it and removes linked rules atomically
  const selectedHotspot = hotspots.find(
    (hotspot) => hotspot.objectId.toLowerCase() === selectedObjectId?.toLowerCase(),
  );
  const selectedObject = objects.find((object) => object.id === selectedObjectId);
  const targets = hotspotChoices(hotspots, objects);
  const sceneTargets = scenes.map((scene, index) => ({
    value: scene.id,
    label: `${index + 1}. ${scene.name}`,
    disabled: scene.id === activeSceneId,
  }));
  const views = scenes.find((scene) => scene.id === activeSceneId)?.viewpoints ?? [];
  const viewTargets = views.map((view, index) => ({
    value: view.id,
    label: `${index + 1}. ${view.name}`,
  }));
  const availableActions = actionChoices.map((choice) => ({
    ...choice,
    disabled:
      (choice.value === "play-audio" && audioTargets.length === 0) ||
      (choice.value === "navigate-scene" && scenes.length < 2) ||
      (choice.value === "move-to-viewpoint" && views.length === 0),
  }));

  function update(index: number, next: Interaction) {
    onChange(interactions.map((rule, at) => (at === index ? next : rule)));
  }

  return (
    <section className="editor-panel interaction-panel" aria-labelledby="interaction-heading">
      <header className="interaction-heading">
        <h2 id="interaction-heading">
          <Icon name="info" />
          Interactions
        </h2>
        {selectedHotspot && onHotspotRemove && (
          <button
            type="button"
            className="ui-button interaction-remove"
            aria-label={`Remove hotspot from ${selectedObject?.name ?? "selected object"}`}
            onClick={() => onHotspotRemove(selectedHotspot.id)}
          >
            Remove hotspot
          </button>
        )}
      </header>
      <div className={`interaction-content${interactions.length === 0 ? " is-empty" : ""}`}>
        {interactions.length === 0 ? (
          <div className="panel-placeholder">
            <span className="panel-placeholder-icon" aria-hidden="true">
              <Icon name="touch" />
            </span>
            <p>
              <strong>No interactions yet</strong>
            </p>
            <p className="panel-empty">
              Add one to choose what happens when visitors click a hotspot, walk in or look around.
            </p>
          </div>
        ) : (
          <ol className="interaction-list" role="list">
            {interactions.map((interaction, index) => {
              const name = `Interaction ${index + 1}`;
              const trigger = interaction.when;
              const target =
                trigger.type === "visitor-clicks-hotspot"
                  ? hotspots.find(
                      (hotspot) =>
                        hotspot.id.toLowerCase() === trigger.targetHotspotId.toLowerCase(),
                    )
                  : undefined;
              return (
                <li key={index} className="interaction-card" aria-label={name}>
                  <div className="interaction-card-head">
                    <span>{name}</span>
                    {/* Reordering not done yet, the handle is only for the look now */}
                    <span className="interaction-handle" aria-hidden="true">
                      <Icon name="dragHandle" />
                    </span>
                    <button
                      className="ui-button interaction-delete"
                      type="button"
                      aria-label={`Delete ${name}`}
                      title="Delete"
                      onClick={() => onChange(interactions.filter((_, at) => at !== index))}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                  <div className="interaction-rule">
                    <div className="interaction-half">
                      <span className="interaction-label">When</span>
                      <Dropdown
                        label={`${name} when`}
                        value={interaction.when.type}
                        choices={triggerChoices}
                        onChange={(value) =>
                          update(
                            index,
                            withTriggerType(interaction, value as TriggerType, hotspots),
                          )
                        }
                      />
                      {interaction.when.type === "visitor-clicks-hotspot" && (
                        <Dropdown
                          label={`${name} hotspot`}
                          value={interaction.when.targetHotspotId}
                          choices={targets}
                          entityId
                          emptyLabel="Attach a hotspot first"
                          onChange={(value) => update(index, withTriggerTarget(interaction, value))}
                          target
                        />
                      )}
                      {target && (
                        <button
                          className="ui-button panel-pill"
                          type="button"
                          aria-label={`Locate ${name} target`}
                          onClick={() => onLocate(target.objectId)}
                        >
                          Locate
                        </button>
                      )}
                      {interaction.when.type === "time-elapsed" && (
                        <Dropdown
                          label={`${name} after`}
                          value={String(interaction.when.seconds ?? DEFAULT_ELAPSED_SECONDS)}
                          choices={secondChoices}
                          onChange={(value) =>
                            update(index, {
                              ...interaction,
                              when: { type: "time-elapsed", seconds: Number(value) },
                            })
                          }
                          target
                        />
                      )}
                    </div>
                    <div className="interaction-half">
                      <span className="interaction-label">Do</span>
                      <Dropdown
                        label={`${name} do`}
                        value={interaction.do.type}
                        choices={availableActions}
                        onChange={(value) =>
                          update(
                            index,
                            withActionType(
                              interaction,
                              value as ActionType,
                              scenes,
                              activeSceneId,
                              audioTargets,
                            ),
                          )
                        }
                      />
                      {interaction.do.type === "navigate-scene" && (
                        <Dropdown
                          label={`${name} destination scene`}
                          value={interaction.do.sceneId}
                          choices={sceneTargets}
                          entityId
                          target
                          onChange={(sceneId) =>
                            update(index, {
                              ...interaction,
                              do: { type: "navigate-scene", sceneId },
                            })
                          }
                        />
                      )}
                      {interaction.do.type === "move-to-viewpoint" && (
                        <Dropdown
                          label={`${name} destination viewpoint`}
                          value={interaction.do.viewpointId}
                          choices={viewTargets}
                          entityId
                          target
                          emptyLabel="Capture a saved view first"
                          onChange={(viewpointId) =>
                            update(index, {
                              ...interaction,
                              do: { type: "move-to-viewpoint", viewpointId },
                            })
                          }
                        />
                      )}
                      {interaction.do.type === "open-link" && (
                        <UrlField
                          label={`${name} link`}
                          value={interaction.do.url ?? ""}
                          onChange={(value) =>
                            update(index, { ...interaction, do: { type: "open-link", url: value } })
                          }
                        />
                      )}
                      {interaction.do.type === "play-audio" && (
                        <Dropdown
                          label={`${name} audio`}
                          value={interaction.do.mediaId ?? interaction.do.url ?? ""}
                          choices={audioTargets.length ? audioTargets : audioChoices}
                          emptyLabel="No audio in public/audio"
                          onChange={(value) =>
                            update(index, {
                              ...interaction,
                              do: audioTargets.length
                                ? { type: "play-audio", mediaId: value }
                                : { type: "play-audio", url: value },
                            })
                          }
                          target
                        />
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <button
          className="ui-button panel-pill interaction-add"
          type="button"
          onClick={() => onChange([...interactions, newInteraction(hotspots)])}
        >
          + Add Interaction
        </button>
      </div>
      <div className="interaction-help">
        {(scenes.length < 2 || views.length === 0) && (
          <p className="panel-empty">
            {scenes.length < 2 && "Add another scene to enable Go to scene. "}
            {views.length === 0 &&
              "Capture a saved view in this scene to enable Go to saved viewpoint."}
          </p>
        )}
        {hotspots.length === 0 && (
          <p className="panel-empty">
            Select an object and add a hotspot to create a click interaction.
          </p>
        )}
      </div>
    </section>
  );
}

// Plain select so keyboard and screen readers just work, styled as the pill in Figma
function Dropdown({
  label,
  value,
  choices,
  onChange,
  target = false,
  entityId = false,
  emptyLabel = "None in scene yet",
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  onChange: (value: string) => void;
  target?: boolean;
  entityId?: boolean;
  emptyLabel?: string;
}) {
  const empty = choices.length === 0;
  const selected = choices.find((choice) =>
    entityId ? choice.value.toLowerCase() === value.toLowerCase() : choice.value === value,
  );
  const known = selected !== undefined;
  return (
    <span className={`interaction-select${target ? " is-target" : ""}`}>
      <select
        aria-label={label}
        value={selected?.value ?? ""}
        disabled={empty}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {empty && <option value="">{emptyLabel}</option>}
        {!empty && !known && (
          <option value="" disabled>
            Pick one
          </option>
        )}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value} disabled={choice.disabled}>
            {choice.label}
          </option>
        ))}
      </select>
      <span className="interaction-selected-label" aria-hidden="true">
        {selected?.label ?? (empty ? emptyLabel : "Pick one")}
      </span>
      <Icon name="caretSolid" />
    </span>
  );
}

function UrlField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      className="interaction-input"
      type="url"
      aria-label={label}
      placeholder="https://"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}
