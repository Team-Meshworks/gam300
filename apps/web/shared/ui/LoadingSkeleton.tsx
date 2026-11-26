import { SkeletonBox } from "skullet/react";
import "./loading-skeleton.css";

export function LoadingSummary({ label }: { label: string }) {
  return (
    <div className="sp-loading-summary" role="status" aria-label={label} aria-busy="true">
      <SkeletonBox width="min(180px, 60%)" height={20} radius={5} />
      <SkeletonBox width="min(340px, 85%)" height={14} radius={4} />
    </div>
  );
}

export function LoadingSkeleton({
  label,
  layout = "rows",
}: {
  label: string;
  layout?: "rows" | "cards";
}) {
  return (
    <div
      className={`sp-loading-skeleton sp-loading-skeleton--${layout}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      {[0, 1, 2].map((index) => (
        <div className="sp-loading-skeleton-item" key={index} aria-hidden="true">
          <SkeletonBox
            width={layout === "cards" ? "100%" : 36}
            height={layout === "cards" ? 140 : 36}
            radius={layout === "cards" ? 12 : 18}
          />
          <div className="sp-loading-skeleton-copy">
            <SkeletonBox width="64%" height={16} radius={4} />
            <SkeletonBox width="84%" height={12} radius={4} />
            <SkeletonBox width={110} height={32} radius={16} />
          </div>
        </div>
      ))}
    </div>
  );
}
