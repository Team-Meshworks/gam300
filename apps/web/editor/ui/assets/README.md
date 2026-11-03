# Stand and display toolbar SVGs

These files are unchanged full-instance SVG exports from the team's
[Figma design](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB?node-id=152-59981),
exported on 3 November 2026 with the Figma Plugin API (`exportAsync`, `SVG_STRING`).
They retain the source 40 × 40 viewport, internal padding, colour, fill opacity and strokes.
`Icon.tsx` imports them as image assets rather than redrawing or inlining their paths.

| File                            | Source node | Design name               | Runtime asset                     |
| ------------------------------- | ----------- | ------------------------- | --------------------------------- |
| `horizontal-stand.svg`          | `152:60024` | Horizontal Stand          | `display-rectangle-stand-v1`      |
| `vertical-stand.svg`            | `152:60025` | Vertical Stand            | `display-square-stand-v1`         |
| `horizontal-panel.svg`          | `152:60027` | Horizontal Panel          | `display-rectangle-panel-v1`      |
| `cube-display-case.svg`         | `152:62226` | Cube Display Case         | `display-cube-v1`                 |
| `clear-cube-display-case.svg`   | `152:62227` | Clear Cube Display Case   | `display-half-glass-case-v1`      |
| `clear-cuboid-display-case.svg` | `152:62228` | Clear Cubiod Display Case | `display-full-glass-case-v1`      |
| `cuboid-display-case.svg`       | `152:62229` | Cubiod Display Case       | `display-one-sided-glass-case-v1` |

The digital tray is node `152:60099` and the physical tray is node `152:62245`.
The design's fourth digital option, Vertical Panel, has no supplied GLB and remains
unavailable in the toolbar. Existing runtime labels and asset mappings are unchanged.
