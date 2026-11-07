import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "../../shared/ui/Button";

export function PublicationShare({ url, unlisted = false }: { url: string; unlisted?: boolean }) {
  const [copyStatus, setCopyStatus] = useState("");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("Link copied.");
    } catch {
      setCopyStatus("Copy the link from the field above.");
    }
  }

  return (
    <section className="sp-publication-share" aria-label="Share your project">
      <h3>Share your project</h3>
      <p>
        {unlisted
          ? "Anyone with this link can open the published project."
          : "You and the selected signed-in viewers can open this publication."}
      </p>
      <QRCodeSVG
        value={url}
        size={208}
        marginSize={4}
        level="M"
        role="img"
        aria-label="QR code for the publication link"
      />
      <label htmlFor="publication-link">Publication link</label>
      <input
        id="publication-link"
        readOnly
        value={url}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button onClick={() => void copyLink()}>Copy link</Button>
      <p role="status">{copyStatus}</p>
    </section>
  );
}
