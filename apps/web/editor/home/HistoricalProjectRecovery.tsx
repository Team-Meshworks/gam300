import { useState } from "react";
import { ExistingProjectPicker } from "./ExistingProjectPicker";
import {
  clearHistoricalCreation,
  createExistingProjectClient,
  historicalCreationKey,
} from "./existing-project";

const projects = createExistingProjectClient();

export function HistoricalProjectRecovery({
  actorId,
  active,
  onOpen,
  onSeparate,
}: {
  actorId: string;
  active: boolean;
  onOpen: (projectId: string) => void;
  onSeparate: () => void;
}) {
  const [observed] = useState(() => {
    try {
      return sessionStorage.getItem(historicalCreationKey(actorId));
    } catch {
      return "unreadable";
    }
  });
  if (observed === null) return null;
  if (observed !== "1")
    return (
      <p role="alert">
        The earlier creation warning is unreadable. It has been preserved; no recovery choice can
        safely clear it.
      </p>
    );
  async function clear() {
    if (
      !(await clearHistoricalCreation(sessionStorage, actorId, observed!, () =>
        projects.check(actorId),
      ))
    )
      throw new Error("The earlier creation warning changed. Reload before continuing.");
  }
  return (
    <section className="sp-historical-recovery" aria-label="Historical project recovery">
      <p>
        An earlier project creation or import had no server operation identifier. Review the current
        projects and choose an exact existing project, or explicitly decide to start a separate
        creation. Its earlier outcome remains unknown.
      </p>
      <ExistingProjectPicker
        actorId={actorId}
        active={active}
        onSelect={async (project) => {
          await clear();
          onOpen(project.projectId);
        }}
        onSeparate={async () => {
          await clear();
          onSeparate();
        }}
      />
    </section>
  );
}
