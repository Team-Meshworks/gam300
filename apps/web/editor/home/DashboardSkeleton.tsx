import { SkeletonBox } from "skullet/react";

export function DashboardSkeleton({ view }: { view: "facilitator" | "creator" | "published" }) {
  const grid = view === "facilitator";
  return (
    <div role="status" className="sp-dashboard-loading">
      <span className="sp-sr-only">
        {view === "published" ? "Loading published projects…" : "Loading projects…"}
      </span>
      <div aria-hidden="true" className={grid ? "sp-teacher-grid" : "sp-student-list"}>
        {Array.from({ length: view === "published" ? 1 : 2 }, (_, index) => (
          <div key={index} className={grid ? "sp-teacher-card" : "sp-student-card"}>
            <SkeletonBox
              className={grid ? "sp-teacher-card-cover" : "sp-student-card-image"}
              radius={grid ? 0 : 16}
            />
            <div className="sp-skeleton-copy">
              <SkeletonBox width="74%" height={grid ? 18 : 26} radius={5} />
              <SkeletonBox width="90%" height={14} radius={4} />
              <SkeletonBox width={grid ? 110 : 157} height={40} radius={20} />
            </div>
            {!grid && (
              <div className="sp-student-metadata">
                <SkeletonBox width="80%" height={16} radius={4} />
                <SkeletonBox width={104} height={32} radius={8} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
