import type { ReactNode } from "react";

export function PublishedProjectsHeading({
  detail = false,
  children,
}: {
  detail?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="admin-project-view-heading sp-admin-page-heading">
      <div>
        <h1>{detail ? "Published Projects" : "All Published Projects"}</h1>
        <p>Review published experiences and control what visitors can explore.</p>
      </div>
      {children}
    </div>
  );
}
