import type { ReactNode } from "react";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import landmark from "./assets/landmark.svg";
import washLeft from "./assets/ambient-left.svg";
import washRight from "./assets/ambient-right.svg";
import adminWashLeft from "./assets/admin-ambient-left.svg";
import adminWashRight from "./assets/admin-ambient-right.svg";

export function WorkspaceShell({
  name,
  initials,
  onSignOut,
  homeHref = "#new-project",
  variant,
  children,
}: {
  name: string;
  initials: string;
  onSignOut?: () => void;
  homeHref?: string;
  variant?: "dashboard" | undefined;
  children: ReactNode;
}) {
  return (
    <div className={`sp-shell${variant === "dashboard" ? " sp-shell--dashboard" : ""}`}>
      <img
        className="sp-wash sp-wash--left"
        src={variant === "dashboard" ? adminWashLeft : washLeft}
        alt=""
      />
      <img
        className="sp-wash sp-wash--right"
        src={variant === "dashboard" ? adminWashRight : washRight}
        alt=""
      />
      <header className="sp-navigation">
        <a className="sp-brand" href={homeHref} aria-label="Spatia home">
          <span className="sp-brand-mark">
            <img src={landmark} alt="" />
          </span>
          Spatia
        </a>
        <div className="sp-account">
          <Avatar name={name} initials={initials} />
          <span>{name}</span>
          <Button disabled={!onSignOut} onClick={onSignOut}>
            Log Out
          </Button>
        </div>
      </header>
      <main id="workspace" className="sp-workspace" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
