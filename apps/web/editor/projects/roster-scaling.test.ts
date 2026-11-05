import { expect, it } from "vitest";
import { validateNewProject } from "./new-project-form";
import { validateClassAssignment } from "./class-assignment";

it.each(["creation", "assignment"])(
  "validates a full roster without repeated roster scans: %s",
  (mode) => {
    let idReads = 0;
    const students = Array.from({ length: 1000 }, (_, i) => ({
      get id() {
        idReads++;
        return `student-${i}`;
      },
      name: `Student ${i}`,
      account: `@student${i}`,
      classIds: ["a"],
    }));
    const studentIds = students.slice(0, 20).map((student) => student.id);
    idReads = 0;
    const classes = [{ id: "a", label: "A" }];
    const result =
      mode === "creation"
        ? validateNewProject(
            {
              title: "Museum",
              description: "History",
              instructions: "Build",
              dueDate: "2028-02-29T15:30",
              classId: "a",
              imageType: "Cover image",
              studentIds,
            },
            classes,
            students,
          )
        : validateClassAssignment(
            { projectId: "p", classId: "a", studentIds },
            [{ id: "p", title: "Museum", classIds: ["a"] }],
            classes,
            students,
          );
    expect(result.ok).toBe(true);
    expect(idReads).toBeLessThanOrEqual(students.length * 2);
  },
);
