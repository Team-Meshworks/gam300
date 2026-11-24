import { useLayoutEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import { observeButtonLabelAlignment } from "./button-label-alignment";
import { WorkspaceHeader, type WorkspaceHeaderProps } from "./WorkspaceHeader";
import { updatePlainHover } from "./plain-control-hover";
import washLeft from "./assets/workspace-ambient-top.svg";
import washRight from "./assets/workspace-ambient-bottom.svg";

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
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!header.account || !root.current) return;
    return observeButtonLabelAlignment(root.current);
  }, [header.account?.role]);
  return (
    <div
      ref={root}
      className={`sp-shell${variant ? ` sp-shell--${variant}` : ""}`}
      data-account-role={header.account?.role}
      onPointerOver={(event) => updatePlainHover(event.target)}
      onClick={(event) => {
        onClick?.(event);
        const target = event.target;
        requestAnimationFrame(() => updatePlainHover(target));
      }}
    >
      <img className="sp-wash sp-wash--left" src={washLeft} alt="" />
      <img className="sp-wash sp-wash--right" src={washRight} alt="" />
      <WorkspaceHeader {...header} />
      <main
        id="workspace"
        className={`sp-workspace${variant === "creator" ? " sp-panel-surface" : ""}`}
        tabIndex={-1}
      >
        {children}
      </main>
      {footer}
    </div>
  );
}
