import { expect, it, vi } from "vitest";
import {
  captureProjectHistory,
  MAX_HISTORY_BYTES,
  validateRecoveryHistory,
} from "./recovery-history";
import { validateProject } from "../shared/project/project-validation";
import fixture from "./fixtures/asset-pipeline-document-history.json";

it("budgets large document histories with linear serialization while retaining the closest edits", () => {
  const kinds = new Map([
    ["room", "environment"],
    ["crate", "model"],
  ]);
  const checked = validateProject(
    {
      ...fixture.document,
      scenes: fixture.document.scenes.map((scene) => ({
        ...scene,
        objects: scene.objects.map((object) => ({
          ...object,
          components: Array.from({ length: 2 }, () => ({
            id: crypto.randomUUID(),
            type: "text",
            caption: "",
            runs: [{ text: "界".repeat(60_000), marks: [] }],
          })),
        })),
      })),
    },
    kinds,
  );
  if (!checked.ok) throw new Error(checked.error.message);
  const project = checked.value;
  const activeSceneId = project.scenes[1]!.id;
  const state = (index: number) => ({
    project: { ...project, title: `Edit ${index}` },
    activeSceneId,
  });
  const past = Array.from({ length: 15 }, (_, i) => state(i));
  const future = Array.from({ length: 10 }, (_, i) => state(100 + i));
  const stringify = JSON.stringify;
  let serializedCharacters = 0;
  const spy = vi.spyOn(JSON, "stringify");
  let history;
  try {
    history = captureProjectHistory(project, activeSceneId, { past, future });
    for (const result of spy.mock.results) {
      if (result.type === "return") serializedCharacters += result.value?.length ?? 0;
    }
  } finally {
    spy.mockRestore();
  }
  expect(validateRecoveryHistory(history, project, kinds).ok).toBe(true);
  expect(Buffer.byteLength(stringify(history))).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
  const { documents, views } = history;
  if (!documents || !views) throw new Error("Missing recovery snapshots");
  expect(documents.activeSceneId).toBe(activeSceneId);
  expect(documents.past.length + documents.future.length).toBeLessThan(past.length + future.length);
  for (const side of ["past", "future"] as const) {
    const input = side === "past" ? past : future;
    expect(history[side].length).toBeGreaterThan(0);
    expect(views[side]).toHaveLength(history[side].length);
    expect(documents[side]).toEqual(input.slice(0, history[side].length));
  }
  expect(past).toHaveLength(15);
  expect(future).toHaveLength(10);
  const nextSide = history.past.length <= history.future.length ? "past" : "future";
  const next = (nextSide === "past" ? past : future)[history[nextSide].length]!;
  const expanded = {
    ...history,
    [nextSide]: [...history[nextSide], history.current],
    views: {
      ...views,
      [nextSide]: [...views[nextSide], views.current],
    },
    documents: { ...documents, [nextSide]: [...documents[nextSide], next] },
  };
  expect(Buffer.byteLength(stringify(expanded))).toBeGreaterThan(MAX_HISTORY_BYTES);
  // A constant multiple of the input size, independent of how many snapshots are trimmed
  expect(serializedCharacters).toBeLessThan(stringify({ project, past, future }).length * 3);
});
