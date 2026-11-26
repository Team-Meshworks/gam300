import { SkeletonBox } from "skullet/react";

export function DashboardSkeleton({ view }: { view: "facilitator" | "creator" | "published" }) {
  const grid = view === "facilitator";
  return (
    <div role="status" aria-busy="true" className="sp-dashboard-loading">
      <span className="sp-sr-only">
        {view === "published" ? "Loading published projects…" : "Loading projects…"}
      </span>
      <div aria-hidden="true" className={grid ? "sp-teacher-grid" : "sp-student-list"}>
        {Array.from({ length: view === "published" ? 1 : 2 }, (_, index) => (
          <div
            key={index}
            className={
              grid
                ? "sp-teacher-card"
                : view === "published"
                  ? "sp-student-card sp-student-card--published"
                  : "sp-student-card"
            }
          >
            <div className={grid ? "sp-teacher-card-cover" : "sp-student-card-image"}>
              <SkeletonBox width="100%" height="100%" radius={grid ? 0 : 12} />
            </div>
            <div className={grid ? "sp-skeleton-copy" : "sp-student-card-copy"}>
              {grid ? (
                <>
                  <SkeletonBox width="74%" height={18} radius={5} />
                  <SkeletonBox width="90%" height={14} radius={4} />
                </>
              ) : (
                <div className="sp-student-identity">
                  <SkeletonBox
                    width="74%"
                    height="var(--creator-loading-title-height, 26px)"
                    radius={5}
                  />
                  <SkeletonBox width="30%" height={19} radius={4} />
                </div>
              )}
              {!grid && <SkeletonBox width="90%" height={42} radius={4} />}
              <div className={grid ? undefined : "sp-card-actions"}>
                <SkeletonBox width={grid ? 110 : 134} height={grid ? 40 : 36} radius={20} />
              </div>
            </div>
            {view === "creator" && (
              <dl className="sp-student-metadata">
                {[0, 1].map((item) => (
                  <div key={item}>
                    <dt>
                      <SkeletonBox width={86} height={18} radius={4} />
                    </dt>
                    <dd className={item === 0 ? "sp-due" : undefined}>
                      <SkeletonBox width={item === 0 ? 150 : 106} height={29} radius={8} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {view === "published" && (
              <div className="sp-published-share">
                <SkeletonBox width="52%" height={22} radius={4} />
                <SkeletonBox width="100%" height={32} radius={8} />
                <SkeletonBox width={84} height={25} radius={12} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
