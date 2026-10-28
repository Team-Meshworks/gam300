import { useEffect, useState, type ReactNode } from "react";
import { WorkspaceShell } from "../../shared/ui/WorkspaceShell";
import { Dialog } from "../../shared/ui/Dialog";
import { PageState } from "../../shared/ui/PageState";
import { NewProjectExample } from "./NewProjectExample";
import { ReviewExample } from "./ReviewExample";
import { AccountsExample } from "./AccountsExample";
import { ClassAssignmentExample } from "./ClassAssignmentExample";

const views = [
  {
    id: "classes",
    link: "Classes",
    title: "Class assignments",
    description: "Choose a project, view its class roster and select students.",
  },
  {
    id: "new-project",
    link: "New project",
    title: "New Project",
    description: "Set up a new experience, add your project details and choose your students.",
  },
  {
    id: "review",
    link: "Review",
    title: "Submission review",
    description: "Review and class-assignment component examples.",
  },
  {
    id: "accounts",
    link: "Accounts",
    title: "Accounts",
    description: "Search, filter and inspect sample organisation accounts.",
  },
] as const;
type ExampleState = "ready" | "loading" | "empty" | "error" | "disabled";
function currentView() {
  return views.find((view) => `#${view.id}` === location.hash)?.id ?? "new-project";
}

export function FoundationPreview() {
  const [active, setActive] = useState(currentView);
  const [state, setState] = useState<ExampleState>("ready");
  const [dialog, setDialog] = useState<{ title: string; body: ReactNode } | null>(null);
  useEffect(() => {
    const update = () => {
      const requested = views.find((view) => `#${view.id}` === location.hash);
      if (requested) setActive(requested.id);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  function openPreview(title: string, body: ReactNode) {
    setDialog({ title, body });
  }
  const view = views.find((item) => item.id === active) ?? views[0];
  return (
    <>
      <a className="sp-skip-link" href="#workspace">
        Skip to workspace
      </a>
      <aside className="sp-preview-tools" aria-label="Development preview">
        <div>
          <h1>UI foundation</h1>
          <p>Development preview · sample data · nothing is saved</p>
        </div>
        <nav aria-label="Preview screens">
          {views.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={active === item.id ? "page" : undefined}
            >
              {item.link}
            </a>
          ))}
        </nav>
        <label>
          Example state
          <select
            value={state}
            onChange={(event) => {
              const next = event.target.value;
              if (
                next === "ready" ||
                next === "loading" ||
                next === "empty" ||
                next === "error" ||
                next === "disabled"
              )
                setState(next);
            }}
          >
            {["Ready", "Loading", "Empty", "Error", "Disabled"].map((label) => (
              <option key={label} value={label.toLowerCase()}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </aside>
      <WorkspaceShell name="Ms Tan" initials="MT">
        <div className="sp-page-heading">
          <h1>{view.title}</h1>
          <p>{view.description}</p>
        </div>
        {state !== "ready" && state !== "disabled" && (
          <PageState state={state} onRetry={() => setState("ready")} />
        )}
        <fieldset
          className="sp-example-content"
          disabled={state === "disabled"}
          hidden={state !== "ready" && state !== "disabled"}
        >
          <legend className="sp-sr-only">{view.title} example</legend>
          <section hidden={active !== "new-project"}>
            <NewProjectExample onPreview={openPreview} />
          </section>
          <section hidden={active !== "review"}>
            <ReviewExample onPreview={openPreview} />
          </section>
          <section hidden={active !== "classes"}>
            <ClassAssignmentExample />
          </section>
          <section hidden={active !== "accounts"}>
            <AccountsExample onPreview={openPreview} />
          </section>
        </fieldset>
        {dialog && (
          <Dialog title={dialog.title} onClose={() => setDialog(null)}>
            {dialog.body}
          </Dialog>
        )}
      </WorkspaceShell>
    </>
  );
}
