import type { ReactNode } from "react";
import { Icon } from "@iconify/react/offline";
import landmark from "@iconify-icons/lucide/landmark";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import "./workspace-header.css";

export type WorkspaceHeaderProps = {
  account: { displayName: string; role?: string } | null;
  homeHref: string;
  onHome?: () => void;
  onSignOut?: () => void;
  locked?: boolean;
  actions?: ReactNode;
};

const graphemes =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
function initials(name: string, single: boolean) {
  const words = name.trim().split(/\s+/);
  const letters = (word: string) =>
    graphemes ? Array.from(graphemes.segment(word), (part) => part.segment) : Array.from(word);
  const first = letters(words[0] ?? "");
  if (single) return (first[0] ?? "?").toLocaleUpperCase();
  const second = words[1] ? letters(words[1])[0] : first[1];
  return ((first[0] ?? "?") + (second ?? "")).toLocaleUpperCase();
}

export function WorkspaceHeader({
  account,
  homeHref,
  onHome,
  onSignOut,
  locked = false,
  actions,
}: WorkspaceHeaderProps) {
  const role = account?.role;
  return (
    <header className="sp-account-header" data-role={role}>
      <a
        className="sp-header-brand"
        aria-label="Spatia home"
        href={locked ? undefined : homeHref}
        role={locked ? "link" : undefined}
        aria-disabled={locked || undefined}
        onClick={(event) => {
          if (locked || !onHome || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          onHome();
        }}
      >
        <span className="sp-header-mark">
          <Icon icon={landmark} width={22} aria-hidden="true" />
        </span>
        Spatia
      </a>
      {account && (
        <div className="sp-header-account">
          <Avatar
            name={account.displayName}
            initials={initials(account.displayName, role === "Creator")}
          />
          <span className="sp-header-name" title={account.displayName}>
            {account.displayName}
          </span>
          <Button className="sp-header-logout" disabled={locked || !onSignOut} onClick={onSignOut}>
            Log Out
          </Button>
          {actions && <div inert={locked}>{actions}</div>}
        </div>
      )}
    </header>
  );
}
