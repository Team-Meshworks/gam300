# Shared UI foundation

Reusable primitives for future workspace screens live here: `WorkspaceShell`, `Button`, `Field`, `SearchField`, `Tabs`, `Table`, `Avatar`, `Dialog`, and `PageState`, with shared styling in `foundation.css`. The examples exercise these building blocks; they are not integrated product screens.

`foundation.css` is a workspace entry baseline with global resets and fonts. Do not import it into the existing editor without migrating those styles to an appropriate scope.

From `apps/web`, run `npm run dev` and open `/ui-preview.html` at the Vite server URL. The isolated development entry shows New Project, Submission Review, and Accounts examples with sample data and selectable states. It uses no API, authentication, or storage, and is excluded from the production editor build. With the dev server listening on port 5181, run `npm run test:ui -- http://127.0.0.1:5181/ui-preview.html` for the preview check.

Design references in the Meshworks Figma file: [New Project](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=450-4686), [review](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=232-19739), [class assignment](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=232-19679), and [organisation detail](https://www.figma.com/design/QNpdfKb2Ge7vO8uG8HphxB/Meshworks?node-id=398-2628). These examples are a shared foundation, not complete implementations of those frames. New Project and review use Inter, supplied as static files by Fontsource. Organisation detail uses Satoshi in the design and remains future screen work. Icons use Font Awesome as required by the repository's icon conventions, so they differ from the Figma icons. Review preview actions intentionally have no backend.

The ambient artwork and brand landmark in `assets/ambient-left.svg`, `assets/ambient-right.svg`, and `assets/landmark.svg` originate from the New Project Figma frame (450:4686).
