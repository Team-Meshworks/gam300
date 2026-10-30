import { describe, expect, it, vi } from "vitest";
import type { ProjectHotspot } from "../../shared/project/project-types";
import { createInteractionHandler, type Interaction } from "./interactionHandler";
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

describe("interaction handler", () => {
  it("runs the action for a scene start", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler(
      [sceneStartInteraction, clickInteraction],
      hotspots,
      runAction,
    );

    handler.sceneStarted();

    expect(runAction).toHaveBeenCalledExactlyOnceWith(sceneStartInteraction.do);
  });

  it("continues after an action throws", () => {
    const runAction = vi.fn().mockImplementationOnce(() => {
      throw new Error("action failed");
    });
    const handler = createInteractionHandler(
      [sceneStartInteraction, sceneStartInteraction],
      hotspots,
      runAction,
    );

    handler.sceneStarted();

    expect(runAction).toHaveBeenCalledTimes(2);
  });

  it("runs only the click interactions for the clicked object", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler(
      [clickInteraction, sceneStartInteraction],
      hotspots,
      runAction,
    );

    handler.objectClicked("other");
    expect(runAction).not.toHaveBeenCalled();

    handler.objectClicked("crate");
    expect(runAction).toHaveBeenCalledExactlyOnceWith(clickInteraction.do);
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
      [first, clickInteraction, second],
      hotspots,
      runAction,
    );

    handler.objectClicked("CRATE");

    expect(runAction.mock.calls).toEqual([[first.do], [clickInteraction.do], [second.do]]);
  });

  it("waits two seconds by default and fires each elapsed interaction once", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler([elapsedInteraction], hotspots, runAction);

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
    const handler = createInteractionHandler([interaction], hotspots, runAction);

    handler.update(4.99);
    expect(runAction).not.toHaveBeenCalled();

    handler.update(0.01);
    expect(runAction).toHaveBeenCalledExactlyOnceWith(interaction.do);

    handler.reset();
    handler.update(5);
    expect(runAction).toHaveBeenCalledTimes(2);
  });

  it("ignores non-positive and invalid time updates", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler([elapsedInteraction], hotspots, runAction);

    handler.update(0);
    handler.update(-5);
    handler.update(Number.NaN);

    expect(runAction).not.toHaveBeenCalled();
  });
});
