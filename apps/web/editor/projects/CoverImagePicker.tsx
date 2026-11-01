import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Button } from "../../shared/ui/Button";

export function CoverImagePicker({
  file,
  onChange,
  inputRef,
}: {
  file: File | null;
  onChange: (file: File | null) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const image = useRef<HTMLImageElement>(null);
  const id = useId();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!file || !image.current) return;
    const url = URL.createObjectURL(file);
    image.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <section className="sp-cover-picker" aria-label="Cover image selection">
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept="image/*"
        className="sp-sr-only"
        tabIndex={-1}
        aria-label="Choose cover image"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!selected) return;
          if (selected.type && !selected.type.startsWith("image/")) {
            setError("Choose an image from your device.");
            return;
          }
          setError("");
          onChange(selected);
        }}
      />
      <div className="sp-actions">
        {file && (
          <Button
            onClick={() => {
              onChange(null);
              setError("");
            }}
          >
            Remove cover image
          </Button>
        )}
      </div>
      {file ? (
        <figure>
          <img
            ref={image}
            alt="Selected cover image"
            onError={() => {
              setError(
                "This image could not be displayed. Choose a supported image such as JPEG, PNG or WebP.",
              );
              onChange(null);
            }}
          />
          <figcaption>{file.name}</figcaption>
        </figure>
      ) : (
        <p className="sp-hint">No cover image selected.</p>
      )}
      <p className="sp-hint">
        Choose a picture from your device’s gallery or files. This preview stays on this device and
        is not uploaded.
      </p>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
