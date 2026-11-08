import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useModal } from "../../shared/ui/useModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMusic, faXmark } from "@fortawesome/free-solid-svg-icons";
import { generateLibraryPreviews } from "../graphics/library-previews";
import { assetPreviewKey, assetPreviewSource } from "./asset-previews";
import type {
  AssetAdministrationData,
  AssetAdministrationService,
  AssetCandidate,
} from "./asset-administration";
import "./asset-administration.css";
import { AssetSelect } from "./AssetSelect";

type Props = {
  session: { userId: string; role: string; mustChangePassword: boolean } | null;
  service: AssetAdministrationService;
  kind: AssetCandidate["kind"];
  initialUpload?: boolean;
  onClose: () => void;
};
type Notice = { kind: "denied" | "unavailable" | "invalid"; message: string };
type Selection = { kind: "upload" } | { kind: "detail"; id: string } | null;

// Mount after resolving the current account in the admin shell
// Remount on account changes so one admin cannot inherit another account's list or file input
export function AssetAdministration(props: Props) {
  if (
    !props.session ||
    props.session.role !== "Administrator" ||
    props.session.mustChangePassword
  ) {
    return (
      <section className="asset-admin asset-admin-denied" role="alert">
        <h1>Access denied</h1>
        <p>Sign in with an unrestricted admin account to manage assets.</p>
        <button onClick={props.onClose}>Back</button>
      </section>
    );
  }
  return <AssetAdministrationScreen key={`${props.session.userId}:${props.kind}`} {...props} />;
}

function AssetAdministrationScreen({ service, kind, onClose, initialUpload }: Props) {
  // Keep returned records, view filters and the unsent form separate so retries preserve user input
  const [data, setData] = useState<AssetAdministrationData | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [selection, setSelection] = useState<Selection>(initialUpload ? { kind: "upload" } : null);
  const [file, setFile] = useState<File | null>(null);
  const [uploadKind, setUploadKind] = useState(kind);
  const [audioPreview, setAudioPreview] = useState<string | null>(null);
  const [audioPreviewError, setAudioPreviewError] = useState(false);
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [removeFromProjects, setRemoveFromProjects] = useState(false);
  const [review, setReview] = useState({ source: "", license: "", reviewNotes: "" });
  const dialog = useModal(selection !== null);
  const operation = useRef<AbortController | null>(null);
  const [previews, setPreviews] = useState<Readonly<Record<string, string>>>({});
  const previewCache = useRef(new Set<string>());
  const previewAssets = useMemo(
    () =>
      (data?.assets ?? [])
        .filter((asset) => asset.kind === kind)
        .map(assetPreviewSource)
        .filter((asset) => asset !== null),
    [data?.assets, kind],
  );

  // Scope images to this account/screen, reuse immutable previews across filter and availability
  // changes, and cancel outstanding GLB loads when navigating away or replacing the list.
  useEffect(() => {
    const missing = previewAssets.filter(
      (asset) => !previewCache.current.has(assetPreviewKey(asset)),
    );
    if (missing.length === 0) return;
    const keys = new Map(missing.map((asset) => [asset.id, assetPreviewKey(asset)]));
    let active = true;
    const cancel = generateLibraryPreviews(missing, (id, image) => {
      const key = keys.get(id);
      if (!active || !key) return;
      previewCache.current.add(key);
      setPreviews((current) => ({ ...current, [key]: image }));
    });
    return () => {
      active = false;
      cancel();
    };
  }, [previewAssets]);

  // Read fresh state when the host changes its service or the admin retries a failed load
  // Ignore aborted responses so a closed screen cannot publish stale data into its replacement
  useEffect(() => {
    const controller = new AbortController();
    void service
      .load(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) {
          return;
        }
        if (result.ok) {
          setData(result.value);
          if (initialUpload) setCategory(result.value.policy.categories[kind]?.[0] ?? "");
          setNotice(null);
        } else {
          setNotice(result);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setNotice({
            kind: "unavailable",
            message: "Assets could not be loaded. Please try again.",
          });
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [service, reload, initialUpload, kind]);

  // Default to the safe action when details become a destructive confirmation
  useEffect(() => {
    if (confirmation) {
      dialog.current?.querySelector<HTMLButtonElement>(".asset-admin-actions > button")?.focus();
    }
  }, [confirmation, dialog]);

  // Keep search and visibility filters outside the returned records
  // Opening a detail view still resolves its stable ID from the full list
  const items =
    data?.assets.filter(
      (asset) => asset.kind === kind || (kind === "model" && asset.kind === "audio"),
    ) ?? [];
  const visible = items.filter(
    (asset) =>
      asset.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (tab === "deleted"
        ? asset.deleted
        : !asset.deleted && (tab === "all" || (tab === "hidden" ? asset.hidden : !asset.hidden))),
  );
  const selected =
    selection?.kind === "detail" ? items.find((asset) => asset.id === selection.id) : null;
  const title = kind === "environment" ? "All 3D Spaces" : "All Assets";
  const noun = kind === "environment" ? "3D spaces" : "assets";
  const filtered = query.trim().length > 0 || tab !== "all";
  // Spaces use the small fixed catalogue without category filtering
  const categoryChoices =
    uploadKind === "environment" ? null : (data?.policy.categories[uploadKind] ?? null);
  const extensions =
    data?.policy.extensions.filter((extension) =>
      uploadKind === "audio" ? extension === ".m4a" : extension === ".glb",
    ) ?? [];
  const canSubmit = data?.policy.canSubmitByKind?.[uploadKind] ?? data?.policy.canSubmit;
  const canOpenUpload =
    kind === "model"
      ? (data?.policy.canSubmitByKind?.model ?? data?.policy.canSubmit) ||
        (data?.policy.canSubmitByKind?.audio ?? false)
      : (data?.policy.canSubmitByKind?.[kind] ?? data?.policy.canSubmit);
  const audioEnabled =
    data?.policy.extensions.includes(".m4a") && !!data.policy.categories.audio?.length;

  // Load approved audio through the captured account and release its bytes when the details close
  useEffect(() => {
    if (selected?.kind !== "audio" || selected.status !== "approved" || !selected.inspectionUrl)
      return;
    const controller = new AbortController();
    let url: string | null = null;
    void service
      .download(selected.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setAudioPreviewError(true);
          return;
        }
        url = URL.createObjectURL(result.value);
        setAudioPreview(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAudioPreviewError(true);
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [selected, service]);

  // Start each upload with fresh fields while keeping the loaded catalogue intact
  function openUpload() {
    setUploadKind(kind);
    setFile(null);
    setReview({ source: "", license: "", reviewNotes: "" });
    setCategory(data?.policy.categories[kind]?.[0] ?? "");
    setNotice(null);
    setConfirmation(false);
    setRemoveFromProjects(false);
    setSelection({ kind: "upload" });
  }

  function closeDialog() {
    // Keep the selected file and draft fields in place while a server response is pending
    if (busy) {
      return;
    }
    // Cancel the destructive step first so the same asset details remain open
    if (confirmation) {
      setConfirmation(false);
      setRemoveFromProjects(false);
      setNotice(null);
      return;
    }
    setSelection(null);
    // Discard only this dialog's review fields after an explicit close
    setReview({ source: "", license: "", reviewNotes: "" });
    setNotice(null);
    setConfirmation(false);
    setRemoveFromProjects(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (selection?.kind !== "upload" || busy || !data || !canSubmit) {
      return;
    }
    // Client checks provide immediate feedback; the intake endpoint must repeat validation on bytes
    const extension = file?.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (
      !file ||
      file.size === 0 ||
      file.size > data.policy.maxBytes ||
      !extensions.includes(extension ?? "") ||
      (categoryChoices !== null && !categoryChoices.includes(category))
    ) {
      setNotice({
        kind: "invalid",
        message: "Choose a supported file within the size limit and a filter category.",
      });
      return;
    }
    await mutate(async (signal) =>
      service.submit(
        { file, kind: uploadKind, category: categoryChoices === null ? null : category, review },
        signal,
      ),
    );
  }

  // Offer only actions permitted for this record and require a second step for deletion
  async function changeAvailability(action: "hide" | "show" | "delete" | "remove") {
    if (!selected?.actions.includes(action) || busy) {
      return;
    }
    if ((action === "delete" || action === "remove") && !confirmation) {
      setConfirmation(true);
      return;
    }
    await mutate((signal) =>
      service.changeAvailability(
        selected.id,
        action,
        signal,
        action === "remove" || (action === "delete" && removeFromProjects),
      ),
    );
  }

  async function mutate(
    send: (signal: AbortSignal) => ReturnType<AssetAdministrationService["changeAvailability"]>,
  ) {
    // Bind this request to the mounted screen; account changes abort it before a stale result can apply
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setNotice(null);
    setOutcome("");
    try {
      const result = await send(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      if (!result.ok) {
        setNotice(result);
        return;
      }
      // Replace only the confirmed record; failed mutations leave the list and form unchanged
      const confirmed = result.value;
      setData(
        (current) =>
          current && {
            ...current,
            assets: current.assets.some((asset) => asset.id === confirmed.id)
              ? current.assets.map((asset) => (asset.id === confirmed.id ? confirmed : asset))
              : [...current.assets, confirmed],
          },
      );
      setSelection(null);
      setReview({ source: "", license: "", reviewNotes: "" });
      setFile(null);
      setConfirmation(false);
      setRemoveFromProjects(false);
      // Announce the confirmed state after closing the form; uploaded candidates can still be pending
      setOutcome(
        `${confirmed.name}: ${
          confirmed.deleted
            ? confirmed.removedFromProjects
              ? "removed from all projects and exhibitions"
              : "deleted from library"
            : confirmed.status === "approved"
              ? confirmed.hidden
                ? "hidden"
                : "available"
              : confirmed.status
        }`,
      );
    } catch {
      if (!controller.signal.aborted) {
        setNotice({
          kind: "unavailable",
          message: "The change could not be confirmed. Please try again.",
        });
      }
    } finally {
      // Only the active screen clears its pending state after a completed or failed request
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }

  async function downloadSelected() {
    if (!selected || busy) {
      return;
    }
    const asset = selected;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setNotice(null);
    try {
      const result = await service.download(asset.id, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      if (!result.ok) {
        setNotice(result);
        return;
      }

      // Let the browser save the original bytes without navigating away from the administrator's form
      const url = URL.createObjectURL(result.value);
      const link = document.createElement("a");
      link.href = url;
      const extension = asset.kind === "audio" ? ".m4a" : ".glb";
      const name = asset.name.replace(/[/\\]/g, "-");
      link.download = name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (!controller.signal.aborted) {
        setNotice({ kind: "unavailable", message: "Download failed. Please try again" });
      }
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }

  function thumbnail(asset: AssetCandidate) {
    if (asset.kind === "audio") {
      return (
        <span className="asset-admin-audio-icon">
          <FontAwesomeIcon icon={faMusic} aria-hidden="true" />
          <span className="asset-admin-sr">Audio</span>
        </span>
      );
    }
    // Accept local delivery paths only; candidate metadata must not trigger arbitrary remote requests
    if (asset.thumbnail?.startsWith("/")) {
      try {
        const url = new URL(asset.thumbnail, location.origin);
        if (url.origin === location.origin) {
          return <img src={url.href} alt="" loading="lazy" />;
        }
      } catch {
        // Invalid preview metadata must leave the candidate details usable
      }
    }
    const source = assetPreviewSource(asset);
    const generated = source && previews[assetPreviewKey(source)];
    if (generated) return <img src={generated} alt="" />;
    return <span className="asset-admin-placeholder" aria-hidden="true" />;
  }

  return (
    <section
      className={`asset-admin ${kind === "model" ? "asset-admin-models" : ""}`}
      aria-labelledby="asset-admin-heading"
    >
      <div className="asset-admin-heading">
        <div>
          <h1 id="asset-admin-heading">{title}</h1>
          <p>Review published experiences and control what visitors can explore.</p>
        </div>
        <label className="asset-admin-search">
          <span className="asset-admin-sr">Search {noun}</span>
          <input
            type="search"
            placeholder={`Search ${noun}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <svg
            aria-hidden="true"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="10" cy="10" r="7" />
            <path d="m15 15 6 6" />
          </svg>
        </label>
        <button
          className="asset-admin-close sp-close-button"
          aria-label="Close asset administration"
          onClick={onClose}
        >
          <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
        </button>
      </div>
      <div className="asset-admin-toolbar">
        <div className="asset-admin-tabs" aria-label="Asset visibility">
          {(
            [
              [
                "all",
                kind === "environment" ? "All Spaces" : "All Assets",
                items.filter((a) => !a.deleted).length,
              ],
              ["visible", "Public", items.filter((a) => !a.deleted && !a.hidden).length],
              ["hidden", "Private", items.filter((a) => !a.deleted && a.hidden).length],
              ["deleted", "Deleted", items.filter((a) => a.deleted).length],
            ] as const
          ).map(([value, label, count]) => (
            <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
              {label} ({count})
            </button>
          ))}
        </div>
        <button
          className="asset-admin-primary"
          disabled={!canOpenUpload || loading || notice?.kind === "denied"}
          onClick={openUpload}
        >
          + Add {kind === "environment" ? "3D Space" : "Assets"}
        </button>
      </div>
      <p className="asset-admin-sr" role="status">
        {outcome}
      </p>
      <div className="asset-admin-scroll" tabIndex={0} role="region" aria-label={`${noun} list`}>
        {loading ? (
          <div className="asset-admin-grid" role="status" aria-label="Loading assets">
            {[0, 1, 2].map((id) => (
              <div key={id} className="asset-admin-skeleton" />
            ))}
          </div>
        ) : notice && !selection ? (
          <div className="asset-admin-state" role="alert">
            <h2>
              {notice.kind === "denied"
                ? "Access denied"
                : `${kind === "environment" ? "Spaces" : "Assets"} unavailable`}
            </h2>
            <p>{notice.message}</p>
            {notice.kind !== "denied" && (
              <button
                onClick={() => {
                  setLoading(true);
                  setReload((n) => n + 1);
                }}
              >
                Try Again
              </button>
            )}
          </div>
        ) : (
          <div className="asset-admin-grid">
            {visible.map((asset) => (
              <article className="asset-admin-card" key={asset.id}>
                <div className="asset-admin-thumbnail">{thumbnail(asset)}</div>
                <div className="asset-admin-card-content">
                  <div>
                    <h2>{asset.name}</h2>
                    <span className="asset-admin-visibility">
                      {asset.status === "approved" && (
                        <svg
                          aria-hidden="true"
                          width="13"
                          height="13"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        >
                          {asset.hidden ? (
                            <>
                              <path d="m3 3 18 18M10 5a12 12 0 0 1 11 7 15 15 0 0 1-4 5M7 7a15 15 0 0 0-4 5c3 6 9 9 15 5" />
                              <path d="M10 10a3 3 0 0 0 4 4" />
                            </>
                          ) : (
                            <>
                              <circle cx="12" cy="12" r="9" />
                              <ellipse cx="12" cy="12" rx="4" ry="9" />
                              <path d="M3 12h18" />
                            </>
                          )}
                        </svg>
                      )}
                      {asset.deleted
                        ? "Deleted"
                        : asset.status === "approved"
                          ? asset.hidden
                            ? "Private"
                            : "Public"
                          : asset.status}
                    </span>
                  </div>
                  <button
                    className="asset-admin-primary"
                    onClick={() => {
                      setNotice(null);
                      setConfirmation(false);
                      setRemoveFromProjects(false);
                      setAudioPreview(null);
                      setAudioPreviewError(false);
                      setSelection({ kind: "detail", id: asset.id });
                    }}
                  >
                    View{" "}
                    {kind === "environment" && asset.status === "approved" ? "Model" : "Details"}
                    <span className="asset-admin-sr">: {asset.name}</span>
                  </button>
                </div>
              </article>
            ))}
            {visible.length === 0 && (
              <div className="asset-admin-state">
                <h2>{filtered ? `No matching ${noun}` : `No ${noun} yet`}</h2>
                <p>
                  {filtered
                    ? "Try another name or visibility filter."
                    : kind === "environment"
                      ? "Add a 3D space to submit it for validation."
                      : "Add an asset to submit it for validation."}
                </p>
                {(query || tab !== "all") && (
                  <button
                    onClick={() => {
                      setQuery("");
                      setTab("all");
                    }}
                  >
                    Reset Search
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <dialog
        ref={dialog}
        className={`asset-admin-dialog${selection?.kind === "upload" ? " asset-admin-dialog-upload" : ""}${selection?.kind === "detail" ? " asset-admin-dialog-detail" : ""}${confirmation ? " asset-admin-dialog-confirmation" : ""}`}
        aria-labelledby="asset-dialog-heading"
        onCancel={(event) => {
          // File chooser cancellation also bubbles here; only close for the dialog’s own Escape event
          if (event.target !== event.currentTarget) {
            return;
          }
          event.preventDefault();
          closeDialog();
        }}
      >
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          aria-busy={busy}
        >
          <div className="asset-admin-dialog-heading">
            <h2 id="asset-dialog-heading">
              {confirmation
                ? selected?.deleted
                  ? "Remove asset?"
                  : "Delete asset?"
                : (selected?.name ??
                  (kind === "environment" ? "Upload 3D Space" : "Upload Assets"))}
            </h2>
            <button
              type="button"
              className="asset-admin-close sp-close-button"
              aria-label="Close asset details"
              disabled={busy}
              onClick={closeDialog}
            >
              <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
            </button>
          </div>
          {!confirmation && (
            <>
              {selection?.kind === "upload" ? (
                <label
                  className="asset-admin-upload"
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = busy ? "none" : "copy";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (busy) return;
                    const files = event.dataTransfer.files;
                    if (files.length !== 1) {
                      setNotice({ kind: "invalid", message: "Drop one file at a time." });
                      return;
                    }
                    const chosen = files.item(0);
                    if (chosen) {
                      setFile(chosen);
                      setNotice(null);
                    }
                  }}
                >
                  <span className="asset-admin-upload-symbol" aria-hidden="true">
                    <svg
                      width="44"
                      height="44"
                      viewBox="0 0 44 44"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path
                        d="M3 24h38v11a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V24Z"
                        fill="var(--aa-upload-tray)"
                      />
                      <path d="M22 32V3m-10 10L22 3l10 10" />
                    </svg>
                  </span>
                  <span>
                    {file?.name ??
                      `Drop a ${uploadKind === "audio" ? "M4A" : "GLB"} file here or choose a file`}
                  </span>
                  <span className="asset-admin-help">
                    {data
                      ? `${extensions.join(" / ")} files, up to ${Math.floor(data.policy.maxBytes / 1024 / 1024)} MB`
                      : ""}
                  </span>
                  <input
                    aria-label="Choose asset file"
                    type="file"
                    key={uploadKind}
                    accept={extensions.join(",")}
                    disabled={busy}
                    onChange={(e) => {
                      // Keep the last selection when closing the file chooser without choosing a new file
                      const chosen = e.target.files?.[0];
                      if (chosen) {
                        setFile(chosen);
                        setNotice(null);
                      }
                    }}
                  />
                </label>
              ) : (
                selected && (
                  <div className="asset-admin-detail-preview">
                    {thumbnail(selected)}
                    {selected.kind === "audio" &&
                      selected.status === "approved" &&
                      selected.inspectionUrl &&
                      (audioPreview ? (
                        <audio
                          controls
                          preload="metadata"
                          src={audioPreview}
                          aria-label={`Preview ${selected.name}`}
                          onError={() => setAudioPreviewError(true)}
                        />
                      ) : (
                        !audioPreviewError && <p>Loading audio preview…</p>
                      ))}
                    {audioPreviewError && (
                      <p role="alert">
                        Audio preview is unavailable. You can download the file instead.
                      </p>
                    )}
                  </div>
                )
              )}
              <h3>Asset Details</h3>
              {selection && (
                <div className="asset-admin-fields">
                  {/* All Assets accepts models and audio; the Spaces screen stays fixed */}
                  {selection?.kind === "upload" && kind === "model" && (
                    <AssetSelect
                      label="Asset Type"
                      value={uploadKind}
                      disabled={busy}
                      options={[
                        { value: "model", label: "3D Model" },
                        ...(audioEnabled ? [{ value: "audio", label: "Audio" }] : []),
                      ]}
                      onChange={(value) => {
                        const nextKind = value === "audio" ? "audio" : "model";
                        setUploadKind(nextKind);
                        setFile(null);
                        setCategory(data?.policy.categories[nextKind]?.[0] ?? "");
                        setNotice(null);
                      }}
                    />
                  )}
                  {(selection?.kind === "detail" || kind === "environment") && (
                    <div className="asset-admin-select">
                      <span id="asset-admin-type-label">Asset Type</span>
                      <output aria-labelledby="asset-admin-type-label">
                        {selected?.kind === "audio"
                          ? "Audio"
                          : kind === "environment"
                            ? "3D Space"
                            : "3D Model"}
                      </output>
                    </div>
                  )}
                  {kind === "environment" && (
                    <div className="asset-admin-select">
                      <span id="asset-admin-category-label">Filter Category</span>
                      <output aria-labelledby="asset-admin-category-label">Not applicable</output>
                    </div>
                  )}
                  {kind === "model" && selection?.kind === "detail" && (
                    <div className="asset-admin-select">
                      <span id="asset-admin-category-label">Filter Category</span>
                      <output aria-labelledby="asset-admin-category-label">
                        {selected?.category ?? "Not configured"}
                      </output>
                    </div>
                  )}
                  {kind === "model" && selection?.kind === "upload" && (
                    <AssetSelect
                      label="Filter Category"
                      disabled={busy || selection?.kind !== "upload" || categoryChoices === null}
                      value={selected ? (selected.category ?? "") : category}
                      options={(selected?.category
                        ? [selected.category]
                        : (categoryChoices ?? [])
                      ).map((value) => ({ value, label: value }))}
                      placeholder="Not configured"
                      onChange={setCategory}
                    />
                  )}
                </div>
              )}
              {selected?.status === "approved" &&
                (selected.source || selected.license || selected.reviewNotes) && (
                  <dl className="asset-admin-review">
                    <div>
                      <dt>Source or provenance</dt>
                      <dd>{selected.source || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Redistribution licence</dt>
                      <dd>{selected.license || "Not provided"}</dd>
                    </div>
                    <div>
                      <dt>Content review notes</dt>
                      <dd>{selected.reviewNotes || "Not provided"}</dd>
                    </div>
                  </dl>
                )}
              {/* Keep review statements separate from technical validation and retain them after a failed request */}
              {selected && !selected.deleted && selected.status === "pending" && !confirmation && (
                <fieldset className="asset-admin-review" disabled={busy}>
                  <legend>Approval review</legend>
                  <p>These details are optional. You can approve without filling them in.</p>
                  {(
                    [
                      ["source", "Source or provenance"],
                      ["license", "Redistribution licence"],
                      ["reviewNotes", "Content review notes"],
                    ] as const
                  ).map(([field, label]) => (
                    <label className="asset-admin-select" key={field}>
                      <span>{label} (optional)</span>
                      <input
                        value={review[field]}
                        maxLength={2000}
                        onChange={(event) =>
                          setReview((current) => ({ ...current, [field]: event.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className="asset-admin-primary"
                    onClick={() => {
                      void mutate((signal) => service.review(selected.id, review, signal));
                    }}
                  >
                    Approve
                  </button>
                </fieldset>
              )}
              {selected?.deleted && (
                <p className="asset-admin-retired-status">
                  {selected.removedFromProjects
                    ? "Removed from all projects and exhibitions."
                    : "Deleted from library; still kept in existing projects and exhibitions."}
                </p>
              )}
              {selected && (selected.status !== "approved" || selected.validation.length > 0) && (
                <div className="asset-admin-validation">
                  <p>
                    Status: <strong>{selected.status}</strong>
                  </p>
                  {selected.validation.length > 0 && (
                    <ul aria-label="Validation results">
                      {selected.validation.map((message, i) => (
                        <li key={i}>{message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
          {notice && (
            <p className="asset-admin-message" role="alert">
              {notice.message}
            </p>
          )}
          {confirmation && (
            <div className="asset-admin-confirmation-content">
              <p role="alert">
                <strong>{selected?.name}</strong>
                {selected?.deleted
                  ? " will be removed from every project and exhibition that uses it."
                  : " will move to Deleted and disappear from the student library."}
              </p>
              {/* Keep both outcomes in the same text slot so toggling never moves the checkbox */}
              {!selected?.deleted && (
                <p
                  className={`asset-admin-confirmation-outcome ${removeFromProjects ? "asset-admin-confirmation-warning" : "asset-admin-confirmation-hint"}`}
                  role={removeFromProjects ? "alert" : undefined}
                >
                  {removeFromProjects
                    ? "Existing uses will be removed. This cannot be undone."
                    : "Existing projects and exhibitions keep this asset."}
                </p>
              )}
              {!selected?.deleted && data?.policy.canForceRemove && (
                <label className="asset-admin-force-removal">
                  <input
                    type="checkbox"
                    checked={removeFromProjects}
                    disabled={busy || !data?.policy.canForceRemove}
                    onChange={(event) => setRemoveFromProjects(event.target.checked)}
                  />
                  <span>Remove from Existing Projects and Exhibitions</span>
                </label>
              )}
              {selected?.deleted && (
                <p className="asset-admin-confirmation-warning" role="alert">
                  This cannot be undone.
                </p>
              )}
            </div>
          )}
          <div className="asset-admin-actions">
            {selection?.kind === "upload" && (
              <details className="asset-admin-metadata">
                <summary>Additional Details</summary>
                <fieldset className="asset-admin-review" disabled={busy}>
                  <legend className="asset-admin-sr">Optional asset details</legend>
                  {(
                    [
                      ["source", "Source or provenance"],
                      ["license", "Redistribution licence"],
                      ["reviewNotes", "Content review notes"],
                    ] as const
                  ).map(([field, label]) => (
                    <label className="asset-admin-select" key={field}>
                      <span>{label} (optional)</span>
                      <input
                        value={review[field]}
                        maxLength={2000}
                        onChange={(event) =>
                          setReview((current) => ({ ...current, [field]: event.target.value }))
                        }
                      />
                    </label>
                  ))}
                </fieldset>
              </details>
            )}
            {selected?.inspectionUrl && !confirmation && (
              <a
                className="asset-admin-text-link"
                href={selected.inspectionUrl}
                download
                aria-disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void downloadSelected();
                }}
              >
                {busy ? "Please Wait…" : "Download File"}
              </a>
            )}
            <button type="button" disabled={busy} onClick={closeDialog}>
              Cancel
            </button>
            {selection?.kind === "upload" ? (
              <button
                className="asset-admin-primary"
                disabled={busy || !file || !canSubmit}
                type="submit"
              >
                {busy ? "Submitting…" : "Save Changes"}
              </button>
            ) : (
              selected?.actions
                .filter(
                  (action) =>
                    (action !== "remove" || data?.policy.canForceRemove) &&
                    (!confirmation || action === "delete" || action === "remove"),
                )
                .map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={
                      action === "delete" || action === "remove" ? "asset-admin-danger" : ""
                    }
                    disabled={busy || (action === "remove" && !data?.policy.canForceRemove)}
                    onClick={() => {
                      void changeAvailability(action);
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {action === "delete" || action === "remove" ? (
                        <>
                          <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 10v7m4-7v7" />
                        </>
                      ) : action === "show" ? (
                        <>
                          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
                          <circle cx="12" cy="12" r="3" />
                        </>
                      ) : (
                        <>
                          <path d="m3 3 18 18M10 5a12 12 0 0 1 11 7 15 15 0 0 1-4 5M7 7a15 15 0 0 0-4 5c3 6 9 9 15 5" />
                          <path d="M10 10a3 3 0 0 0 4 4" />
                        </>
                      )}
                    </svg>
                    {busy
                      ? "Saving…"
                      : action === "remove"
                        ? confirmation
                          ? "Confirm Removal"
                          : "Remove from Existing Projects and Exhibitions"
                        : action === "delete"
                          ? confirmation
                            ? "Confirm Delete"
                            : "Delete"
                          : action === "hide"
                            ? "Hide"
                            : "Show"}
                  </button>
                ))
            )}
          </div>
        </form>
      </dialog>
    </section>
  );
}
