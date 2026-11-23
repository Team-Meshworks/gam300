import { Icon as UiIcon } from "@iconify/react/offline";
import eyeIcon from "@iconify-icons/lucide/eye";
import eyeOffIcon from "@iconify-icons/lucide/eye-off";
import globeIcon from "@iconify-icons/lucide/globe";
import trashIcon from "@iconify-icons/lucide/trash-2";
import pencilIcon from "@iconify-icons/lucide/pencil";
import faMusic from "@iconify-icons/lucide/music";
import faXmark from "@iconify-icons/lucide/x";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useModal } from "../../shared/ui/useModal";
import { SearchField } from "../../shared/ui/SearchField";
import { generateLibraryPreviews } from "../graphics/library-previews";
import { assetPreviewKey, assetPreviewSource } from "./asset-previews";
import type {
  AssetAdministrationData,
  AssetAdministrationService,
  AssetAdministrationResult,
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
type Notice = Pick<Extract<AssetAdministrationResult<never>, { ok: false }>, "kind" | "message">;
type EditField = "name" | "type" | "category";
type Selection =
  | { kind: "upload" }
  | { kind: "detail"; id: string }
  | { kind: "edit"; id: string; field: EditField }
  | { kind: "bulk"; count: number }
  | null;
type AssetWrite = (
  signal: AbortSignal,
) => ReturnType<AssetAdministrationService["changeAvailability"]>;

function typeLabel(kind: AssetCandidate["kind"]) {
  return kind === "audio" ? "Audio" : kind === "environment" ? "3D Space" : "3D Model";
}

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
  const [selection, setSelection] = useState<Selection>(() => {
    if (initialUpload) return { kind: "upload" };
    const id = new URLSearchParams(location.search).get("assetId");
    return id ? { kind: "detail", id } : null;
  });
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.delete("add");
    if (selection?.kind === "detail" || selection?.kind === "edit")
      url.searchParams.set("assetId", selection.id);
    else url.searchParams.delete("assetId");
    history.replaceState(history.state, "", url);
  }, [selection]);
  const [file, setFile] = useState<File | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [uploadKind, setUploadKind] = useState(kind);
  const [audioPreview, setAudioPreview] = useState<string | null>(null);
  const [audioPreviewError, setAudioPreviewError] = useState(false);
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [unknownWrite, setUnknownWrite] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [review, setReview] = useState({ source: "", license: "", reviewNotes: "" });
  const dialog = useModal(selection !== null);
  useEffect(() => {
    if (selection?.kind !== "edit") return;
    const target = dialog.current?.querySelector<HTMLElement>(
      `[data-asset-field="${selection.field}"] :is(input, [role="combobox"])`,
    );
    target?.focus();
  }, [selection, dialog]);
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
        setData(result.ok ? result.value : null);
        if (result.ok) {
          setUnknownWrite(false);
          if (initialUpload) setCategory(result.value.policy.categories[kind]?.[0] ?? "");
          setNotice(null);
        } else {
          setNotice(result);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setData(null);
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
    if (confirmation || selection?.kind === "bulk") {
      dialog.current?.querySelector<HTMLButtonElement>(".asset-admin-actions > button")?.focus();
    }
  }, [confirmation, dialog, selection]);

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
    selection?.kind === "detail" || selection?.kind === "edit"
      ? items.find((asset) => asset.id === selection.id)
      : null;
  const editing = selection?.kind === "edit";
  const editingForm = selection?.kind === "upload" || editing;
  const replacing = editing && selected?.kind !== uploadKind;
  const choosingFile = selection?.kind === "upload" || replacing;
  const assetName = nameDraft ?? file?.name.replace(/\.[^.]*$/, "") ?? "";
  const selectable =
    tab === "deleted" && kind === "model" && data?.policy.canForceRemove
      ? visible.filter((asset) => asset.actions.includes("remove"))
      : [];
  const checked = selectable.filter((asset) => checkedIds.has(asset.id));
  const bulk = selection?.kind === "bulk";
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
    if (
      editing ||
      selected?.kind !== "audio" ||
      selected.status !== "approved" ||
      !selected.inspectionUrl
    )
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
  }, [selected, editing, service]);

  // Start each upload with fresh fields while keeping the loaded catalogue intact
  function openUpload() {
    setUploadKind(kind);
    setFile(null);
    setNameDraft(null);
    setReview({ source: "", license: "", reviewNotes: "" });
    setCategory(data?.policy.categories[kind]?.[0] ?? "");
    setNotice(null);
    setConfirmation(false);
    setSelection({ kind: "upload" });
  }

  function openAsset(asset: AssetCandidate, field?: EditField) {
    setNotice(null);
    setConfirmation(false);
    setAudioPreviewError(false);
    if (selected?.id !== asset.id) setAudioPreview(null);
    setFile(null);
    setNameDraft(asset.name);
    setUploadKind(asset.kind);
    setCategory(asset.category ?? "");
    setReview({
      source: asset.source ?? "",
      license: asset.license ?? "",
      reviewNotes: asset.reviewNotes ?? "",
    });
    setSelection(
      field && !asset.deleted
        ? { kind: "edit", id: asset.id, field }
        : { kind: "detail", id: asset.id },
    );
  }

  function closeDialog() {
    // Keep the selected file and draft fields in place while a server response is pending
    if (busy) {
      return;
    }
    if (unknownWrite) {
      setSelection(null);
      setConfirmation(false);
      setLoading(true);
      setReload((n) => n + 1);
      return;
    }
    // Cancel the destructive step first so the same asset details remain open
    if (confirmation) {
      setConfirmation(false);
      setNotice(null);
      return;
    }
    setSelection(null);
    // Discard only this dialog's review fields after an explicit close
    setReview({ source: "", license: "", reviewNotes: "" });
    setNotice(null);
    setConfirmation(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editingForm || busy || !data || !assetName.trim() || (choosingFile && !canSubmit)) {
      return;
    }
    // Client checks provide immediate feedback; the intake endpoint must repeat validation on bytes
    const extension = file?.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    if (
      (choosingFile &&
        (!file ||
          file.size === 0 ||
          file.size > data.policy.maxBytes ||
          !extensions.includes(extension ?? ""))) ||
      (categoryChoices !== null && !categoryChoices.includes(category))
    ) {
      setNotice({
        kind: "invalid",
        message: "Choose a supported file within the size limit and a filter category.",
      });
      return;
    }
    const details = {
      name: assetName.trim(),
      kind: uploadKind,
      category: categoryChoices === null ? null : category,
      review,
    };
    if (editing && selected && !replacing) {
      await mutate((signal) => service.updateDetails(selected.id, details, signal));
    } else if (file) {
      await mutate((signal) =>
        service.submit(
          { ...details, file, ...(replacing && selected ? { replaces: selected.id } : {}) },
          signal,
        ),
      );
    }
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
      service.changeAvailability(selected.id, action, signal, action === "remove"),
    );
  }

  async function mutate(send: AssetWrite | readonly AssetWrite[]) {
    if (unknownWrite || operation.current) return;
    // Bind this request to the mounted screen; account changes abort it before a stale result can apply
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setNotice(null);
    setOutcome("");
    try {
      let confirmed: AssetCandidate | undefined;
      for (const write of typeof send === "function" ? [send] : send) {
        const result = await write(controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        if (!result.ok) {
          setNotice(result);
          setUnknownWrite(result.kind === "unknown");
          return;
        }
        // Replace only the confirmed record; failed mutations leave the list and form unchanged
        const record = result.value;
        confirmed = record;
        setData(
          (current) =>
            current && {
              ...current,
              assets: current.assets.some((asset) => asset.id === record.id)
                ? current.assets.map((asset) => (asset.id === record.id ? record : asset))
                : [...current.assets, record],
            },
        );
      }
      if (!confirmed) return;
      setSelection(null);
      setReview({ source: "", license: "", reviewNotes: "" });
      setFile(null);
      setConfirmation(false);
      if (bulk) {
        setCheckedIds(new Set());
        setOutcome(
          `${selection.count} selected ${selection.count === 1 ? "asset" : "assets"} permanently deleted.`,
        );
        return;
      }
      if (editing) {
        setOutcome(`Saved details for ${confirmed.name}.`);
        if (replacing) {
          setLoading(true);
          setReload((n) => n + 1);
        }
        return;
      }
      // Announce the confirmed state after closing the form; uploaded candidates can still be pending
      setOutcome(
        `${confirmed.name}: ${
          confirmed.deleted
            ? confirmed.removedFromProjects
              ? "removed from projects; affected published exhibitions are permanently unavailable"
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
        setUnknownWrite(true);
        setNotice({
          kind: "unknown",
          message: "The change may have been applied. Check the asset list before trying again.",
        });
      }
    } finally {
      if (operation.current === controller) operation.current = null;
      // Only the active screen clears its pending state after a completed or failed request
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }

  async function downloadSelected() {
    if (!selected || operation.current) {
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
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }

  function thumbnail(asset: AssetCandidate) {
    if (asset.kind === "audio") {
      return (
        <span className="asset-admin-audio-icon">
          <UiIcon icon={faMusic} aria-hidden="true" />
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
      <div className="asset-admin-heading sp-admin-page-heading">
        <div>
          <h1 id="asset-admin-heading">{title}</h1>
          <p>
            {kind === "model"
              ? tab === "deleted"
                ? "Review deleted assets and select the ones to remove permanently."
                : "Select an asset name or type to edit its details."
              : "Review published experiences and control what visitors can explore."}
          </p>
        </div>
        <div className="asset-admin-search">
          <SearchField
            label={`Search ${noun}`}
            placeholder={`Search ${noun}`}
            value={query}
            onChange={(value) => {
              setQuery(value);
              setCheckedIds(new Set());
              setOutcome("");
            }}
          />
        </div>
        <button
          className="asset-admin-close sp-close-button"
          aria-label="Close asset administration"
          onClick={onClose}
        >
          <UiIcon icon={faXmark} aria-hidden="true" />
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
            <button
              key={value}
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
                setCheckedIds(new Set());
                setOutcome("");
              }}
            >
              {label} ({count})
            </button>
          ))}
        </div>
        <button
          className="asset-admin-primary"
          disabled={!canOpenUpload || loading || unknownWrite || notice?.kind === "denied"}
          onClick={openUpload}
        >
          + Add {kind === "environment" ? "3D Space" : "Assets"}
        </button>
      </div>
      {tab === "deleted" && kind === "model" && selectable.length > 0 && !loading && (
        <div className="asset-admin-bulk-bar">
          <label>
            <input
              type="checkbox"
              aria-label="Select all visible assets"
              ref={(element) => {
                if (element)
                  element.indeterminate =
                    checked.length > 0 && checked.length !== selectable.length;
              }}
              checked={checked.length === selectable.length}
              onChange={(event) =>
                setCheckedIds(
                  new Set(event.target.checked ? selectable.map((asset) => asset.id) : []),
                )
              }
            />
            Select all
          </label>
          <span>{checked.length} selected</span>
          <button
            className="asset-admin-danger"
            disabled={!checked.length || unknownWrite || busy}
            onClick={() => {
              setNotice(null);
              setSelection({ kind: "bulk", count: checked.length });
            }}
          >
            <UiIcon icon={trashIcon} aria-hidden="true" /> Delete selected
          </button>
        </div>
      )}
      <p
        className={tab === "deleted" && outcome ? "asset-admin-bulk-outcome" : "asset-admin-sr"}
        role="status"
      >
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
                {tab === "deleted" &&
                  kind === "model" &&
                  data?.policy.canForceRemove &&
                  asset.actions.includes("remove") && (
                    <input
                      className="asset-admin-card-check"
                      type="checkbox"
                      aria-label={`Select ${asset.name}`}
                      checked={checkedIds.has(asset.id)}
                      onChange={(event) => {
                        const next = new Set(checkedIds);
                        if (event.target.checked) next.add(asset.id);
                        else next.delete(asset.id);
                        setCheckedIds(next);
                      }}
                    />
                  )}
                <div className="asset-admin-thumbnail">{thumbnail(asset)}</div>
                <div className="asset-admin-card-content">
                  <div>
                    <div className="asset-admin-card-identity">
                      <h2>
                        {asset.deleted ? (
                          asset.name
                        ) : (
                          <a
                            href={`?assetId=${encodeURIComponent(asset.id)}`}
                            onClick={(event) => {
                              event.preventDefault();
                              openAsset(asset, "name");
                            }}
                          >
                            {asset.name}
                          </a>
                        )}
                      </h2>
                      {kind === "model" &&
                        (asset.deleted ? (
                          <small>{typeLabel(asset.kind)}</small>
                        ) : (
                          <a
                            className="asset-admin-card-type"
                            href={`?assetId=${encodeURIComponent(asset.id)}`}
                            onClick={(event) => {
                              event.preventDefault();
                              openAsset(asset, "type");
                            }}
                          >
                            {typeLabel(asset.kind)} <UiIcon icon={pencilIcon} aria-hidden="true" />
                          </a>
                        ))}
                    </div>
                    <span className="asset-admin-visibility">
                      {asset.status === "approved" && (
                        <UiIcon
                          icon={asset.hidden ? eyeOffIcon : globeIcon}
                          width={13}
                          height={13}
                          aria-hidden="true"
                        />
                      )}
                      {asset.deleted
                        ? asset.removedFromProjects
                          ? "Permanently deleted"
                          : "Deleted"
                        : asset.status === "approved"
                          ? asset.hidden
                            ? "Private"
                            : "Public"
                          : asset.status}
                    </span>
                  </div>
                  <button className="asset-admin-primary" onClick={() => openAsset(asset)}>
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
        className={`asset-admin-dialog${editingForm ? " asset-admin-dialog-upload" : ""}${editing ? " asset-admin-dialog-edit" : ""}${selection?.kind === "detail" ? " asset-admin-dialog-detail" : ""}${confirmation || bulk ? " asset-admin-dialog-confirmation" : ""}`}
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
              {bulk ? (
                `Permanently delete ${checked.length} ${checked.length === 1 ? "asset" : "assets"}?`
              ) : editing ? (
                "Edit asset details"
              ) : confirmation ? (
                selected?.deleted ? (
                  "Delete Permanently?"
                ) : (
                  "Delete asset?"
                )
              ) : selected && !selected.deleted ? (
                <button
                  type="button"
                  className="asset-admin-edit-title"
                  title="Edit asset name"
                  onClick={() => openAsset(selected, "name")}
                >
                  {selected.name}
                  <UiIcon icon={pencilIcon} aria-hidden="true" />
                </button>
              ) : (
                (selected?.name ?? (kind === "environment" ? "Upload 3D Space" : "Upload Assets"))
              )}
            </h2>
            <button
              type="button"
              className="asset-admin-close sp-close-button"
              aria-label="Close asset details"
              disabled={busy}
              onClick={closeDialog}
            >
              <UiIcon icon={faXmark} aria-hidden="true" />
            </button>
          </div>
          {bulk && (
            <div className="asset-admin-confirmation-content">
              <p>The following assets will be removed from every project that uses them.</p>
              <ul className="asset-admin-bulk-names">
                {checked.map((asset) => (
                  <li key={asset.id}>{asset.name}</li>
                ))}
              </ul>
              <p className="asset-admin-confirmation-warning">
                Published exhibitions using these assets will become permanently unavailable,
                including their links and QR codes. This cannot be undone.
              </p>
              {checked.length < selection.count && (
                <p role="status">
                  {selection.count - checked.length} of {selection.count} permanently deleted.
                </p>
              )}
            </div>
          )}
          {!confirmation && !bulk && (
            <>
              {replacing && (
                <p className="asset-admin-replacement-help">
                  Choose a {uploadKind === "audio" ? "M4A" : "GLB"} file for the new type. Existing
                  projects keep their original version.
                </p>
              )}
              {choosingFile ? (
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
                      viewBox="0 0 48 48"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path
                        d="M4 26v13c0 4 2 5 6 5h28c4 0 6-1 6-5V26"
                        fill="var(--aa-upload-tray)"
                      />
                      <path d="M24 33V5m-10 9 8-8q2-2 4 0l8 8" />
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
                selected &&
                !editing && (
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
              {!editing && <h3>Asset Details</h3>}
              {selection && (
                <div className="asset-admin-fields">
                  {editingForm && (
                    <label className="asset-admin-select asset-admin-name" data-asset-field="name">
                      <span>Asset name</span>
                      <input
                        required
                        maxLength={120}
                        value={assetName}
                        disabled={busy || unknownWrite}
                        placeholder="Enter an asset name"
                        onChange={(event) => setNameDraft(event.target.value)}
                      />
                    </label>
                  )}
                  {/* All Assets accepts models and audio; the Spaces screen stays fixed */}
                  {editingForm && kind === "model" && (
                    <div data-asset-field="type" className="asset-admin-field-wrapper">
                      <AssetSelect
                        label="Asset Type"
                        value={uploadKind}
                        disabled={busy || unknownWrite}
                        options={[
                          { value: "model", label: "3D Model" },
                          ...(audioEnabled ? [{ value: "audio", label: "Audio" }] : []),
                        ]}
                        onChange={(value) => {
                          const nextKind = value === "audio" ? "audio" : "model";
                          setUploadKind(nextKind);
                          setFile(null);
                          setCategory(
                            nextKind === selected?.kind
                              ? (selected.category ?? "")
                              : (data?.policy.categories[nextKind]?.[0] ?? ""),
                          );
                          setNotice(null);
                        }}
                      />
                    </div>
                  )}
                  {(selection?.kind === "detail" || kind === "environment") && (
                    <div className="asset-admin-select">
                      <span id="asset-admin-type-label">Asset Type</span>
                      {selected && !selected.deleted && kind === "model" ? (
                        <button
                          type="button"
                          aria-label="Edit asset type"
                          onClick={() => openAsset(selected, "type")}
                        >
                          {typeLabel(selected.kind)} <UiIcon icon={pencilIcon} aria-hidden="true" />
                        </button>
                      ) : (
                        <output aria-labelledby="asset-admin-type-label">
                          {typeLabel(selected?.kind ?? kind)}
                        </output>
                      )}
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
                      {selected && !selected.deleted ? (
                        <button
                          type="button"
                          aria-label="Edit filter category"
                          onClick={() => openAsset(selected, "category")}
                        >
                          {selected.category ?? "Not configured"}{" "}
                          <UiIcon icon={pencilIcon} aria-hidden="true" />
                        </button>
                      ) : (
                        <output aria-labelledby="asset-admin-category-label">
                          {selected?.category ?? "Not configured"}
                        </output>
                      )}
                    </div>
                  )}
                  {kind === "model" && editingForm && (
                    <div data-asset-field="category" className="asset-admin-field-wrapper">
                      <AssetSelect
                        label="Filter Category"
                        disabled={busy || unknownWrite || categoryChoices === null}
                        value={category}
                        options={(categoryChoices ?? []).map((value) => ({ value, label: value }))}
                        placeholder="Not configured"
                        onChange={setCategory}
                      />
                    </div>
                  )}
                </div>
              )}
              {!editing &&
                selected?.status === "approved" &&
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
              {selected &&
                !editing &&
                !selected.deleted &&
                selected.status === "pending" &&
                !confirmation && (
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
                    ? "Removed from projects. Affected published exhibitions are permanently unavailable."
                    : "Deleted from library; still kept in existing projects and exhibitions."}
                </p>
              )}
              {selected &&
                !editing &&
                (selected.status !== "approved" || selected.validation.length > 0) && (
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
                  ? " will be removed from every project that uses it."
                  : " will move to Deleted and disappear from the student library."}
              </p>
              {!selected?.deleted && (
                <p className="asset-admin-confirmation-hint">
                  Existing projects and exhibitions keep this asset.
                </p>
              )}
              {selected?.deleted && (
                <p className="asset-admin-confirmation-warning" role="alert">
                  All published exhibitions using this asset will become permanently unavailable.
                  Their links and QR codes will stop working. This cannot be undone.
                </p>
              )}
            </div>
          )}
          <div className="asset-admin-actions">
            {editingForm && (
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
            {selected?.inspectionUrl && !confirmation && !editing && (
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
              {unknownWrite ? "Check asset list" : "Cancel"}
            </button>
            {bulk ? (
              <button
                type="button"
                className="asset-admin-danger"
                disabled={busy || unknownWrite || !checked.length}
                onClick={() =>
                  void mutate(
                    checked.map(
                      (asset) => (signal) =>
                        service.changeAvailability(asset.id, "remove", signal, true),
                    ),
                  )
                }
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            ) : editingForm ? (
              <button
                className="asset-admin-primary"
                disabled={
                  busy ||
                  unknownWrite ||
                  !assetName.trim() ||
                  (choosingFile && (!file || !canSubmit))
                }
                type="submit"
              >
                {busy ? "Saving…" : "Save Changes"}
              </button>
            ) : (
              !unknownWrite &&
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
                    <UiIcon
                      icon={
                        action === "delete" || action === "remove"
                          ? trashIcon
                          : action === "show"
                            ? eyeIcon
                            : eyeOffIcon
                      }
                      width={18}
                      height={18}
                      aria-hidden="true"
                    />
                    {busy
                      ? "Saving…"
                      : action === "remove"
                        ? confirmation
                          ? "Delete Permanently"
                          : "Delete Permanently"
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
