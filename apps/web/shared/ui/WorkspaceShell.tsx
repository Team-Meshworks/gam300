import type { MouseEventHandler, ReactNode } from "react";
import { WorkspaceHeader, type WorkspaceHeaderProps } from "./WorkspaceHeader";
import washLeft from "./assets/ambient-left.svg";
import washRight from "./assets/ambient-right.svg";
import adminWashLeft from "./assets/facilitator-ambient-top.svg";
import adminWashRight from "./assets/facilitator-ambient-bottom.svg";

export function WorkspaceShell({
  header,
  variant,
  appearance,
  footer,
  onClick,
  children,
}: {
  header: WorkspaceHeaderProps;
  variant?: "dashboard" | "asset-administration" | "creator" | "facilitator" | undefined;
  appearance?: "admin" | { washLeft: string; washRight: string } | undefined;
  footer?: ReactNode;
  onClick?: MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  const washes =
    appearance === "admin" || (!appearance && variant === "dashboard")
      ? { washLeft: adminWashLeft, washRight: adminWashRight }
      : appearance;
  return (
    <div
      className={`sp-shell${variant ? ` sp-shell--${variant}` : ""}`}
      data-account-role={header.account?.role}
      onClick={onClick}
    >
      <img className="sp-wash sp-wash--left" src={washes?.washLeft ?? washLeft} alt="" />
      <img className="sp-wash sp-wash--right" src={washes?.washRight ?? washRight} alt="" />
      <WorkspaceHeader {...header} />
      <main id="workspace" className="sp-workspace" tabIndex={-1}>
        {children}
      </main>
      {footer}
    </div>
  );
}
