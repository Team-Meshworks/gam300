import { useState } from "react";
import { Button } from "../../shared/ui/Button";
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
  const [expanded, setExpanded] = useState(false);
  const [observed] = useState(() => {
    try {
      return sessionStorage.getItem(historicalCreationKey(actorId));
    } catch {
      return "unreadable";
    }
  });
  if (observed === null) return null;
  if (!expanded)
    return (
      <div className="sp-recovery-summary" role="alert">
        <p>An earlier project request needs checking. Your work is unchanged.</p>
        <Button disabled={!active} onClick={() => setExpanded(true)}>
          Check status
        </Button>
      </div>
    );
  if (observed !== "1")
    return (
      <p role="alert">
        The earlier request could not be read. Reload to try again. Nothing has been cleared.
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
        An earlier project request could not be confirmed. Check your projects before opening the
        result or starting another project.
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
