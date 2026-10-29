import { createRoot } from "react-dom/client";
import {
  AssignmentCreationScreen,
  AssignmentDetailsScreen,
  AssignmentListScreen,
} from "../projects/AssignmentScreens";
import "../../shared/ui/foundation.css";

const parameters = new URLSearchParams(location.search);
const open = (id: string) => {
  document.getElementById("opened")!.textContent = id;
};
const root = document.getElementById("root");
if (!root) throw new Error("The test root is unavailable.");
if (import.meta.env.DEV)
  createRoot(root).render(
    parameters.get("view") === "list" ? (
      <AssignmentListScreen classId={parameters.get("class")!} onOpenProject={open} />
    ) : parameters.get("view") === "details" ? (
      <AssignmentDetailsScreen
        classId={parameters.get("class")!}
        assignmentId={parameters.get("assignment")!}
        onOpenProject={open}
      />
    ) : (
      <AssignmentCreationScreen onOpenProject={open} />
    ),
  );
