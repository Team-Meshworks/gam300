import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { createExistingProjectClient, type ExistingProject } from "./existing-project";
import type { ProjectSummary } from "./workspace-api";
import "./pending-create-recovery.css";

const projects = createExistingProjectClient();

export function ExistingProjectPicker({
  actorId,
  active,
  source = false,
  projectId,
  onSelect,
  onSeparate,
}: {
  actorId: string;
  active: boolean;
  source?: boolean;
  projectId?: string;
  onSelect: (project: ExistingProject) => void | Promise<void>;
  onSeparate?: () => void | Promise<void>;
}) {
  const [rows, setRows] = useState<ProjectSummary[] | null>(null);
  const [selected, setSelected] = useState<(ExistingProject & { context: string }) | null>(null);
  const [loadedContext, setLoadedContext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const inFlight = useRef(false);
  const context = actorId + ":" + refresh + ":" + source + ":" + (projectId ?? "");
  useEffect(() => {
    let cancelled = false;
    void projects.list(actorId).then(
      (values) => {
        if (!cancelled) {
          setRows(values);
          setLoadedContext(context);
          setError("");
        }
      },
      () => {
        if (!cancelled) {
          setRows(null);
          setError("Existing projects are unavailable. Refresh before making a recovery choice.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [actorId, context]);
  async function run(action: "review" | "select" | "separate", projectId?: string) {
    if (!active || inFlight.current || rows === null || loadedContext !== context) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (action === "separate") {
        await projects.check(actorId);
        await onSeparate?.();
      } else {
        if (action === "review")
          setSelected({
            ...(await projects.read(actorId, projectId!, source)),
            context,
          });
        else {
          if (!selected || selected.context !== context)
            throw new Error("Review the project for the current account first.");
          const project = await projects.confirm(actorId, selected, source);
          await onSelect(project);
        }
      }
    } catch (cause) {
      if (action === "select") setSelected(null);
      setError(
        cause instanceof Error ? cause.message : "The selected project could not be checked.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="sp-creation-notice sp-create-recovery" aria-label="Choose existing project">
      <p>
        Review the project details to choose the correct result. Projects can share the same title.
      </p>
      {source && (
        <p>Only active projects you can manage can be selected as an assignment source.</p>
      )}
      {rows === null || loadedContext !== context ? (
        <p role="status">{error ? "Project list unavailable." : "Loading existing projects…"}</p>
      ) : (
        <>
          {rows.length ? (
            <ul>
              {rows
                .filter((row) => projectId === undefined || row.projectId === projectId)
                .map((row) => (
                  <li key={row.projectId}>
                    <span>
                      {row.title}
                      {row.archived ? " (Archived)" : ""}
                    </span>{" "}
                    <Button
                      disabled={
                        !active || busy || (source && (row.archived || !row.permissions.canManage))
                      }
                      aria-label={"Review project " + row.projectId}
                      onClick={() => void run("review", row.projectId)}
                    >
                      Review project
                    </Button>
                  </li>
                ))}
            </ul>
          ) : (
            <p>No projects are available.</p>
          )}
          {selected?.context === context && (
            <div>
              <p>
                Selected project: {selected.title}. {selected.archived ? "Archived." : "Active."}
              </p>
              <Button
                disabled={!active || busy}
                onClick={() => void run("select", selected.projectId)}
              >
                {source ? "Use this existing source project" : "Open this existing project"}
              </Button>
            </div>
          )}
          {onSeparate && (
            <Button disabled={!active || busy} onClick={() => void run("separate")}>
              I reviewed the list; start a separate creation
            </Button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="sp-form-dialog-actions">
        <Button
          disabled={!active || busy}
          onClick={() => {
            setRows(null);
            setSelected(null);
            setError("");
            setRefresh((value) => value + 1);
          }}
        >
          Refresh projects
        </Button>
      </div>
    </section>
  );
}
