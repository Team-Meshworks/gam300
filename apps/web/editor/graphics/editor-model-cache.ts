import { ModelCache } from "../../shared/asset-runtime/ModelCache";

// The editor viewport and its library borrow from the same page-scoped model cache
export const editorModelCache = new ModelCache();
if (import.meta.hot) import.meta.hot.dispose(() => editorModelCache.invalidate());
