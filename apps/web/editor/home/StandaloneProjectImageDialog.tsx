import { useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import { ProjectImageFields } from "../projects/ProjectImageFields";
import {
  encodeProjectImage,
  validProjectImage,
  type ProjectImage,
} from "../projects/project-image";
import { createWorkspaceClient, type ProjectSummary } from "./workspace-api";

const workspace = createWorkspaceClient();
export function StandaloneProjectImageDialog({
  project,
  actorId,
  onClose,
  onSaved,
}: {
  project: ProjectSummary;
  actorId: string;
  onClose: () => void;
  onSaved: (project: ProjectSummary) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<ProjectImage["type"]>(project.image?.type ?? "cover");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function save() {
    if (!file || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const image = await encodeProjectImage(file, type);
      const result = await workspace.write(
        actorId,
        `/api/v1/projects/${project.projectId}/image`,
        "PUT",
        {
          expectedUpdatedAt: project.updatedAt,
          image,
        },
      );
      if (result.kind === "rejected") throw new Error(result.message);
      const value = result.kind === "confirmed" ? result.value : null;
      if (
        !value ||
        typeof value !== "object" ||
        !("image" in value) ||
        !value.image ||
        !validProjectImage(value.image) ||
        value.image.url !== `/api/v1/projects/${project.projectId}/image` ||
        !("updatedAt" in value) ||
        typeof value.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(value.updatedAt))
      )
        throw new Error(
          "The image change could not be confirmed. Refresh the project to check it.",
        );
      onSaved({ ...project, image: value.image, updatedAt: value.updatedAt });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The project image could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Change image"
      variant="admin"
      className="sp-assignment-edit-dialog sp-project-image-dialog sp-dialog--form"
      closeDisabled={busy}
      onClose={onClose}
    >
      {message && <p role="alert">{message}</p>}
      <fieldset disabled={busy}>
        <ProjectImageFields imageType={type} onType={setType} imageFile={file} onFile={setFile} />
      </fieldset>
      <div className="sp-actions sp-form-dialog-actions">
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!file || busy} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </Dialog>
  );
}
