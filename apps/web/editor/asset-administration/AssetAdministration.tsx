import { useEffect, useState } from "react";
import type {
  AssetAdministrationData,
  AssetAdministrationService,
  AssetCandidate,
} from "./asset-administration";
import "./asset-administration.css";

type Props = {
  session: { userId: string; role: string; mustChangePassword: boolean } | null;
  service: AssetAdministrationService;
  kind: AssetCandidate["kind"];
  onClose: () => void;
};
type Notice = { kind: "denied" | "unavailable" | "invalid"; message: string };

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
  const [data, setData] = useState<AssetAdministrationData | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");

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
    };
  }, [service, reload]);

  // Keep search and visibility filters outside the returned records
  // Opening a detail view still resolves its stable ID from the full list
  const items = data?.assets.filter((asset) => asset.kind === kind) ?? [];
  const visible = items.filter(
    (asset) =>
      asset.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (tab === "all" || (tab === "hidden" ? asset.hidden : !asset.hidden)),
  );
  const title = kind === "environment" ? "All 3D Spaces" : "All Assets";
  const noun = kind === "environment" ? "3D spaces" : "assets";
  const filtered = query.trim().length > 0 || tab !== "all";

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
              ["all", kind === "environment" ? "All Spaces" : "All Assets", items.length],
              ["visible", "Public", items.filter((a) => !a.hidden).length],
              ["hidden", "Private", items.filter((a) => a.hidden).length],
            ] as const
          ).map(([value, label, count]) => (
            <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
              {label} ({count})
            </button>
          ))}
        </div>
      </div>
      <div className="asset-admin-scroll" tabIndex={0} role="region" aria-label={`${noun} list`}>
        {loading ? (
          <div className="asset-admin-grid" role="status" aria-label="Loading assets">
            {[0, 1, 2].map((id) => (
              <div key={id} className="asset-admin-skeleton" />
            ))}
          </div>
        ) : notice ? (
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
                      {asset.status === "approved"
                        ? asset.hidden
                          ? "Hidden"
                          : "Public"
                        : asset.status}
                    </span>
                  </div>
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
    </section>
  );
}
