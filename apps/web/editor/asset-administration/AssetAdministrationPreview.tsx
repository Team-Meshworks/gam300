import { useMemo, useRef, useState } from "react";
import { assets } from "virtual:asset-catalogue";
import { WorkspaceHeader } from "../../shared/ui/WorkspaceHeader";
import { AssetSelect } from "./AssetSelect";
import { AssetAdministration } from "./AssetAdministration";
import type {
  AssetAdministrationData,
  AssetAdministrationService,
  AssetCandidate,
} from "./asset-administration";

// Exercise administrative states locally without sending writes to the intake endpoint
// Records disappear on reload and never enter the approved delivery catalogue
const initial: AssetAdministrationData = {
  assets: assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    category: asset.kind === "environment" ? null : "Objects",
    status: "approved",
    hidden: false,
    deleted: false,
    removedFromProjects: false,
    thumbnail: asset.thumbnail,
    validation: [],
    actions: ["hide", "delete"],
  })),
  policy: {
    extensions: [".glb"],
    maxBytes: 20 * 1024 * 1024,
    categories: {
      environment: null,
      image: null,
      audio: null,
      video: null,
      model: ["Objects", "Furniture", "Architecture", "Clothing", "Tools & Equipment"],
    },
    canSubmit: true,
    canForceRemove: true,
  },
};

// Give each extra preview asset its own record so actions persist independently across scenario changes
const samples: AssetCandidate[] = initial.assets.flatMap((asset) =>
  Array.from({ length: 11 }, (_, index) => ({
    ...asset,
    id: `${asset.id}-sample-${index}`,
    name: `${asset.name} ${index + 1}`,
  })),
);
const sampleIds = new Set(samples.map((asset) => asset.id));

export function AssetAdministrationPreview() {
  const [kind, setKind] = useState<AssetCandidate["kind"]>("environment");
  const [role, setRole] = useState("Administrator");
  const [failure, setFailure] = useState("none");
  const [closed, setClosed] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [displayName, setDisplayName] = useState("Preview Admin");

  // Keep one adapter per scenario so changing controls cancels the previous screen session
  const records = useRef({ ...initial, assets: [...initial.assets, ...samples] });
  const service = useMemo<AssetAdministrationService>(
    () => ({
      async load() {
        if (failure === "denied") {
          return {
            ok: false,
            kind: "denied",
            message: "Access to asset administration was denied.",
          };
        }
        if (failure === "unavailable") {
          return { ok: false, kind: "unavailable", message: "Asset service is unavailable." };
        }
        return {
          ok: true,
          // Hide extra records when overflow testing is off without discarding their lifecycle state
          value: {
            ...records.current,
            assets: records.current.assets.filter((asset) => overflow || !sampleIds.has(asset.id)),
          },
        };
      },
      // Simulate intake without reading or storing file bytes; approval remains a backend decision
      async submit(input) {
        if (failure === "save") {
          return {
            ok: false,
            kind: "unavailable",
            message: "Upload could not be confirmed. Your selected file is still here.",
          };
        }
        const value: AssetCandidate = {
          id: crypto.randomUUID(),
          name: input.file.name,
          kind: input.kind,
          category: input.category,
          status: "pending",
          hidden: true,
          deleted: false,
          removedFromProjects: false,
          thumbnail: null,
          validation: ["Pending validation"],
          actions: ["delete"],
        };
        records.current = { ...records.current, assets: [...records.current.assets, value] };
        return { ok: true, value };
      },
      async review(id, input) {
        const previous = records.current.assets.find((asset) => asset.id === id);
        if (!previous || previous.deleted || failure === "save") {
          return { ok: false, kind: "unavailable", message: "Review could not be confirmed" };
        }
        const value: AssetCandidate = {
          ...previous,
          ...input,
          status: "approved",
          hidden: false,
          validation: [],
          actions: ["hide", "delete"],
        };
        records.current = {
          ...records.current,
          assets: records.current.assets.map((asset) => (asset.id === id ? value : asset)),
        };
        return { ok: true, value };
      },
      // Mirror confirmed hide/show/delete results in memory so failures leave the old record intact
      async changeAvailability(id, action, _signal, removeFromProjects = false) {
        if (failure === "save") {
          return { ok: false, kind: "unavailable", message: "The change could not be confirmed." };
        }
        const previous = records.current.assets.find((asset) => asset.id === id);
        if (!previous) {
          return { ok: false, kind: "unavailable", message: "Asset is unavailable." };
        }
        // Keep a tombstone so deletion does not remove the admin's route to later force removal
        // Simulate the outcome locally without changing stored projects or publications
        const deleted = previous.deleted || action === "delete";
        const removed = previous.removedFromProjects || action === "remove" || removeFromProjects;
        const value: AssetCandidate = {
          ...previous,
          hidden: deleted || action === "hide",
          deleted,
          removedFromProjects: removed,
          actions: deleted
            ? removed
              ? []
              : ["remove"]
            : [action === "hide" ? "show" : "hide", "delete"],
        };
        records.current = {
          ...records.current,
          assets: records.current.assets.map((asset) => (asset.id === id ? value : asset)),
        };
        return { ok: true, value };
      },
    }),
    [failure, overflow],
  );
  // Keep scenario controls outside the reusable screen and show the simulated account explicitly
  return (
    <div className="asset-admin-preview">
      <WorkspaceHeader
        account={role === "Signed out" ? null : { displayName, role }}
        homeHref="/"
        onSignOut={() => {
          setClosed(true);
          setRole("Signed out");
        }}
      />

      {role === "Signed out" && (
        <section className="asset-admin asset-admin-denied">
          <h1>Signed out</h1>
          <p>You have signed out of the local preview.</p>
          <a className="asset-admin-text-link" href="/">
            Back to editor
          </a>
        </section>
      )}
      {!closed && role !== "Signed out" && (
        <AssetAdministration
          key={`${kind}:${role}:${failure}:${overflow}`}
          session={{ userId: "preview-admin", role, mustChangePassword: false }}
          service={service}
          kind={kind}
          onClose={() => setClosed(true)}
        />
      )}
      <details className="asset-admin-preview-controls">
        <summary>Local preview controls</summary>{" "}
        <aside aria-label="Local preview controls">
          <p>Local preview. Changes stay in this page.</p>
          <AssetSelect
            label="Library"
            value={kind}
            options={[
              { value: "environment", label: "3D Spaces" },
              { value: "model", label: "Physical assets" },
            ]}
            onChange={(value) => {
              setKind(value as AssetCandidate["kind"]);
              setClosed(false);
            }}
          />
          <label>
            Display name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <AssetSelect
            label="Account"
            value={role}
            options={["Administrator", "Creator", "Signed out"].map((value) => ({
              value,
              label: value,
            }))}
            onChange={(value) => {
              setRole(value);
              setClosed(false);
            }}
          />
          <AssetSelect
            label="Test response"
            value={failure}
            options={[
              { value: "none", label: "Normal" },
              { value: "save", label: "Save failure" },
              { value: "denied", label: "Denied" },
              { value: "unavailable", label: "Unavailable" },
            ]}
            onChange={setFailure}
          />
          <label>
            <input
              type="checkbox"
              checked={overflow}
              onChange={(event) => setOverflow(event.target.checked)}
            />
            More sample assets
          </label>
          {closed && <button onClick={() => setClosed(false)}>Open assets</button>}
        </aside>{" "}
      </details>
    </div>
  );
}
