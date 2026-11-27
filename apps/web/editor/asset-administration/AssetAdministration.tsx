import { Dialog } from "../../shared/ui/Dialog";
import { Button } from "../../shared/ui/Button";
import { SelectionToggle } from "../../shared/ui/SelectionToggle";
import { Tabs } from "../../shared/ui/Tabs";
import { Skeleton, SkeletonBox } from "skullet/react";
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
        <Button onClick={props.onClose}>
          <span className="sp-button-label">Back</span>
        </Button>
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
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string> | null>(null);
  const [uploadKind, setUploadKind] = useState(kind);
  const [audioPreview, setAudioPreview] = useState<string | null>(null);
  const [audioPreviewError, setAudioPreviewError] = useState(false);
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertainWrite, setUncertainWrite] = useState(false);
  const locked = busy || uncertainWrite;
  const [outcome, setOutcome] = useState("");
  const catalogueList = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState(false);
  const [review, setReview] = useState({ source: "", license: "", reviewNotes: "" });
  const [detailSize, setDetailSize] = useState<{ width: number; height: number }>();
  const dialog = useModal(selection !== null && !confirmation && selection.kind !== "bulk");
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
          setUncertainWrite(false);
          if (initialUpload) {
            const upload =
              kind === "model" &&
              !(result.value.policy.canSubmitByKind?.model ?? result.value.policy.canSubmit) &&
              result.value.policy.canSubmitByKind?.audio
                ? "audio"
                : kind;
            setUploadKind(upload);
            setCategory(result.value.policy.categories[upload]?.[0] ?? "");
          }
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
  const permanent = tab === "deleted";
  const bulkAction = permanent ? "remove" : "delete";
  const bulkLabel = permanent ? "Delete permanently" : "Move to Deleted";
  const bulkResult = permanent ? "permanently deleted" : "moved to Deleted";
  const showBulk = permanent ? data?.policy.canForceRemove : items.some((asset) => asset.actions.includes("delete"));
  const selectable = showBulk ? visible.filter((asset) => asset.actions.includes(bulkAction)) : [];
  const checked = selectable.filter((asset) => checkedIds?.has(asset.id));
  const selecting = checkedIds !== null;
  const allChecked = checked.length > 0 && checked.length === selectable.length;
  const bulk = selection?.kind === "bulk";
  const noun = kind === "environment" ? "3D spaces" : "assets";
  const permanentDelete = bulk ? permanent : Boolean(selected?.deleted);
  const subject = bulk ? `${checked.length} ${checked.length === 1 ? noun.slice(0, -1) : noun}` : selected?.name;
  const multiple = bulk && checked.length !== 1;
  const confirmationActions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (confirmation || bulk) confirmationActions.current?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
  }, [confirmation, bulk]);
  const loadingDialog = Boolean(selection && loading && !data);
  const title = kind === "environment" ? "All 3D Spaces" : "All Assets";
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
  const validationUnavailable =
    data && !(data.policy.canSubmitByKind?.[kind] ?? data.policy.canSubmit);
  const uploadAvailabilityMessage =
    "3D uploads are unavailable because the server's validation service is not configured. Restore asset validation in the server deployment, then check availability again.";
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
    if (uncertainWrite) return;
    setCheckedIds(null);
    const upload = kind === "model" && validationUnavailable && canOpenUpload ? "audio" : kind;
    setUploadKind(upload);
    setFile(null);
    setNameDraft(null);
    setReview({ source: "", license: "", reviewNotes: "" });
    setCategory(data?.policy.categories[upload]?.[0] ?? "");
    setNotice(null);
    setConfirmation(false);
    setSelection({ kind: "upload" });
  }

  function openAsset(asset: AssetCandidate, field?: EditField) {
    if (field && dialog.current?.open) {
      setDetailSize({
        width: dialog.current.offsetWidth,
        height: dialog.current.offsetHeight,
      });
    }
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
    // Cancel the destructive step first so the same asset details remain open
    if (uncertainWrite) {
      setSelection(null);
      return;
    }
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

  function checkLibrary() {
    setSelection(null);
    setQuery("");
    setTab("all");
    setLoading(true);
    setReload((value) => value + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editingForm || locked || !data || !assetName.trim() || (choosingFile && !canSubmit)) {
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
    if (!selected?.actions.includes(action) || locked) {
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
    // Bind this request to the mounted screen; account changes abort it before a stale result can apply
    if (uncertainWrite || (operation.current && !operation.current.signal.aborted)) return;
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
          setUncertainWrite(result.kind === "unknown");
          return;
        }
        // Replace only the confirmed record; failed mutations leave the list and form unchanged
        const record = result.value;
        confirmed = record;
        setData(
          (current) =>
            current && {
              ...current,
              assets:
                selection?.kind === "upload"
                  ? [record, ...current.assets.filter((asset) => asset.id !== record.id)]
                  : current.assets.some((asset) => asset.id === record.id)
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
      if (selection?.kind === "upload") {
        const existing = items.some((asset) => asset.id === confirmed.id);
        setQuery("");
        setTab(confirmed.deleted ? "deleted" : "all");
        catalogueList.current?.scrollTo({ top: 0 });
        setOutcome(existing ? `This file already exists as ${confirmed.name}` : "");
        return;
      }
      if (bulk) {
        setCheckedIds(null);
        return;
      }
      if (editing) {
        setSelection({ kind: "detail", id: confirmed.id });
        setOutcome(`Saved details for ${confirmed.name}.`);
        if (replacing) {
          setLoading(true);
          setReload((n) => n + 1);
        }
        return;
      }
      if (!confirmed.deleted) {
        setOutcome(`${confirmed.name}: ${confirmed.status === "approved" ? (confirmed.hidden ? "hidden" : "available") : confirmed.status}`);
      }
    } catch {
      if (!controller.signal.aborted) {
        setUncertainWrite(true);
        setNotice({
          kind: "unknown",
          message: "The change may have completed. Check the library before trying again.",
        });
      }
    } finally {
      // Only the active screen clears its pending state after a completed or failed request
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
      }
    }
  }

  async function downloadSelected() {
    if (!selected || locked) {
      return;
    }
    const asset = selected;
    if (uncertainWrite || (operation.current && !operation.current.signal.aborted)) return;
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
    <>
    <section
      className="sp-panel-surface asset-admin"
      aria-labelledby="asset-admin-heading"
    >
      <div className="asset-admin-heading sp-admin-page-heading">
        <div>
          <h1 id="asset-admin-heading">{title}</h1>
          <p>
            Review {noun} and control what creators can use.
          </p>
        </div>
        <div className="asset-admin-search">
          <SearchField
            label={`Search ${noun}`}
            placeholder={`Search ${noun}`}
            value={query}
            onChange={(value) => {
              setQuery(value);
              setCheckedIds(null);
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
        <Tabs
          id="asset-visibility"
          label="Asset visibility"
          value={tab}
          onChange={(value) => {
            setTab(value);
            setCheckedIds(null);
            setOutcome("");
          }}
          items={(
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
          ).map(([value, label, count]) => ({
            value,
            label: data ? `${label} (${count})` : label,
            measureLabel: `${label} (${data ? count : "00"})`,
          }))}
        />
        <div className="asset-admin-toolbar-actions">
          {selecting ? (
            <>
              <div className="sp-selection-summary">
                <span role="status">
                  {checked.length ? `${checked.length} selected` : `Select ${noun}`}
                </span>
                <button
                  type="button"
                  className="sp-select-all-action"
                  disabled={locked || !selectable.length}
                  onClick={() =>
                    setCheckedIds(new Set(allChecked ? [] : selectable.map((asset) => asset.id)))
                  }
                >
                  <span className="sp-plain-label sp-button-label">
                    {allChecked ? "Clear all" : "Select all"}
                  </span>
                </button>
              </div>
              <Button
                className="sp-button--danger sp-account-bulk-delete"
                disabled={!checked.length || locked}
                onClick={() => {
                  setNotice(null);
                  setSelection({ kind: "bulk", count: checked.length });
                }}
              >
                <UiIcon icon={trashIcon} aria-hidden="true" />
                <span className="sp-button-label">{permanent ? bulkLabel : "Delete selected"}</span>
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              className="asset-admin-primary sp-catalogue-add"
              disabled={!canOpenUpload || loading || uncertainWrite || notice?.kind === "denied"}
              onClick={openUpload}
            >
              <span className="sp-button-label">
                + Add {kind === "environment" ? "3D Space" : "Assets"}
              </span>
            </Button>
          )}
          {showBulk && (
            <SelectionToggle
              selected={selecting}
              label={`Select ${noun}`}
              title={`Select multiple ${noun}`}
              disabled={loading || locked || (!selecting && selectable.length === 0)}
              onClick={() => setCheckedIds(selecting ? null : new Set())}
            />
          )}
        </div>
      </div>
      {!loading && validationUnavailable && notice?.kind !== "denied" && (
        <div className="sp-hint" role="status">
          <p>{uploadAvailabilityMessage}</p>
          {kind === "model" && canOpenUpload && <p>Audio uploads are still available.</p>}
          <Button
            onClick={() => {
              setLoading(true);
              setReload((value) => value + 1);
            }}
          >
            Check upload availability
          </Button>
        </div>
      )}
      <p
        className={!selection && outcome ? "asset-admin-bulk-outcome" : "asset-admin-sr"}
        role="status"
      >
        {outcome}
      </p>
      <div
        ref={catalogueList}
        id="asset-visibility-panel"
        className="asset-admin-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${noun} list`}
      >
        {loading ? (
          <div
            className="asset-admin-grid"
            role="status"
            aria-label={`Loading ${noun.toLowerCase()}`}
            aria-busy="true"
          >
            {Array.from({ length: 3 }, (_, index) => (
              <div
                className="asset-admin-card asset-admin-loading-card"
                key={index}
                aria-hidden="true"
              >
                <div className="asset-admin-thumbnail">
                  <SkeletonBox width="100%" height="100%" radius={0} />
                </div>
                <div className="asset-admin-card-content">
                  <div>
                    <SkeletonBox width="65%" height={16} radius={4} />
                    <SkeletonBox width={52} height={14} radius={4} />
                  </div>
                  <div className="asset-admin-loading-action">
                    <SkeletonBox width={110} height={40} radius={20} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : notice && !selection ? (
          <div className="asset-admin-state" role="alert">
            <h2>
              {notice.kind === "denied"
                ? "Access denied"
                : uncertainWrite
                  ? "Check the library"
                  : `${kind === "environment" ? "Spaces" : "Assets"} unavailable`}
            </h2>
            <p>{notice.message}</p>
            {notice.kind !== "denied" && (
              <Button onClick={checkLibrary}>
                <span className="sp-button-label">
                  {uncertainWrite ? "Check library" : "Try Again"}
                </span>
              </Button>
            )}
          </div>
        ) : (
          <div className="asset-admin-grid">
            {visible.map((asset) => (
              <article className="asset-admin-card" key={asset.id}>
                {selecting && asset.actions.includes(bulkAction) && (
                  <>
                    <input
                      className="sp-row-select-input"
                      type="checkbox"
                      aria-label={`Select ${asset.name}`}
                      checked={checkedIds.has(asset.id)}
                      disabled={locked}
                      onChange={(event) => {
                        const next = new Set(checkedIds);
                        if (event.target.checked) next.add(asset.id);
                        else next.delete(asset.id);
                        setCheckedIds(next);
                      }}
                    />
                    <span className="sp-selection-marker" aria-hidden="true" />
                  </>
                )}
                <div className="asset-admin-thumbnail">{thumbnail(asset)}</div>
                <div className="asset-admin-card-content">
                  <div>
                    <h2>{asset.name}</h2>
                    <span className={`asset-admin-visibility admin-project-status${asset.deleted && asset.removedFromProjects ? " asset-admin-status-permanent" : asset.status === "approved" && !asset.hidden && !asset.deleted ? " admin-project-status--public" : ""}`}>
                      {asset.status === "approved" && (
                        <UiIcon
                          icon={asset.hidden ? eyeOffIcon : globeIcon}
                          width={12}
                          height={12}
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
                  <Button
                    variant="primary"
                    className="sp-catalogue-action"
                    disabled={selecting && asset.actions.includes(bulkAction)}
                    onClick={() => openAsset(asset)}
                  >
                    <span className="sp-button-label">
                      View details
                    </span>
                    <span className="asset-admin-sr">: {asset.name}</span>
                  </Button>
                </div>
              </article>
            ))}
            {visible.length === 0 && (
              <div className="asset-admin-state">
                <h2>{filtered ? `No matching ${noun}` : `No ${noun} yet`}</h2>
                <p>
                  {filtered
                    ? "Try another name or visibility filter."
                    : !canOpenUpload
                      ? "Uploads will be available after the server's validation service is restored."
                      : validationUnavailable
                        ? "Add an audio asset while 3D validation is unavailable."
                        : kind === "environment"
                          ? "Add a 3D space to submit it for validation."
                          : "Add an asset to submit it for validation."}
                </p>
                {(query || tab !== "all") && (
                  <Button
                    onClick={() => {
                      setQuery("");
                      setTab("all");
                    }}
                  >
                    <span className="sp-button-label">Reset Search</span>
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <dialog
        ref={dialog}
        style={editing ? detailSize : undefined}
        className={`asset-admin-dialog${selection?.kind === "upload" ? " asset-admin-dialog-upload" : ""}${editing ? " asset-admin-dialog-edit" : ""}${selected ? " asset-admin-dialog-detail" : ""}${confirmation || bulk ? " asset-admin-dialog-confirmation" : ""}`}
        aria-labelledby="asset-dialog-heading"
        onCancel={(event) => {
          // File chooser cancellation also bubbles here; only close for the dialog's own Escape event
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
              {editing && selection.field === "name" ? (
                <label className="asset-admin-title-input" data-asset-field="name">
                  <input
                    aria-label="Asset Name"
                    required
                    maxLength={120}
                    value={assetName}
                    disabled={locked}
                    onChange={(event) => setNameDraft(event.target.value)}
                  />
                </label>
              ) : selected && !selected.deleted ? (
                <button
                  type="button"
                  className="asset-admin-edit-title"
                  title="Edit asset name"
                  disabled={locked}
                  onClick={() =>
                    editing
                      ? setSelection({ ...selection, field: "name" })
                      : openAsset(selected, "name")
                  }
                >
                  <span className="sp-plain-label sp-button-label">{selected.name}</span>
                  <UiIcon icon={pencilIcon} aria-hidden="true" />
                </button>
              ) : (
                (selected?.name ??
                (selection?.kind === "detail"
                  ? "Asset Details"
                  : kind === "environment"
                    ? "Upload 3D Space"
                    : "Upload Assets"))
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
          {loadingDialog ? (
            <Skeleton
              loading
              label={
                selection?.kind === "upload" ? "Loading upload options" : "Loading asset details"
              }
            >
              <div
                className={
                  selection?.kind === "upload" ? "asset-admin-upload" : "asset-admin-detail-preview"
                }
              />
              <h3>Asset Details</h3>
              <div className="asset-admin-fields">
                {["Asset Type", "Filter Category"].map((label) => (
                  <div className="asset-admin-select" key={label}>
                    <span>{label}</span>
                    <output>Loading</output>
                  </div>
                ))}
              </div>
              <div className="asset-admin-actions">
                {selection?.kind === "detail" && (
                  <span className="asset-admin-text-link">Download File</span>
                )}
                {selection?.kind === "upload" && (
                  <details className="asset-admin-metadata">
                    <summary>Additional Details</summary>
                  </details>
                )}
                <Button type="button" disabled>
                  <span className="sp-button-label">Cancel</span>
                </Button>
                <Button type="button" disabled>
                  <span className="sp-button-label">
                    {selection?.kind === "upload" ? "Save Changes" : "Hide"}
                  </span>
                </Button>
                {selection?.kind === "detail" && (
                  <Button type="button" disabled>
                    <span className="sp-button-label">Delete</span>
                  </Button>
                )}
              </div>
            </Skeleton>
          ) : (
            <>
              {!confirmation && !bulk && (
                <>
                  {choosingFile ? (
                    <label
                      className="asset-admin-upload"
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = locked ? "none" : "copy";
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (locked) return;
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
                          (replacing
                            ? "Choose a replacement file or drop it here"
                            : uploadKind === "audio"
                              ? "Choose an M4A file or drop it here"
                              : "Choose a GLB file or drop it here")}
                      </span>
                      <span className="asset-admin-help">
                        {data &&
                          `${extensions.join(" / ")} files, up to ${Math.floor(data.policy.maxBytes / 1024 / 1024)} MB`}
                        {replacing && "; existing projects keep the original file"}
                      </span>
                      <input
                        aria-label="Choose asset file"
                        type="file"
                        key={uploadKind}
                        accept={extensions.join(",")}
                        disabled={locked}
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
                            !audioPreviewError && (
                              <div
                                className="asset-admin-audio-loading"
                                role="status"
                                aria-label="Loading audio preview…"
                                aria-busy="true"
                              >
                                <SkeletonBox width="100%" height={54} radius={27} />
                              </div>
                            )
                          ))}
                        {audioPreviewError && (
                          <p role="alert">
                            Audio preview is unavailable. You can download the file instead.
                          </p>
                        )}
                      </div>
                    )
                  )}
                  {choosingFile && data && !canSubmit && (
                    <p role="status">
                      {uploadKind === "audio"
                        ? "Audio uploads are unavailable. Close this dialog and check upload availability again."
                        : uploadAvailabilityMessage}
                      {kind === "model" &&
                        uploadKind !== "audio" &&
                        canOpenUpload &&
                        " Select Audio to upload an audio asset."}
                    </p>
                  )}
                  <h3>Asset Details</h3>
                  {selection && (
                    <div className="asset-admin-fields">
                      {selection.kind === "upload" && (
                        <label
                          className="asset-admin-select asset-admin-name"
                          data-asset-field="name"
                        >
                          <span>Asset Name</span>
                          <input
                            required
                            maxLength={120}
                            value={assetName}
                            disabled={locked}
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
                            disabled={locked}
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
                              disabled={locked}
                              onClick={() => openAsset(selected, "type")}
                            >
                              <span className="sp-button-label">{typeLabel(selected.kind)}</span>
                              <UiIcon icon={pencilIcon} aria-hidden="true" />
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
                          <output aria-labelledby="asset-admin-category-label">
                            Not applicable
                          </output>
                        </div>
                      )}
                      {kind === "model" && selection?.kind === "detail" && (
                        <div className="asset-admin-select">
                          <span id="asset-admin-category-label">Filter Category</span>
                          {selected && !selected.deleted ? (
                            <button
                              type="button"
                              aria-label="Edit filter category"
                              disabled={locked}
                              onClick={() => openAsset(selected, "category")}
                            >
                              <span className="sp-button-label">
                                {selected.category ?? "Not configured"}
                              </span>
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
                            disabled={locked || categoryChoices === null}
                            value={category}
                            options={(categoryChoices ?? []).map((value) => ({
                              value,
                              label: value,
                            }))}
                            placeholder="Not configured"
                            onChange={setCategory}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {/* Keep review statements separate from technical validation and retain them after a failed request */}
                  {selected &&
                    !editing &&
                    !selected.deleted &&
                    selected.status === "pending" &&
                    !confirmation && (
                      <fieldset className="asset-admin-review" disabled={locked}>
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
                                setReview((current) => ({
                                  ...current,
                                  [field]: event.target.value,
                                }))
                              }
                            />
                          </label>
                        ))}
                        <Button
                          type="button"
                          className="asset-admin-primary"
                          onClick={() => {
                            void mutate((signal) => service.review(selected.id, review, signal));
                          }}
                        >
                          <span className="sp-button-label">Approve</span>
                        </Button>
                      </fieldset>
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
              {selected?.status === "approved" &&
                !editing &&
                !confirmation &&
                (selected.source || selected.license || selected.reviewNotes) && (
                  <details className="asset-admin-metadata">
                    <summary>Additional Details</summary>
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
                  </details>
                )}
              {selected?.deleted && !confirmation && (
                <p className="asset-admin-retired-status">
                  {selected.removedFromProjects
                    ? "Removed from projects. Affected published exhibitions are permanently unavailable."
                    : "Deleted from library. Kept in existing projects and exhibitions."}
                </p>
              )}
              {editingForm && (
                <details className="asset-admin-metadata">
                  <summary>Additional Details</summary>
                  <fieldset className="asset-admin-review" disabled={locked}>
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
              <div className="asset-admin-actions">
                {uncertainWrite && <Button onClick={checkLibrary}>Check library</Button>}
                {selected?.inspectionUrl && !editing && !confirmation && (
                  <a
                    className="asset-admin-text-link"
                    href={selected.inspectionUrl}
                    download
                    aria-disabled={locked}
                    onClick={(event) => {
                      event.preventDefault();
                      void downloadSelected();
                    }}
                  >
                    <span className="sp-button-label">
                      {busy ? "Please Wait…" : "Download File"}
                    </span>
                  </a>
                )}
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    editing && selected && !uncertainWrite ? openAsset(selected) : closeDialog()
                  }
                >
                  <span className="sp-button-label">Cancel</span>
                </Button>
                {editingForm ? (
                  <Button
                    className="asset-admin-primary"
                    disabled={
                      locked ||
                      !assetName.trim() ||
                      (choosingFile && (!file || !canSubmit)) ||
                      (categoryChoices !== null && !categoryChoices.includes(category))
                    }
                    type="submit"
                  >
                    <span className="sp-button-label">{busy ? "Submitting…" : "Save Changes"}</span>
                  </Button>
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
                          action === "delete" || action === "remove"
                            ? "asset-admin-danger"
                            : "asset-admin-visibility"
                        }
                        disabled={locked || (action === "remove" && !data?.policy.canForceRemove)}
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
                        <span className="sp-button-label">
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
                        </span>
                      </button>
                    ))
                )}
              </div>
            </>
          )}
        </form>
      </dialog>
    </section>
      {(confirmation || bulk) && (
        <Dialog
          title={bulk ? `${permanentDelete ? "Permanently delete" : "Delete"} ${subject}?` : permanentDelete ? "Delete Permanently?" : "Delete asset?"}
          variant="admin"
          className="sp-account-confirmation"
          closeDisabled={busy}
          onClose={closeDialog}
        >
          <p role={permanentDelete ? "alert" : undefined}>
            {bulk ? (multiple ? "These items" : "This item") : subject}
            {permanentDelete ? (
              <> will be <strong>permanently removed</strong> from all projects. Affected published exhibitions will no longer open, even through their links or QR codes.</>
            ) : " will leave the student library but remain in existing projects and exhibitions."}
          </p>
          {bulk && checked.length < selection.count && (
            <p role="status">{selection.count - checked.length} of {selection.count} {bulkResult}.</p>
          )}
          {notice && <p role="alert">{notice.message}</p>}
          <div ref={confirmationActions} className="sp-actions sp-confirmation-actions">
            {uncertainWrite && <Button onClick={checkLibrary}>Check library</Button>}
            <Button data-cancel disabled={busy} onClick={closeDialog}>Cancel</Button>
            <Button className="sp-button--danger" disabled={locked || (bulk && !checked.length)}
              onClick={() => bulk
                ? void mutate(checked.map(asset => signal => service.changeAvailability(asset.id, bulkAction, signal, permanent)))
                : void changeAvailability(permanentDelete ? "remove" : "delete")}>
              {busy ? "Deleting…" : bulk ? bulkLabel : permanentDelete ? "Delete Permanently" : "Confirm Delete"}
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
}
