import type { ReactNode } from "react";
import { WorkspaceHeader, type WorkspaceHeaderProps } from "./WorkspaceHeader";
import washLeft from "./assets/ambient-left.svg";
import washRight from "./assets/ambient-right.svg";
import adminWashLeft from "./assets/admin-ambient-left.svg";
import adminWashRight from "./assets/admin-ambient-right.svg";

export function WorkspaceShell({
  header,
  variant,
  appearance,
  footer,
  children,
}: {
  header: WorkspaceHeaderProps;
  variant?: "dashboard" | "asset-administration" | "creator" | "facilitator" | undefined;
  appearance?: { washLeft: string; washRight: string } | undefined;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`sp-shell${variant ? ` sp-shell--${variant}` : ""}`}>
      <img
        className="sp-wash sp-wash--left"
        src={appearance?.washLeft ?? (variant === "dashboard" ? adminWashLeft : washLeft)}
        alt=""
      />
      <img
        className="sp-wash sp-wash--right"
        src={appearance?.washRight ?? (variant === "dashboard" ? adminWashRight : washRight)}
        alt=""
      />
      <WorkspaceHeader {...header} />
      <main id="workspace" className="sp-workspace" tabIndex={-1}>
        {children}
      </main>
      {footer}
    </div>
  );
}
