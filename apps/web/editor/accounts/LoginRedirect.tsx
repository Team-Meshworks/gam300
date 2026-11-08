import { useEffect, useRef } from "react";

// Replace the protected page so Back does not return to a signed-out workspace.
export function LoginRedirect() {
  const redirecting = useRef(false);
  const id = new URLSearchParams(location.search).get("projectId");
  const editorPath = location.pathname === "/" || location.pathname === "/index.html";
  const returnTo =
    editorPath && id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      ? "/?projectId=" + id
      : null;
  const href = returnTo ? "/login?returnTo=" + encodeURIComponent(returnTo) : "/login";
  useEffect(() => {
    // StrictMode can replay this effect while the first navigation is still pending.
    if (redirecting.current) return;
    redirecting.current = true;
    location.replace(href);
  }, [href]);

  return (
    <p role="status">
      Redirecting to login… <a href={href}>Log in</a>
    </p>
  );
}
