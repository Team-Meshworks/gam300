import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { checkFields, invalid, isRecord, readField } from "../../shared/project/validation-helpers";
import type { ValidationResult } from "../../shared/project/validation-helpers";

// Keep the confirmed version separate from edits still waiting for the server
// Pending JSON keeps its exact bytes so a reopened session can replay the same mutation
export type ServerSaveRecovery = Readonly<{
  revision: number;
  confirmedJson: string;
  pending: Readonly<{ clientMutationId: string; documentJson: string }> | null;
}>;

export function validateServerSaveRecovery(
  raw: unknown,
  projectId: string,
  assetKinds: ReadonlyMap<string, string>,
): ValidationResult<ServerSaveRecovery> {
  // Browser storage can outlive the code that wrote it
  // Check the stored fields again before using them to build another server request
  if (!isRecord(raw)) return invalid("recovery.serverSave", "Invalid server recovery metadata");
  const fields = checkFields(raw, ["revision", "confirmedJson", "pending"], "recovery.serverSave");
  if (!fields.ok) return fields;
  const revision = readField(raw, "revision");
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
    return invalid("recovery.serverSave.revision", "Invalid server revision");
  // Run the usual project checks on the saved baseline too
  // A valid current scene doesn't tell us whether this older copy is still usable
  const confirmed = deserializeProject(readField(raw, "confirmedJson"), assetKinds);
  if (!confirmed.ok) return confirmed;
  if (confirmed.value.projectId !== projectId)
    return invalid("recovery.serverSave", "Server recovery belongs to a different project");
  const baseline = serializeProject(confirmed.value, assetKinds);
  if (!baseline.ok) return baseline;
  let pending: ServerSaveRecovery["pending"] = null;
  const pendingSave = readField(raw, "pending");
  if (pendingSave !== null) {
    if (!isRecord(pendingSave))
      return invalid("recovery.serverSave.pending", "Invalid pending save");
    const pendingFields = checkFields(
      pendingSave,
      ["clientMutationId", "documentJson"],
      "recovery.serverSave.pending",
    );
    if (!pendingFields.ok) return pendingFields;
    const clientMutationId = readField(pendingSave, "clientMutationId");
    const documentJson = readField(pendingSave, "documentJson");
    // The server expects a UUID for the mutation and room for one more revision
    if (
      revision === Number.MAX_SAFE_INTEGER ||
      typeof clientMutationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientMutationId)
    )
      return invalid("recovery.serverSave.pending", "Invalid pending save identity");
    // Pending data may be older than the latest offline edits
    // It still needs to belong to the same project before we can retry it
    const document = deserializeProject(documentJson, assetKinds);
    if (!document.ok) return document;
    if (document.value.projectId !== projectId)
      return invalid("recovery.serverSave.pending", "Pending save belongs to a different project");
    pending = Object.freeze({
      clientMutationId,
      // Validation above bounds the JSON and checks its contents
      // Preserve the stored text instead of reformatting an uncertain request
      documentJson: documentJson as string,
    });
  }
  return {
    ok: true,
    value: Object.freeze({
      revision,
      confirmedJson: baseline.value,
      pending,
    }),
  };
}
