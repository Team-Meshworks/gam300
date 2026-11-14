import type { CatalogueAsset } from "../../shared/asset-runtime/catalogue";

// Keep candidate state separate from catalogue availability until the server approves an asset
export type AssetCandidate = Readonly<{
  id: string;
  name: string;
  kind: CatalogueAsset["kind"];
  category: string | null;
  inspectionUrl?: string | null;
  sha256?: string;
  source?: string | null;
  license?: string | null;
  reviewNotes?: string | null;
  status: "pending" | "approved" | "invalid" | "unavailable";
  hidden: boolean;
  // Retain deleted records for later administrative removal from existing uses
  deleted: boolean;
  removedFromProjects: boolean;
  thumbnail: CatalogueAsset["thumbnail"];
  validation: readonly string[];
  actions: readonly ("hide" | "show" | "delete" | "remove")[];
}>;

// Fetch limits and choices with the list so the form follows the deployed intake policy
// Keep the HTTP adapter and local preview on the same confirmed-record contract
export type AssetAdministrationData = Readonly<{
  assets: readonly AssetCandidate[];
  policy: Readonly<{
    extensions: readonly string[];
    maxBytes: number;
    // Null leaves a kind unconfigured; All belongs to browsing and is never saved as a category
    categories: Readonly<Partial<Record<CatalogueAsset["kind"], readonly string[] | null>>>;
    canSubmit: boolean;
    canSubmitByKind?: Readonly<Partial<Record<CatalogueAsset["kind"], boolean>>>;
    canForceRemove: boolean;
  }>;
}>;

// Preserve server failures as distinct states so the screen can retry without inventing a successful save
export type AssetAdministrationResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "denied" | "unavailable" | "invalid" | "unknown"; message: string };

// Return authoritative records after mutations; screens never infer approval from an upload
// Implementations must enforce account permissions and validate bytes on the server
export interface AssetAdministrationService {
  load(signal: AbortSignal): Promise<AssetAdministrationResult<AssetAdministrationData>>;
  download(id: string, signal: AbortSignal): Promise<AssetAdministrationResult<Blob>>;
  submit(
    input: {
      file: File;
      kind: CatalogueAsset["kind"];
      category: string | null;
      review: { source: string; license: string; reviewNotes: string };
    },
    signal: AbortSignal,
  ): Promise<AssetAdministrationResult<AssetCandidate>>;
  review(
    id: string,
    input: { source: string; license: string; reviewNotes: string },
    signal: AbortSignal,
  ): Promise<AssetAdministrationResult<AssetCandidate>>;
  changeAvailability(
    id: string,
    action: "hide" | "show" | "delete" | "remove",
    signal: AbortSignal,
    removeFromProjects?: boolean,
  ): Promise<AssetAdministrationResult<AssetCandidate>>;
}
