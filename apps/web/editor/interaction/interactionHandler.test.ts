import { describe, expect, it, vi } from "vitest";
import type { ProjectHotspot } from "../../shared/project/project-types";
import { createInteractionHandler, type Interaction } from "./interactionHandler";
import { createActionRunner } from "./actionHandler";
import { DEFAULT_ELAPSED_SECONDS } from "./triggerHandler";

const hotspots: readonly ProjectHotspot[] = [
  { id: "crate-hotspot", objectId: "crate", position: [0, 0, 0] },
];

const clickInteraction: Interaction = {
  when: { type: "visitor-clicks-hotspot", targetHotspotId: "crate-hotspot" },
  do: { type: "print-hi" },
};

const sceneStartInteraction: Interaction = {
  when: { type: "scene-starts" },
  do: { type: "print-hi" },
};

const elapsedInteraction: Interaction = {
  when: { type: "time-elapsed" },
  do: { type: "print-hi" },
};

const touchInteraction: Interaction = {
  when: { type: "visitor-touch", targetHotspotId: "crate-hotspot" },
  do: { type: "print-hi" },
};

// Records actions without touching the browser
function recorder(run = vi.fn()) {
  return { run, stop: vi.fn() };
}

describe("interaction handler", () => {
  it("runs the action for a scene start", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler(
      [sceneStartInteraction, clickInteraction],
      hotspots,
      recorder(runAction),
    );

    handler.sceneStarted();

    expect(runAction).toHaveBeenCalledExactlyOnceWith(sceneStartInteraction.do);
  });

  it("continues after an action throws", () => {
    const controller = new AbortController();
    const cancelled = new DOMException("Spatial playback was cancelled", "AbortError");
    controller.abort(cancelled);
    const moved = vi.fn();
    const runner = createActionRunner({ goToScene: () => false, goToViewpoint: moved }, (id) =>
      id === "spatial"
        ? {
            url: "/spatial.m4a",
            loop: false,
            volume: 1,
            play: controller.signal.throwIfAborted.bind(controller.signal),
          }
        : undefined,
    );
    const runAction = vi.spyOn(runner, "run");
    const handler = createInteractionHandler(
      [
        {
          when: sceneStartInteraction.when,
          do: { type: "move-to-viewpoint", viewpointId: "first" },
        },
        {
          when: sceneStartInteraction.when,
          do: { type: "play-audio", mediaId: "spatial" },
        },
        {
          when: sceneStartInteraction.when,
          do: { type: "move-to-viewpoint", viewpointId: "next" },
        },
      ],
      hotspots,
      runner,
    );

    handler.sceneStarted();

    expect(runAction.mock.results.map(({ type }) => type)).toEqual(["return", "throw", "return"]);
    expect(runAction.mock.results[1]?.value).toBe(cancelled);
    expect(moved.mock.calls).toEqual([["first"], ["next"]]);
  });

  it("matches click rules and hotspots case-insensitively in author order", () => {
    const runAction = vi.fn();
    const first: Interaction = {
      when: { type: "visitor-clicks-hotspot", targetHotspotId: "CRATE-HOTSPOT" },
      do: { type: "open-link", url: "https://example.com/first" },
    };
    const second: Interaction = {
      when: { type: "visitor-clicks-hotspot", targetHotspotId: "crate-hotspot" },
      do: { type: "open-link", url: "https://example.com/second" },
    };
    const handler = createInteractionHandler(
      [first, clickInteraction, sceneStartInteraction, second],
      hotspots,
      recorder(runAction),
    );

    handler.objectClicked("other");
    expect(runAction).not.toHaveBeenCalled();
    handler.objectClicked("CRATE");

    expect(runAction.mock.calls).toEqual([[first.do], [clickInteraction.do], [second.do]]);
  });

  it("waits two seconds by default and fires each elapsed interaction once", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler([elapsedInteraction], hotspots, recorder(runAction));

    handler.update(DEFAULT_ELAPSED_SECONDS - 0.01);
    expect(runAction).not.toHaveBeenCalled();

    handler.update(0.01);
    expect(runAction).toHaveBeenCalledExactlyOnceWith(elapsedInteraction.do);

    handler.update(10);
    expect(runAction).toHaveBeenCalledOnce();
  });

  it("honours a custom elapsed time and resets", () => {
    const runAction = vi.fn();
    const interaction: Interaction = {
      when: { type: "time-elapsed", seconds: 5 },
      do: { type: "open-link", url: "https://example.com" },
    };
    const handler = createInteractionHandler([interaction], hotspots, recorder(runAction));

    handler.update(4.99);
    expect(runAction).not.toHaveBeenCalled();

    handler.update(0.01);
    expect(runAction).toHaveBeenCalledExactlyOnceWith(interaction.do);

    handler.reset();
    handler.update(5);
    expect(runAction).toHaveBeenCalledTimes(2);
  });

  it("fires a touch rule on entry and re-arms after the visitor steps away", () => {
    const runAction = vi.fn();
    const touching = vi.fn((objectId: string) => objectId === "crate");
    const handler = createInteractionHandler([touchInteraction], hotspots, recorder(runAction));

    handler.update(0.016, touching);
    expect(runAction).toHaveBeenCalledExactlyOnceWith(touchInteraction.do);
    expect(touching).toHaveBeenCalledWith("crate");

    handler.update(0.016, touching);
    expect(runAction).toHaveBeenCalledOnce();

    handler.update(0.016, () => false);
    handler.update(0.016, touching);
    expect(runAction).toHaveBeenCalledTimes(2);
  });

  it("ignores touch rules without a contact query or a matching hotspot", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler(
      [
        {
          when: { type: "visitor-touch", targetHotspotId: "missing" },
          do: { type: "print-hi" },
        },
      ],
      hotspots,
      recorder(runAction),
    );

    handler.update(0.016);
    handler.update(0.016, () => true);

    expect(runAction).not.toHaveBeenCalled();
  });

  it("matches touch hotspot IDs case-insensitively", () => {
    const runAction = vi.fn();
    const touching = vi.fn((objectId: string) => objectId === "crate");
    const handler = createInteractionHandler(
      [
        {
          when: { type: "visitor-touch", targetHotspotId: "CRATE-HOTSPOT" },
          do: { type: "print-hi" },
        },
      ],
      hotspots,
      recorder(runAction),
    );

    handler.update(0.016, touching);

    expect(touching).toHaveBeenCalledWith("crate");
    expect(runAction).toHaveBeenCalledOnce();
  });

  it("stops touch rules when an elapsed rule has already navigated", () => {
    const run = vi.fn(() => true);
    const handler = createInteractionHandler(
      [{ when: { type: "time-elapsed", seconds: 1 }, do: { type: "print-hi" } }, touchInteraction],
      hotspots,
      { run, stop: vi.fn() },
    );

    handler.update(1, () => true);

    expect(run).toHaveBeenCalledOnce();
  });

  it("resets touch contact state", () => {
    const runAction = vi.fn();
    const touching = () => true;
    const handler = createInteractionHandler([touchInteraction], hotspots, recorder(runAction));

    handler.update(0.016, touching);
    handler.reset();
    handler.update(0.016, touching);

    expect(runAction).toHaveBeenCalledTimes(2);
  });

  it("stops its own playback when the preview resets", () => {
    const actions = recorder();
    const handler = createInteractionHandler([sceneStartInteraction], hotspots, actions);

    handler.sceneStarted();
    handler.reset();

    expect(actions.stop).toHaveBeenCalledOnce();
  });

  it("ignores non-positive and invalid time updates", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler([elapsedInteraction], hotspots, recorder(runAction));

    handler.update(DEFAULT_ELAPSED_SECONDS - 0.5);
    handler.update(0);
    handler.update(-5);
    handler.update(Number.NaN);

    expect(runAction).not.toHaveBeenCalled();
    handler.update(0.5);
    expect(runAction).toHaveBeenCalledExactlyOnceWith(elapsedInteraction.do);
  });
});
