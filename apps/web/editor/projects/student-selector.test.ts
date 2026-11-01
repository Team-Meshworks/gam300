import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { StudentSelector } from "./StudentSelector";

it("renders selected students without scanning the selection for each row", () => {
  const students = Array.from({ length: 300 }, (_, i) => ({
    id: String(i),
    name: `Student ${i}`,
    account: `@s${i}`,
    classIds: ["a"],
  }));
  let reads = 0;
  const selected = new Proxy(
    students.map((student) => student.id),
    {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) reads++;
        return Reflect.get(target, property, receiver);
      },
    },
  );
  const html = renderToStaticMarkup(
    createElement(StudentSelector, { students, selected, onChange: () => {} }),
  );
  expect(html.match(/checked=""/g)).toHaveLength(300);
  expect(html).toContain("Student 299");
  expect(reads).toBeLessThanOrEqual(students.length * 2);
});
