import { createRoot } from "react-dom/client";
import { createAccountClient } from "../editor/accounts/account-client";
import { ReviewWorkspace } from "../editor/reviews/ReviewWorkspace";
import "../shared/ui/foundation.css";
const session = await createAccountClient().getSession();
if (session)
  createRoot(document.getElementById("root")!).render(<ReviewWorkspace session={session} />);
