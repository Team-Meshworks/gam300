import { Icon } from "@iconify/react/offline";
import imageIcon from "@iconify-icons/lucide/image";
import { useId, useRef, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { CoverImagePicker } from "./CoverImagePicker";
import type { ProjectImage } from "./project-image";

export function ProjectImageFields({
  imageType,
  onType,
  imageFile,
  onFile,
}: {
  imageType: ProjectImage["type"];
  onType: (type: ProjectImage["type"]) => void;
  imageFile: File | null;
  onFile: (file: File | null) => void;
}) {
  const fileId = useId();
  const [gallerySelected, setGallerySelected] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <>
      <fieldset className="sp-image-options">
        <legend>Project image type</legend>
        <div>
          {["Cover image", "Gallery", "360°"].map((label) =>
            label === "Gallery" ? (
              <Button
                key={label}
                className="sp-gallery-button"
                aria-pressed={gallerySelected}
                onClick={() => fileInput.current?.click()}
              >
                <Icon icon={imageIcon} aria-hidden="true" />
                <span>Gallery</span>
              </Button>
            ) : (
              <label
                key={label}
                data-active={
                  !gallerySelected && imageType === (label === "360°" ? "panorama" : "cover")
                }
              >
                <input
                  type="radio"
                  name={fileId + "-image-type"}
                  value={label}
                  checked={imageType === (label === "360°" ? "panorama" : "cover")}
                  onChange={() => {
                    setGallerySelected(false);
                    onType(label === "360°" ? "panorama" : "cover");
                  }}
                />
                <Icon icon={imageIcon} aria-hidden="true" />
                <span>{label}</span>
              </label>
            ),
          )}
        </div>
      </fieldset>
      <div className="sp-project-image-field">
        <CoverImagePicker
          file={imageFile}
          onChange={(file) => {
            setGallerySelected(file !== null);
            onFile(file);
          }}
          inputRef={fileInput}
          inputId={fileId}
          renderActions={(remove) =>
            imageFile ? (
              <div className="sp-project-image-heading">
                <label htmlFor={fileId}>Image</label>
                <div className="sp-project-image-actions">
                  <button
                    type="button"
                    className="sp-image-remove"
                    aria-label="Remove selected image"
                    onClick={remove}
                  >
                    Remove
                  </button>
                  <Button onClick={() => fileInput.current?.click()}>
                    <Icon icon={imageIcon} width={16} height={16} aria-hidden="true" />
                    <span className="sp-button-label">Replace image</span>
                  </Button>
                </div>
              </div>
            ) : (
              <p className="sp-hint" id={fileId + "-hint"}>
                JPEG, PNG or WebP, up to 2 MB
              </p>
            )
          }
        />
      </div>
    </>
  );
}
