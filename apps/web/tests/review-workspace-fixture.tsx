import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createAccountClient, type AccountSession } from "../editor/accounts/account-client";
import { PublishDialog } from "../editor/publications/PublishDialog";
import { PublicationPage } from "../editor/publications/PublicationPage";
import { ReviewWorkspace } from "../editor/reviews/ReviewWorkspace";
import { useWorkspaceDeparture } from "../editor/workspace/useWorkspaceDeparture";
import { WorkspaceShell } from "../shared/ui/WorkspaceShell";
import "../shared/ui/foundation.css";
import "../editor/workspace/workspace.css";
const accounts = createAccountClient();
const session = await accounts.getSession();
function Fixture({ session }: { session: AccountSession }) {
  const [guard, setGuard] = useState({ dirty: false, pending: false });
  const projectId = new URLSearchParams(location.search).get("projectId");
  const { navigate, confirmation } = useWorkspaceDeparture(true, guard);
  return (
    <WorkspaceShell
      header={{
        account: session,
        homeHref: "/home",
        locked: guard.pending,
        onSignOut: () =>
          navigate(
            () => void accounts.signOut(session.userId).then(() => location.replace("/login")),
          ),
      }}
    >
      {new URLSearchParams(location.search).get("screen") === "publish-dialog" ? (
        <PublishDialog
          actorId={session.userId}
          {...(projectId === null ? {} : { projectId })}
          onClose={() => location.assign("/home")}
        />
      ) : new URLSearchParams(location.search).get("screen") === "publication" ? (
        <>
          <h1>Publish project</h1>
          <PublicationPage session={session} onGuard={setGuard} />
        </>
      ) : (
        <ReviewWorkspace session={session} guard={guard} onGuard={setGuard} />
      )}
      {confirmation}
    </WorkspaceShell>
  );
}
if (session) createRoot(document.getElementById("root")!).render(<Fixture session={session} />);
