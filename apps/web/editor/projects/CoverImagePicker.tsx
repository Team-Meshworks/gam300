import { useEffect, useId, useRef, useState, type RefObject } from "react";

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
        accept="image/png,image/jpeg,image/webp"
        className="sp-sr-only"
        tabIndex={-1}
        aria-label="Choose cover image"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!selected) return;
          if (
            !["image/png", "image/jpeg", "image/webp"].includes(selected.type) ||
            selected.size > 2 * 1024 * 1024
          ) {
            setError("Choose a JPEG, PNG or WebP image no larger than 2 MB.");
            return;
          }
          setError("");
          onChange(selected);
        }}
      />
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
          <figcaption>
            <span>{file.name}</span>
            <button
              type="button"
              className="sp-cover-remove"
              aria-label="Remove cover image"
              onClick={() => {
                onChange(null);
                setError("");
              }}
            >
              Remove image
            </button>
          </figcaption>
        </figure>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
