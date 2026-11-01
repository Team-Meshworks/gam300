import type { ReactNode } from "react";

export function Table({
  caption,
  headings,
  children,
}: {
  caption: string;
  headings: readonly string[];
  children: ReactNode;
}) {
  return (
    <div className="sp-table-scroll">
      <table className="sp-table">
        <caption className="sp-sr-only">{caption}</caption>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading} scope="col">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
