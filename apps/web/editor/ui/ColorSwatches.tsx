import { exhibitColors } from "../../shared/project/project-appearance";
import "./color-swatches.css";

export function ColorSwatches({
  value,
  backgrounds = false,
  foreground = false,
  compact = false,
  onChange,
}: {
  value: string | undefined;
  backgrounds?: boolean;
  foreground?: boolean;
  compact?: boolean;
  onChange: (color: string) => void;
}) {
  const colors = backgrounds
    ? [...exhibitColors, "#ffffff", "transparent"]
    : foreground
      ? ["#292522", "#ffffff", ...exhibitColors]
      : exhibitColors;
  return (
    <div
      className={`color-swatch-grid${colors.length === 10 ? " has-background-options" : ""}${compact ? " is-compact" : ""}`}
    >
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          className={`color-swatch${color === "#ffffff" || color === "transparent" ? " is-light" : ""}`}
          aria-label={
            backgrounds
              ? color === "transparent"
                ? "Transparent background"
                : `Background ${color}`
              : foreground
                ? `Text color ${color}`
                : `Colour ${color}`
          }
          title={color === "transparent" ? "Transparent" : color === "#ffffff" ? "White" : color}
          aria-pressed={value === color}
          style={{ background: color }}
          onClick={() => onChange(color)}
        >
          {color === "transparent" ? (
            <span className="transparent-swatch-mark" aria-hidden="true" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
