import { Field } from "../../shared/ui/Field";
import type { ProjectClass } from "./new-project-form";

export function ClassSelect({
  id,
  classes,
  value,
  onChange,
}: {
  id: string;
  classes: readonly ProjectClass[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field id={id} label="Class" required>
      <select id={id} required value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select a class</option>
        {classes.map((item) => (
          <option key={item.id} value={item.id}>
            {item.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
