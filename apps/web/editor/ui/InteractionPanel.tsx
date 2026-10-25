import type { SceneObject } from "../../shared/project/scene-object";
import { Icon } from "./Icon";
import {
  actionKind,
  actions,
  newInteraction,
  targetChoices,
  triggerKind,
  triggers,
  withAction,
  withTrigger,
  type ActionId,
  type Choice,
  type InteractionRule,
  type TriggerId,
} from "./interaction-options";

const triggerChoices: Choice[] = triggers.map(({ id, label }) => ({ value: id, label }));
const actionChoices: Choice[] = actions.map(({ id, label }) => ({ value: id, label }));

export function InteractionPanel({
  interactions,
  objects,
  onChange,
}: {
  interactions: readonly InteractionRule[];
  objects: readonly SceneObject[];
  onChange: (next: InteractionRule[]) => void;
}) {
  function update(next: InteractionRule) {
    onChange(interactions.map((rule) => (rule.id === next.id ? next : rule)));
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
            Add one to choose what happens when visitors click, walk in or look around.
          </p>
        </div>
      ) : (
        <ol className="interaction-list" role="list">
          {interactions.map((rule, index) => {
            const name = `Interaction ${index + 1}`;
            const actionTarget = actionKind(rule.action);
            return (
              <li key={rule.id} className="interaction-card" aria-label={name}>
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
                    onClick={() => onChange(interactions.filter((other) => other.id !== rule.id))}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
                <div className="interaction-rule">
                  <div className="interaction-half">
                    <span className="interaction-label">When</span>
                    <Dropdown
                      label={`${name} when`}
                      value={rule.trigger}
                      choices={triggerChoices}
                      onChange={(value) => update(withTrigger(rule, value as TriggerId, objects))}
                    />
                    <Dropdown
                      label={`${name} when target`}
                      value={rule.triggerTarget}
                      choices={targetChoices(triggerKind(rule.trigger), objects)}
                      onChange={(value) => update({ ...rule, triggerTarget: value })}
                      target
                    />
                  </div>
                  <div className="interaction-half">
                    <span className="interaction-label">Do</span>
                    <Dropdown
                      label={`${name} do`}
                      value={rule.action}
                      choices={actionChoices}
                      onChange={(value) => update(withAction(rule, value as ActionId, objects))}
                    />
                    {actionTarget !== null && (
                      <Dropdown
                        label={`${name} do target`}
                        value={rule.actionTarget}
                        choices={targetChoices(actionTarget, objects)}
                        onChange={(value) => update({ ...rule, actionTarget: value })}
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
        onClick={() => onChange([...interactions, newInteraction(crypto.randomUUID(), objects)])}
      >
        + Add Interaction
      </button>
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
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  onChange: (value: string) => void;
  target?: boolean;
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
        {empty && <option value="">None in scene yet</option>}
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
