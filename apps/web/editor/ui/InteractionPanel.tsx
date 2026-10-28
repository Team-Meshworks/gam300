import type { SceneObject } from "../../shared/project/scene-object";
import type { ProjectHotspot } from "../../shared/project/project-types";
import { ACTIONS, type ActionType } from "../interaction/actionHandler";
import { AUDIO_TRACKS } from "../interaction/audio";
import type { Interaction } from "../interaction/interactionHandler";
import { DEFAULT_ELAPSED_SECONDS, TRIGGERS, type TriggerType } from "../interaction/triggerHandler";
import { Icon } from "./Icon";

type Choice = { value: string; label: string };

const triggerChoices: Choice[] = TRIGGERS.map(({ type, label }) => ({ value: type, label }));
const actionChoices: Choice[] = ACTIONS.map(({ type, label }) => ({ value: type, label }));
const secondChoices: Choice[] = [2, 5, 10, 15].map((seconds) => ({
  value: String(seconds),
  label: `${seconds} seconds`,
}));
const audioChoices: Choice[] = AUDIO_TRACKS.map(({ label, url }) => ({ value: url, label }));

function hotspotChoices(
  hotspots: readonly ProjectHotspot[],
  objects: readonly Pick<SceneObject, "id" | "name">[],
): Choice[] {
  const names = new Map(objects.map((object) => [object.id, object.name]));
  const counts = new Map<string, number>();
  return hotspots.map((hotspot) => {
    const count = (counts.get(hotspot.objectId) ?? 0) + 1;
    counts.set(hotspot.objectId, count);
    return {
      value: hotspot.id,
      label: `${names.get(hotspot.objectId) ?? "Object"} hotspot ${count}`,
    };
  });
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

function withActionType(interaction: Interaction, type: ActionType): Interaction {
  switch (type) {
    case "open-link": {
      const url = interaction.do.type === "open-link" ? (interaction.do.url ?? "") : "";
      return { ...interaction, do: { type, url } };
    }
    case "play-audio": {
      const url =
        interaction.do.type === "play-audio"
          ? (interaction.do.url ?? "")
          : (AUDIO_TRACKS[0]?.url ?? "");
      return { ...interaction, do: { type, url } };
    }
    case "print-hi":
      return { ...interaction, do: { type } };
  }
}

export function InteractionPanel({
  interactions,
  hotspots,
  objects,
  onChange,
}: {
  interactions: readonly Interaction[];
  hotspots: readonly ProjectHotspot[];
  objects: readonly SceneObject[];
  onChange: (next: Interaction[]) => void;
}) {
  const targets = hotspotChoices(hotspots, objects);

  function update(index: number, next: Interaction) {
    onChange(interactions.map((rule, at) => (at === index ? next : rule)));
  }

  return (
    <section className="editor-panel" aria-labelledby="interaction-heading">
      <h2 id="interaction-heading">
        <Icon name="info" />
        Interactions
      </h2>
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
                        update(index, withTriggerType(interaction, value as TriggerType, hotspots))
                      }
                    />
                    {interaction.when.type === "visitor-clicks-hotspot" && (
                      <Dropdown
                        label={`${name} hotspot`}
                        value={interaction.when.targetHotspotId}
                        choices={targets}
                        emptyLabel="Attach a hotspot first"
                        onChange={(value) => update(index, withTriggerTarget(interaction, value))}
                        target
                      />
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
                      choices={actionChoices}
                      onChange={(value) =>
                        update(index, withActionType(interaction, value as ActionType))
                      }
                    />
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
                        value={interaction.do.url ?? ""}
                        choices={audioChoices}
                        emptyLabel="No audio in public/audio"
                        onChange={(value) =>
                          update(index, { ...interaction, do: { type: "play-audio", url: value } })
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
      {hotspots.length === 0 && (
        <p className="panel-empty">
          Select an object and add a hotspot to create a click interaction.
        </p>
      )}
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
  emptyLabel = "None in scene yet",
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  onChange: (value: string) => void;
  target?: boolean;
  emptyLabel?: string;
}) {
  const empty = choices.length === 0;
  const known = choices.some((choice) => choice.value === value);
  return (
    <span className={`interaction-select${target ? " is-target" : ""}`}>
      <select
        aria-label={label}
        value={empty || !known ? "" : value}
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
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
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
