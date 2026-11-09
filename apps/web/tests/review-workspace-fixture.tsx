import { createRoot } from "react-dom/client";
import { useState } from "react";
import { createAccountClient, type AccountSession } from "../editor/accounts/account-client";
import { ReviewWorkspace } from "../editor/reviews/ReviewWorkspace";
import { useWorkspaceDeparture } from "../editor/workspace/useWorkspaceDeparture";
import { WorkspaceShell } from "../shared/ui/WorkspaceShell";
import "../shared/ui/foundation.css";
import "../editor/workspace/workspace.css";
const accounts = createAccountClient();
const session = await accounts.getSession();
function Fixture({ session }: { session: AccountSession }) {
  const [guard, setGuard] = useState({ dirty: false, pending: false });
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
      <ReviewWorkspace session={session} guard={guard} onGuard={setGuard} />
      {confirmation}
    </WorkspaceShell>
  );
}
if (session) createRoot(document.getElementById("root")!).render(<Fixture session={session} />);
