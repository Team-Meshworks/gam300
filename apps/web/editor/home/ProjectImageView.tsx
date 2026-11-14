import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import move from "@iconify-icons/lucide/move";
import type { ProjectImage } from "../projects/project-image";
import { Button } from "../../shared/ui/Button";
import "./project-image.css";

export function ProjectImageView({
  image,
  fallback,
  className,
}: {
  image?: ProjectImage | null;
  fallback: string;
  className: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (image?.type !== "panorama" || !mount.current) return;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setError("");
    void import("../graphics/project-panorama")
      .then(({ createProjectPanorama }) => {
        if (controller.signal.aborted || !mount.current) return;
        return createProjectPanorama(mount.current, image.url, controller.signal);
      })
      .then((cleanup) => {
        if (controller.signal.aborted) cleanup?.();
        else dispose = cleanup;
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("The 360-degree preview could not be loaded.");
      });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [image?.type, image?.url, attempt]);
  if (image?.type !== "panorama")
    return <img className={className} src={image?.url ?? fallback} alt="" />;
  return (
    <div className={`${className} sp-project-panorama`}>
      <div
        ref={mount}
        role="img"
        aria-label="360-degree project image. Drag or use arrow keys to look around."
        tabIndex={0}
      />
      {error ? (
        <div className="sp-panorama-message" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
        </div>
      ) : (
        <span className="sp-panorama-hint" aria-hidden="true">
          <Icon icon={move} width={22} height={22} />
        </span>
      )}
    </div>
  );
}
