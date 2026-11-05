import { Icon, type IconName } from "./Icon";
import selectedRail from "./assets/editor-video-selected-bg.svg?no-inline";
import "./library-rail.css";

export function LibraryRail({ icon, label }: { icon: IconName; label: string }) {
  return (
    <aside className="library-rail" aria-label={label}>
      <span
        className="library-rail-shape"
        style={{ maskImage: `url(${selectedRail})` }}
        aria-hidden="true"
      />
      <Icon name={icon} />
    </aside>
  );
}
