import type { MouseEventHandler, ReactNode } from "react";
import { WorkspaceHeader, type WorkspaceHeaderProps } from "./WorkspaceHeader";
import washLeft from "./assets/facilitator-ambient-top.svg";
import washRight from "./assets/facilitator-ambient-bottom.svg";

export function WorkspaceShell({
  header,
  variant,
  footer,
  onClick,
  children,
}: {
  header: WorkspaceHeaderProps;
  variant?: "dashboard" | "asset-administration" | "creator" | "facilitator" | undefined;
  footer?: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      className={`sp-shell${variant ? ` sp-shell--${variant}` : ""}`}
      data-account-role={header.account?.role}
      onClick={onClick}
    >
      <img className="sp-wash sp-wash--left" src={washLeft} alt="" />
      <img className="sp-wash sp-wash--right" src={washRight} alt="" />
      <WorkspaceHeader {...header} />
      <main id="workspace" className="sp-workspace" tabIndex={-1}>
        {children}
      </main>
      {footer}
    </div>
  );
}
