import type { ReactNode } from "react";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import landmark from "./assets/landmark.svg";
import washLeft from "./assets/ambient-left.svg";
import washRight from "./assets/ambient-right.svg";

export function WorkspaceShell({
  name,
  initials,
  onSignOut,
  onHome,
  homeHref = "#new-project",
  children,
}: {
  name: string;
  initials: string;
  onSignOut?: () => void;
  onHome?: () => void;
  homeHref?: string;
  children: ReactNode;
}) {
  return (
    <div className="sp-shell">
      <img className="sp-wash sp-wash--left" src={washLeft} alt="" />
      <img className="sp-wash sp-wash--right" src={washRight} alt="" />
      <header className="sp-navigation">
        <a
          className="sp-brand"
          href={onHome ? "/home" : homeHref}
          aria-label="Spatia home"
          onClick={
            onHome
              ? (event) => {
                  event.preventDefault();
                  onHome();
                }
              : undefined
          }
        >
          <span className="sp-brand-mark">
            <img src={landmark} alt="" />
          </span>
          Spatia
        </a>
        <div className="sp-account">
          <Avatar name={name} initials={initials} />
          <span className="sp-account-name" title={name}>
            {name}
          </span>
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
