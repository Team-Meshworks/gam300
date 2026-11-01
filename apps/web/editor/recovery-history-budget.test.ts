import { expect, it, vi } from "vitest";
import {
  captureProjectHistory,
  MAX_HISTORY_BYTES,
  validateRecoveryHistory,
} from "./recovery-history";
import { validateProject } from "../shared/project/project-validation";
import fixture from "../shared/project/fixtures/m1-project.json";

it("budgets large document histories with linear serialization while retaining the closest edits", () => {
  const source = fixture.scenes[0]!;
  const kinds = new Map([
    ["test-room-v1", "environment"],
    ["test-crate-v1", "model"],
  ]);
  const checked = validateProject(
    {
      ...fixture,
      schemaVersion: 2,
      scenes: [
        {
          ...source,
          viewpoints: [],
          groups: [],
          zones: [],
          rules: [],
          objects: Array.from({ length: 200 }, () => ({
            ...source.objects[0],
            id: crypto.randomUUID(),
            parentId: null,
            visible: true,
            components: [
              {
                id: crypto.randomUUID(),
                type: "text",
                caption: "",
                runs: [{ text: "界".repeat(1024), marks: [] }],
              },
            ],
          })),
        },
      ],
    },
    kinds,
  );
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error("Invalid fixture");
  const project = checked.value;
  const state = (index: number) => ({
    project: { ...project, title: `Edit ${index}` },
    activeSceneId: source.id,
  });
  const past = Array.from({ length: 15 }, (_, i) => state(i));
  const future = Array.from({ length: 10 }, (_, i) => state(100 + i));
  const stringify = JSON.stringify;
  let serializedCharacters = 0;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((value) => {
    const result = stringify(value);
    serializedCharacters += result?.length ?? 0;
    return result;
  });
  let history;
  try {
    history = captureProjectHistory(project, source.id, { past, future });
  } finally {
    spy.mockRestore();
  }
  expect(validateRecoveryHistory(history, project, kinds).ok).toBe(true);
  expect(new TextEncoder().encode(stringify(history)).byteLength).toBeLessThanOrEqual(
    MAX_HISTORY_BYTES,
  );
  expect(history.documents!.past.length + history.documents!.future.length).toBeLessThan(25);
  expect(history.documents!.past.length).toBeGreaterThan(0);
  expect(history.documents!.future.length).toBeGreaterThan(0);
  expect(history.documents!.past).toEqual(past.slice(0, history.past.length));
  expect(history.documents!.future).toEqual(future.slice(0, history.future.length));
  expect(past).toHaveLength(15);
  expect(future).toHaveLength(10);
  const nextSide = history.past.length <= history.future.length ? "past" : "future";
  const next = (nextSide === "past" ? past : future)[history[nextSide].length]!;
  const expanded = {
    ...history,
    [nextSide]: [...history[nextSide], next.project.scenes[0]!.objects],
    views: {
      ...history.views!,
      [nextSide]: [...history.views![nextSide], next.project.scenes[0]!.viewpoints],
    },
    documents: { ...history.documents!, [nextSide]: [...history.documents![nextSide], next] },
  };
  expect(new TextEncoder().encode(stringify(expanded)).byteLength).toBeGreaterThan(
    MAX_HISTORY_BYTES,
  );
  // A constant multiple of the input size, independent of how many snapshots are trimmed
  expect(serializedCharacters).toBeLessThan(stringify({ project, past, future }).length * 3);
});
