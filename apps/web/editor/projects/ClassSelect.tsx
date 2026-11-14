import { Select } from "../../shared/ui/Select";
import { Field } from "../../shared/ui/Field";
import type { ProjectClass } from "./new-project-form";

export function ClassSelect({
  id,
  classes,
  value,
  onChange,
  custom = false,
}: {
  custom?: boolean;
  id: string;
  classes: readonly ProjectClass[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (custom) {
    // Validate the selected class against current authorised choices before submitting
    return (
      <Select
        label="Class *"
        value={value}
        options={[
          { value: "", label: "Select a class" },
          ...classes.map((item) => ({ value: item.id, label: item.label })),
        ]}
        onChange={onChange}
        className="sp-project-class"
        menuClassName="sp-project-class-menu"
      />
    );
  }
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
