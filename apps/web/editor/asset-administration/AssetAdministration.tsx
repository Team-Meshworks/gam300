import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
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

function AssetAdministrationScreen({ service, kind, onClose }: Props) {
  // Keep returned records, view filters and the unsent form separate so retries preserve user input
  const [data, setData] = useState<AssetAdministrationData | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [selection, setSelection] = useState<Selection>(null);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  const [removeFromProjects, setRemoveFromProjects] = useState(false);
  const [review, setReview] = useState({ source: "", license: "", reviewNotes: "" });
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);

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
  }, [service, reload]);

  // Native modal behavior keeps keyboard focus inside the dialog and restores its opener on close
  useEffect(() => {
    if (selection && !dialog.current?.open) {
      dialog.current?.showModal();
    }
    if (!selection) {
      dialog.current?.close();
    }
  }, [selection]);

  // Default to the safe action when details become a destructive confirmation
  useEffect(() => {
    if (confirmation) {
      dialog.current?.querySelector<HTMLButtonElement>(".asset-admin-actions > button")?.focus();
    }
  }, [confirmation]);

  // Keep search and visibility filters outside the returned records
  // Opening a detail view still resolves its stable ID from the full list
  const items = data?.assets.filter((asset) => asset.kind === kind) ?? [];
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
  const categoryChoices = kind === "environment" ? null : (data?.policy.categories[kind] ?? null);

  // Start each upload with fresh fields while keeping the loaded catalogue intact
  function openUpload() {
    setFile(null);
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
    if (selection?.kind !== "upload" || busy || !data?.policy.canSubmit) {
      return;
    }
    // Client checks provide immediate feedback; the intake endpoint must repeat validation on bytes
    const extension = file?.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (
      !file ||
      file.size === 0 ||
      file.size > data.policy.maxBytes ||
      !data.policy.extensions.includes(extension ?? "") ||
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
        { file, kind: kind, category: categoryChoices === null ? null : category },
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

  function thumbnail(asset: AssetCandidate) {
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
          <p>Manage and review catalogue assets.</p>
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
          className="asset-admin-close"
          aria-label="Close asset administration"
          onClick={onClose}
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="m7 7 10 10M17 7 7 17" />
          </svg>
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
              ["visible", "Not hidden", items.filter((a) => !a.deleted && !a.hidden).length],
              ["hidden", "Hidden", items.filter((a) => !a.deleted && a.hidden).length],
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
          disabled={!data?.policy.canSubmit || loading || notice?.kind === "denied"}
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
                Try again
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
                            ? "Hidden"
                            : "Available"
                          : asset.status}
                    </span>
                  </div>
                  <button
                    className="asset-admin-primary"
                    onClick={() => {
                      setNotice(null);
                      setConfirmation(false);
                      setRemoveFromProjects(false);
                      setSelection({ kind: "detail", id: asset.id });
                    }}
                  >
                    View{" "}
                    {kind === "environment" && asset.status === "approved" ? "Model" : "details"}
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
                    Reset search
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <dialog
        ref={dialog}
        className={`asset-admin-dialog${selection?.kind === "detail" ? " asset-admin-dialog-detail" : ""}${confirmation ? " asset-admin-dialog-confirmation" : ""}`}
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
                  (kind === "environment" ? "Upload 3D Space" : "Upload 3D Model"))}
            </h2>
            <button
              type="button"
              className="asset-admin-close"
              aria-label="Close asset details"
              disabled={busy}
              onClick={closeDialog}
            >
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="m7 7 10 10M17 7 7 17" />
              </svg>
            </button>
          </div>
          {!confirmation && (
            <>
              {selection?.kind === "upload" ? (
                <label className="asset-admin-upload">
                  <span className="asset-admin-upload-symbol" aria-hidden="true">
                    <svg
                      width="54"
                      height="54"
                      viewBox="0 0 54 54"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M27 37V7m-11 11L27 7l11 11M9 34v12c0 3 2 4 5 4h26c3 0 5-1 5-4V34" />
                    </svg>
                  </span>
                  <span>{file?.name ?? "Choose a file"}</span>
                  <span className="asset-admin-help">
                    {data
                      ? `${data.policy.extensions.join(" / ")} files, up to ${Math.floor(data.policy.maxBytes / 1024 / 1024)} MB`
                      : ""}
                  </span>
                  <input
                    aria-label="Choose asset file"
                    type="file"
                    accept={data?.policy.extensions.join(",")}
                    disabled={busy}
                    onChange={(e) => {
                      // Keep the last selection when closing the file chooser without choosing a new file
                      const chosen = e.target.files?.[0];
                      if (chosen) {
                        setFile(chosen);
                      }
                    }}
                  />
                </label>
              ) : (
                selected && <div className="asset-admin-detail-preview">{thumbnail(selected)}</div>
              )}
              {selection?.kind === "detail" && <h3>Details</h3>}
              {(selection?.kind === "detail" || kind === "model") && (
                <div
                  className={`asset-admin-fields${selection?.kind === "upload" ? " asset-admin-fields-upload" : ""}`}
                >
                  {/* Keep intake tied to the current library so submissions cannot move into another list */}
                  {selection?.kind === "detail" && (
                    <label className="asset-admin-select">
                      <span>Asset Type</span>
                      <input
                        readOnly
                        disabled
                        value={kind === "environment" ? "3D Space" : "3D Model"}
                      />
                    </label>
                  )}
                  {/* Spaces have no categories; show that explicitly without offering an editable filter */}
                  {kind === "environment" && selection?.kind === "detail" && (
                    <label className="asset-admin-select">
                      <span>Filter Category</span>
                      <input readOnly disabled value="Not applicable" />
                    </label>
                  )}
                  {kind === "model" && (
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
              {selected?.status === "approved" && selected.source && (
                <dl className="asset-admin-review">
                  <div>
                    <dt>Source or provenance</dt>
                    <dd>{selected.source}</dd>
                  </div>
                  <div>
                    <dt>Redistribution licence</dt>
                    <dd>{selected.license}</dd>
                  </div>
                  <div>
                    <dt>Content review notes</dt>
                    <dd>{selected.reviewNotes}</dd>
                  </div>
                </dl>
              )}
              {/* Keep review statements separate from technical validation and retain them after a failed request */}
              {selected && !selected.deleted && selected.status === "pending" && !confirmation && (
                <fieldset className="asset-admin-review" disabled={busy}>
                  <legend>Approval review</legend>
                  <p>Confirm content quality and redistribution rights before approval</p>
                  {(
                    [
                      ["source", "Source or provenance"],
                      ["license", "Redistribution licence"],
                      ["reviewNotes", "Content review notes"],
                    ] as const
                  ).map(([field, label]) => (
                    <label className="asset-admin-select" key={field}>
                      <span>{label}</span>
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
                      if (Object.values(review).some((value) => !value.trim())) {
                        setNotice({
                          kind: "invalid",
                          message:
                            "Complete the source, licence and content review before approval",
                        });
                        return;
                      }
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
              {selected?.deleted &&
                !selected.removedFromProjects &&
                !data?.policy.canForceRemove && (
                  <p className="asset-admin-retired-status">
                    Removal from existing projects and exhibitions is currently unavailable
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
              {!selected?.deleted && (
                <label className="asset-admin-force-removal">
                  <input
                    type="checkbox"
                    checked={removeFromProjects}
                    disabled={busy || !data?.policy.canForceRemove}
                    onChange={(event) => setRemoveFromProjects(event.target.checked)}
                  />
                  <span>Remove from all projects and exhibitions</span>
                </label>
              )}
              {selected?.deleted && (
                <p className="asset-admin-confirmation-warning" role="alert">
                  This cannot be undone.
                </p>
              )}
              {!data?.policy.canForceRemove && (
                <p className="asset-admin-confirmation-hint">
                  Removal from existing projects and exhibitions is currently unavailable.
                </p>
              )}
            </div>
          )}
          <div className="asset-admin-actions">
            <button type="button" disabled={busy} onClick={closeDialog}>
              Cancel
            </button>
            {selected?.inspectionUrl && !confirmation && (
              <a className="asset-admin-text-link" href={selected.inspectionUrl} download>
                Download file
              </a>
            )}
            {selection?.kind === "upload" ? (
              <button className="asset-admin-primary" disabled={busy || !file} type="submit">
                {busy ? "Submitting…" : "Save Changes"}
              </button>
            ) : (
              selected?.actions
                .filter((action) => !confirmation || action === "delete" || action === "remove")
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
                          : "Remove from all projects and exhibitions"
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
