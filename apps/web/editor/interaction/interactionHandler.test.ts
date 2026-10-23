import { describe, expect, it, vi } from "vitest";
import { createInteractionHandler, type Interaction } from "./interactionHandler";
import { DEFAULT_ELAPSED_SECONDS } from "./triggerHandler";

const clickInteraction: Interaction = {
  when: { type: "visitor-clicks-object", targetObjectId: "crate" },
  do: { type: "print-hi", targetObjectId: "panel" },
};

const sceneStartInteraction: Interaction = {
  when: { type: "scene-starts", targetObjectId: "crate" },
  do: { type: "print-hi", targetObjectId: "viewpoint" },
};

const elapsedInteraction: Interaction = {
  when: { type: "time-elapsed", targetObjectId: "crate" },
  do: { type: "print-hi", targetObjectId: "crate" },
};

describe("interaction handler", () => {
  it("runs the action for a scene start", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler([sceneStartInteraction, clickInteraction], runAction);

    handler.sceneStarted();

    expect(runAction).toHaveBeenCalledExactlyOnceWith(sceneStartInteraction.do);
  });

  it("runs only the click interactions for the clicked object", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler([clickInteraction, sceneStartInteraction], runAction);

    handler.objectClicked("other");
    expect(runAction).not.toHaveBeenCalled();

    handler.objectClicked("crate");
    expect(runAction).toHaveBeenCalledExactlyOnceWith(clickInteraction.do);
  });

  it("waits two seconds by default and fires each elapsed interaction once", () => {
    const runAction = vi.fn();
    const handler = createInteractionHandler([elapsedInteraction], runAction);

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
      when: { type: "time-elapsed", targetObjectId: "crate", seconds: 5 },
      do: { type: "open-link", targetObjectId: "crate", url: "https://example.com" },
    };
    const handler = createInteractionHandler([interaction], runAction);

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
    const handler = createInteractionHandler([elapsedInteraction], runAction);

    handler.update(0);
    handler.update(-5);
    handler.update(Number.NaN);

    expect(runAction).not.toHaveBeenCalled();
  });
});
