import { useEffect, useRef } from "react";

// Replace the protected page so Back does not return to a signed-out workspace.
export function LoginRedirect() {
  const redirecting = useRef(false);
  useEffect(() => {
    // StrictMode can replay this effect while the first navigation is still pending.
    if (redirecting.current) return;
    redirecting.current = true;
    location.replace("/login");
  }, []);

  return (
    <p role="status">
      Redirecting to login… <a href="/login">Log in</a>
    </p>
  );
}
