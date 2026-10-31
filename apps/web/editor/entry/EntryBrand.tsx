import mark from "./assets/landmark.svg";

export function EntryBrand() {
  return (
    <a className="entry-brand" href="/landing" aria-label="Spatia home">
      <span>
        <img src={mark} alt="" />
      </span>
      Spatia
    </a>
  );
}
