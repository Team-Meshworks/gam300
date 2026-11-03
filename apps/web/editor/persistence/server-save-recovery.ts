import { serializeProject } from "../../shared/project/project-serialization";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { checkFields, invalid, isRecord } from "../../shared/project/validation-helpers";
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
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 0)
    return invalid("recovery.serverSave.revision", "Invalid server revision");
  // Run the usual project checks on the saved baseline too
  // A valid current scene doesn't tell us whether this older copy is still usable
  const confirmed = deserializeProject(raw.confirmedJson, assetKinds);
  if (!confirmed.ok) return confirmed;
  if (confirmed.value.projectId !== projectId)
    return invalid("recovery.serverSave", "Server recovery belongs to a different project");
  const baseline = serializeProject(confirmed.value, assetKinds);
  if (!baseline.ok) return baseline;
  let pending: ServerSaveRecovery["pending"] = null;
  if (raw.pending !== null) {
    if (!isRecord(raw.pending))
      return invalid("recovery.serverSave.pending", "Invalid pending save");
    const pendingFields = checkFields(
      raw.pending,
      ["clientMutationId", "documentJson"],
      "recovery.serverSave.pending",
    );
    if (!pendingFields.ok) return pendingFields;
    // The server expects a UUID for the mutation and room for one more revision
    if (
      raw.revision === Number.MAX_SAFE_INTEGER ||
      typeof raw.pending.clientMutationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        raw.pending.clientMutationId,
      )
    )
      return invalid("recovery.serverSave.pending", "Invalid pending save identity");
    // Pending data may be older than the latest offline edits
    // It still needs to belong to the same project before we can retry it
    const document = deserializeProject(raw.pending.documentJson, assetKinds);
    if (!document.ok) return document;
    if (document.value.projectId !== projectId)
      return invalid("recovery.serverSave.pending", "Pending save belongs to a different project");
    pending = Object.freeze({
      clientMutationId: raw.pending.clientMutationId,
      // Validation above bounds the JSON and checks its contents
      // Preserve the stored text instead of reformatting an uncertain request
      documentJson: raw.pending.documentJson as string,
    });
  }
  return {
    ok: true,
    value: Object.freeze({
      revision: raw.revision,
      confirmedJson: baseline.value,
      pending,
    }),
  };
}
