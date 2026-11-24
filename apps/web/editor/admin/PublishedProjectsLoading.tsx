import { PublishedProjectsHeading } from "./PublishedProjectsHeading";
import { SkeletonBox } from "skullet/react";
import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";

export function PublishedStudentsLoading() {
  return (
    <section
      className="admin-progress"
      role="status"
      aria-label="Loading published student projects"
      aria-busy="true"
    >
      <div className="admin-progress-controls" aria-hidden="true">
        <div className="sp-search">
          <SkeletonBox width="min(220px, 70%)" height={14} radius={4} />
        </div>
        <div className="admin-project-selection-toolbar">
          <div className="sp-tabs">
            <SkeletonBox width={104} height={14} radius={4} />
            <SkeletonBox width={60} height={14} radius={4} />
            <SkeletonBox width={66} height={14} radius={4} />
          </div>
          <SkeletonBox width={20} height={16} radius={4} />
        </div>
      </div>
      <div className="admin-progress-list" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <div className="admin-progress-row" key={index}>
            <div className="admin-student-identity">
              <SkeletonBox width={36} height={36} radius={18} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <SkeletonBox width="min(90px, 100%)" height={16} radius={4} />
                <SkeletonBox width="min(120px, 100%)" height={12} radius={4} />
              </div>
            </div>
            <div className="admin-student-status">
              <SkeletonBox width={76} height={16} radius={4} />
              <SkeletonBox width={52} height={18} radius={4} />
            </div>
            <div className="admin-student-action-slot admin-student-actions">
              <SkeletonBox width={112} height={32} radius={16} />
              <SkeletonBox width={82} height={32} radius={16} />
              <SkeletonBox width={92} height={32} radius={16} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PublishedProjectsLoading({ detail }: { detail: boolean }) {
  return (
    <section
      className={`sp-panel-surface admin-panel ${detail ? "admin-project-detail" : "admin-project-browser"}`}
      aria-busy="true"
    >
      <PublishedProjectsHeading detail={detail}>
        {!detail && (
          <div className="sp-search" aria-hidden="true">
            <SkeletonBox width="min(175px, 70%)" height={14} radius={4} />
          </div>
        )}
        <span className="sp-close-button" aria-hidden="true" />
      </PublishedProjectsHeading>
      {detail ? (
        <div className="admin-detail-columns">
          <div>
            <div className="admin-project-cover">
              <SkeletonBox width="100%" height="100%" radius={24} />
            </div>
            <h2>
              <SkeletonBox width="70%" height={24} radius={4} />
            </h2>
          </div>
          <PublishedStudentsLoading />
        </div>
      ) : (
        <>
          <div className="sp-tabs" aria-hidden="true">
            <SkeletonBox width={240} height={20} radius={4} />
          </div>
          <LoadingSkeleton label="Loading projects" layout="cards" />
        </>
      )}
    </section>
  );
}
