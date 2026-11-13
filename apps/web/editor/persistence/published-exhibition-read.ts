import { createAccountClient } from "../accounts/account-client";
import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";
import { knownRoomGeometry } from "../../shared/asset-runtime/catalogue";
import { deserializeProject } from "../../shared/project/project-deserialization";
import { MAX_PROJECT_BYTES } from "../../shared/project/project-limits";
import { isId, isRecord } from "../home/workspace-api";
import type { OpenedServerProject } from "./server-project-read";

export async function readPublishedExhibition(
  projectId: string,
  accountId: string,
  signal: AbortSignal,
) {
  if (!isId(projectId)) throw new Error("Invalid project identity.");
  const accounts = createAccountClient();
  const identity = await accounts.getSession();
  if (
    identity?.userId !== accountId ||
    identity.mustChangePassword ||
    !["Administrator", "Educator"].includes(identity.role)
  )
    throw new Error("Sign in to view this exhibition.");
  const response = await fetch(`/api/v1/projects/${projectId}/exhibition`, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
    headers: { "X-Spatia-Account": accountId },
  });
  if (!response.ok) throw new Error("The published exhibition is unavailable. Try again.");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > MAX_PROJECT_BYTES + 32 * 1024 * 1024)
    throw new Error("The published exhibition exceeds the supported size.");
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.projectId !== projectId ||
    !isId(value.publicationId) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.assets) ||
    value.assets.length > 100000
  )
    throw new Error("The published exhibition returned invalid details.");
  const publicationId = value.publicationId;
  const seen = new Set<string>();
  const assets: CatalogueAsset[] = value.assets.map((asset: unknown) => {
    if (
      !isRecord(asset) ||
      typeof asset.id !== "string" ||
      seen.has(asset.id) ||
      typeof asset.name !== "string" ||
      !asset.name.trim() ||
      !["environment", "model", "image", "audio", "video"].includes(String(asset.kind)) ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      asset.url !==
        `/api/v1/projects/${projectId}/exhibitions/${publicationId}/assets/${encodeURIComponent(asset.id)}/bytes` ||
      (asset.category !== null && typeof asset.category !== "string")
    )
      throw new Error("The exhibition assets could not be verified.");
    seen.add(asset.id);
    const geometry = knownRoomGeometry[asset.sha256];
    return {
      id: asset.id,
      name: asset.name,
      kind: asset.kind as CatalogueAsset["kind"],
      sha256: asset.sha256,
      url: asset.url as string,
      thumbnail: null,
      ...(typeof asset.category === "string" ? { category: asset.category } : {}),
      ...(geometry
        ? { boundsMeters: geometry, placement: "bottom-center" as const }
        : asset.placement === "bottom-center"
          ? { placement: "bottom-center" as const }
          : {}),
    };
  });
  const document = deserializeProject(
    JSON.stringify(value.document),
    new Map(assets.map((asset) => [asset.id, asset.kind])),
  );
  if (!document.ok || document.value.projectId !== projectId)
    throw new Error("The published exhibition content is invalid.");
  const current = await accounts.getSession();
  if (
    signal.aborted ||
    current?.userId !== accountId ||
    current.role !== identity.role ||
    current.mustChangePassword
  )
    throw new Error("Your account changed. Sign in again to view the exhibition.");
  const opened: OpenedServerProject = {
    accountId,
    document: document.value,
    revision: value.revision as number,
    canEdit: false,
  };
  return { opened, assets };
}
