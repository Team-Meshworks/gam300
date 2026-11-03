import { Button } from "./Button";

export function PageState({
  state,
  onRetry,
}: {
  state: "loading" | "empty" | "error";
  onRetry: () => void;
}) {
  return (
    <div className="sp-page-state" role={state === "error" ? "alert" : "status"} aria-live="polite">
      <h3>
        {state === "loading"
          ? "Loading…"
          : state === "empty"
            ? "Nothing to show yet"
            : "We couldn’t load this view"}
      </h3>
      <p>
        {state === "loading"
          ? "Getting everything ready."
          : state === "empty"
            ? "Results will appear here when they’re available."
            : "Try again. Your entered details are still here."}
      </p>
      {state === "error" && <Button onClick={onRetry}>Retry</Button>}
    </div>
  );
}
