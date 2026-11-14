import { describe, expect, it } from "vitest";
import documentFixture from "./fixtures/asset-pipeline-document-history.json";
import viewpointFixture from "./fixtures/asset-pipeline-view-history.json";
import { deserializeProject } from "../shared/project/project-deserialization";
import {
  captureProjectHistory,
  captureRecoveryHistory,
  MAX_HISTORY_BYTES,
  validateRecoveryHistory,
} from "./recovery-history";

const kinds = new Map([
  ["room", "environment"],
  ["crate", "model"],
]);
function load(document: unknown) {
  const result = deserializeProject(JSON.stringify(document), kinds);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

// Fixtures were produced and checked by the unmodified asset-pipeline store/reader at
// bad2ff2458b69bc4d30f250b541df1b85fad0012 (provenance is also recorded in each fixture).
describe("asset-pipeline recovery compatibility", () => {
  it("reads full documents, active scenes and both stacks produced by asset-pipeline", () => {
    const project = load(documentFixture.document);
    const result = validateRecoveryHistory(documentFixture.history, project, kinds);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(1);
    expect(result.value.documents!.current).toEqual(project);
    expect(result.value.documents!.activeSceneId).toBe(project.scenes[1]!.id);
    expect(result.value.documents!.past).toHaveLength(
      documentFixture.history.documents.past.length,
    );
    expect(result.value.documents!.future).toHaveLength(2);
    const future = result.value.documents!.future;
    expect(future[0]!.project.scenes.map((s) => s.name)).toEqual(["Exhibit", "Gallery"]);
    expect(future[1]!.project.scenes.map((s) => s.name)).toEqual(["Exhibit"]);
    expect(Object.isFrozen(future[0]!.project.scenes[0]!.objects[0]!.transform.position)).toBe(
      true,
    );
    const recaptured = captureProjectHistory(project, result.value.documents!.activeSceneId, {
      past: [...result.value.documents!.past],
      future: [...future],
    });
    expect(recaptured.version).toBe(2);
    expect(recaptured.documents).toEqual(result.value.documents);
    expect(recaptured.views).toEqual(result.value.views);
    expect(validateRecoveryHistory(recaptured, project, kinds).ok).toBe(true);
  });

  it.each(["current", "past", "future"] as const)(
    "validates the %s compatibility copy against its matching document",
    (stack) => {
      const history = structuredClone(documentFixture.history);
      const document =
        stack === "current" ? history.documents.current : history.documents[stack][0]!.project;
      const copy = stack === "current" ? history.current : history[stack][0]!;
      // Older checkpoints keep the authored rotation in both copies. The scene reader normalizes it.
      document.scenes[0]!.objects[0]!.transform.rotation = [0, 0, 0, 1.0000005];
      const entry = copy[0]!;
      entry.transform.rotation = [0, 0, 0, 1.0000005];
      copy[0] = {
        ...entry,
        transform: {
          scale: entry.transform.scale,
          rotation: entry.transform.rotation,
          position: entry.transform.position,
        },
      };
      const project = load(history.documents.current);
      const restored = validateRecoveryHistory(history, project, kinds);
      expect(restored.ok).toBe(true);
      if (!restored.ok) throw new Error(restored.error.message);
      expect(validateRecoveryHistory(restored.value, project, kinds).ok).toBe(true);
      copy[0]!.transform.rotation = [0, 1, 0, 0];
      expect(validateRecoveryHistory(history, project, kinds).ok).toBe(false);
    },
  );

  it("reads the earlier viewpoint envelope without document snapshots", () => {
    const project = load(viewpointFixture.document);
    const result = validateRecoveryHistory(viewpointFixture.history, project, kinds);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documents).toBeUndefined();
    expect(result.value.views!.current[0]!.name).toBe("Entrance");
    expect(result.value.views!.past[0]).toEqual([]);
    expect(result.value.past).toHaveLength(viewpointFixture.history.past.length);
  });

  it("reads dev's hierarchy envelope", () => {
    const project = load(viewpointFixture.document);
    const history = captureRecoveryHistory(project, { past: [[]], future: [] });
    const result = validateRecoveryHistory(history, project, kinds);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.documents).toBeUndefined();
    expect(result.value.views).toBeUndefined();
    expect(result.value.past).toEqual([
      { objects: [], groups: [], sceneName: project.scenes[0]!.name },
    ]);
  });

  it.each([
    "active scene",
    "past active scene",
    "foreign project",
    "current",
    "objects",
    "views",
    "length",
    "unknown field",
  ])("rejects invalid %s in a full-document history", (damage) => {
    const history = structuredClone(documentFixture.history);
    if (damage === "active scene") history.documents.activeSceneId = crypto.randomUUID();
    if (damage === "past active scene")
      history.documents.past[0]!.activeSceneId = crypto.randomUUID();
    if (damage === "foreign project")
      history.documents.past[0]!.project.projectId = crypto.randomUUID();
    if (damage === "current") history.documents.current.title = "Different document";
    if (damage === "objects") history.past[0] = [];
    if (damage === "views") history.views.past[0] = [];
    if (damage === "length") history.documents.future.pop();
    if (damage === "unknown field") Object.assign(history.documents.past[0]!, { unexpected: true });
    expect(validateRecoveryHistory(history, load(documentFixture.document), kinds).ok).toBe(false);
  });

  it("trims full documents and compatibility copies together at the byte limit", () => {
    const project = load(documentFixture.document);
    const components = Array.from({ length: 7 }, () => ({
      id: crypto.randomUUID(),
      type: "text",
      caption: "Panel",
      runs: [{ text: "x".repeat(60_000), marks: [] }],
    }));
    const largeProject = load({
      ...project,
      scenes: project.scenes.map((scene, index) =>
        index !== 1
          ? scene
          : {
              ...scene,
              objects: scene.objects.map((object) => ({ ...object, components })),
            },
      ),
    });
    const past = Array.from({ length: 30 }, (_, i) => ({
      project: { ...largeProject, title: `Edit ${i}` },
      activeSceneId: project.scenes[0]!.id,
    }));
    const future = [...past].reverse();
    const history = captureProjectHistory(project, project.scenes[1]!.id, { past, future });
    expect(new TextEncoder().encode(JSON.stringify(history)).byteLength).toBeLessThanOrEqual(
      MAX_HISTORY_BYTES,
    );
    expect(history.documents!.past.length + history.documents!.future.length).toBeLessThan(60);
    expect(history.documents!.past[0]).toBe(past[0]);
    expect(history.documents!.future[0]).toBe(future[0]);
    expect(history.past).toHaveLength(history.documents!.past.length);
    expect(history.future).toHaveLength(history.documents!.future.length);
    expect(history.views!.past).toHaveLength(history.past.length);
    expect(validateRecoveryHistory(history, project, kinds).ok).toBe(true);
    expect(past).toHaveLength(30);
    expect(future).toHaveLength(30);
  });
});
