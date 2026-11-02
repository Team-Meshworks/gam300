import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleInfo, faImage } from "@fortawesome/free-solid-svg-icons";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { playUiSound } from "../audio/ui-sounds";
import { StudentSelector } from "./StudentSelector";
import { ClassSelect } from "./ClassSelect";
import { CoverImagePicker } from "./CoverImagePicker";
import {
  validateNewProject,
  type NewProjectDraft,
  type ProjectClass,
  type EligibleStudent,
  type ProjectCreationResult,
} from "./new-project-form";
import "./new-project.css";

const emptyForm = {
  title: "",
  description: "",
  instructions: "",
  dueDate: "",
  classId: "",
  imageType: "Cover image",
};

export function NewProjectForm({
  organizationName,
  creatorName,
  classes,
  students,
  onSubmit,
  onCreated,
  onPreview,
  onCancel,
}: {
  organizationName: string;
  creatorName: string;
  classes: readonly ProjectClass[];
  students: readonly EligibleStudent[];
  onSubmit?: (draft: NewProjectDraft) => Promise<ProjectCreationResult>;
  onCreated?: (projectId: string) => void;
  onPreview?: (draft: NewProjectDraft) => void;
  onCancel?: () => void;
}) {
  const [phase, setPhase] = useState<"editing" | "pending" | "created" | "unknown">("editing");
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [phase]);
  const [form, setForm] = useState(emptyForm);
  const [selectorReset, setSelectorReset] = useState(0);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [coverImage, setCoverImage] = useState<File | null>(null);
  const available = students.filter(
    (student) => !form.classId || student.classIds.includes(form.classId),
  );
  function update(key: keyof typeof emptyForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }
  function checkedDraft() {
    if (!formRef.current?.reportValidity()) return;
    const checked = validateNewProject(
      { ...form, studentIds: selected, ...(coverImage ? { coverImage } : {}) },
      classes,
      students,
    );
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError("");
    return checked.value;
  }
  async function submit() {
    if (!onSubmit || inFlight.current || phase !== "editing") return;
    const draft = checkedDraft();
    if (!draft) return;
    inFlight.current = true;
    setPhase("pending");
    let result: ProjectCreationResult;
    try {
      result = await onSubmit(draft);
    } catch {
      result = { kind: "unknown" };
    }
    if (!mounted.current) return;
    inFlight.current = false;
    if (result.kind === "rejected") {
      setPhase("editing");
      setError(result.message);
    } else if (result.kind === "created" && result.projectId) {
      setPhase("created");
      playUiSound("save");
      try {
        onCreated?.(result.projectId);
      } catch {
        setError(
          "The project was created, but could not be opened. Find it in your projects before trying to create another.",
        );
      }
    } else {
      setPhase("unknown");
      setError(
        "Creation outcome is unknown. Check your projects before creating another; your details are still here.",
      );
    }
  }
  return (
    <form
      ref={formRef}
      aria-busy={phase === "pending"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!onSubmit && (
        <p className="sp-creation-notice" role="status">
          Project creation is not connected yet. Class rosters and assignment details are awaiting
          the backend integration.
        </p>
      )}
      {error && (
        <p className="sp-creation-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      {phase === "pending" && (
        <p role="status" className="sp-creation-notice">
          Creating project… Keep this page open.
        </p>
      )}
      {phase === "created" && (
        <p role="status" className="sp-creation-notice">
          Creation confirmed. Your project is ready to open.
        </p>
      )}
      <fieldset className="sp-project-fields" disabled={phase !== "editing"}>
        <legend className="sp-sr-only">New project details</legend>
        <div className="sp-project-columns">
          <div className="sp-project-details">
            <div>
              <h2>Project details</h2>
              <p className="sp-hint">
                Give your students a clear starting point. * Required fields
              </p>
            </div>
            <div className="sp-school-context">
              <div>
                <span>Organisation</span>
                <strong>{organizationName}</strong>
              </div>
              <div>
                <span>Created by</span>
                <strong>{creatorName}</strong>
              </div>
            </div>
            <Field id="project-title" label="Project title" required>
              <input
                id="project-title"
                required
                maxLength={120}
                value={form.title}
                onChange={(event) => update("title", event.target.value)}
                placeholder="Enter a title for your project"
              />
            </Field>
            <div className="sp-form-row">
              <ClassSelect
                id="project-class"
                classes={classes}
                value={form.classId}
                onChange={(value) => {
                  update("classId", value);
                  setSelected([]);
                  setSelectorReset((count) => count + 1);
                }}
              />
              <Field id="project-due" label="Due date" required>
                <input
                  id="project-due"
                  type="date"
                  required
                  value={form.dueDate}
                  onChange={(event) => update("dueDate", event.target.value)}
                />
              </Field>
            </div>
            <fieldset className="sp-image-options">
              <legend>Project image type</legend>
              <div>
                {["Cover image", "Gallery", "360°"].map((type) =>
                  type === "Gallery" ? (
                    <Button
                      key={type}
                      className="sp-gallery-button"
                      onClick={() => {
                        update("imageType", "Cover image");
                        coverInputRef.current?.click();
                      }}
                    >
                      <FontAwesomeIcon icon={faImage} aria-hidden="true" />
                      <span>Gallery</span>
                    </Button>
                  ) : (
                    <label key={type}>
                      <input
                        type="radio"
                        name="image-type"
                        value={type}
                        checked={form.imageType === type}
                        onChange={() => update("imageType", type)}
                      />
                      <FontAwesomeIcon icon={faImage} aria-hidden="true" />
                      <span>{type}</span>
                    </label>
                  ),
                )}
              </div>
              <p className="sp-hint">
                Select a cover picture from your device. The 360° viewer is not connected yet.
              </p>
            </fieldset>
            <div hidden={form.imageType !== "Cover image"}>
              <CoverImagePicker
                key={selectorReset}
                file={coverImage}
                onChange={setCoverImage}
                inputRef={coverInputRef}
              />
            </div>
            <Field id="project-description" label="Project description" required>
              <textarea
                id="project-description"
                required
                rows={5}
                value={form.description}
                onChange={(event) => update("description", event.target.value)}
                placeholder="Describe the theme, learning goals and the virtual museum or 3D experience students will create."
              />
            </Field>
            <Field
              id="project-instructions"
              label="Project instructions"
              required
              hint="Students will see these instructions in their project workspace."
            >
              <textarea
                id="project-instructions"
                aria-describedby="project-instructions-hint"
                required
                rows={6}
                value={form.instructions}
                onChange={(event) => update("instructions", event.target.value)}
                placeholder="Add the steps, exhibit requirements and submission guidelines students should follow."
              />
            </Field>
            <p className="sp-hint">
              <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" /> You can edit project
              details, students and the due date later.
            </p>
          </div>
          <StudentSelector
            key={selectorReset}
            students={available}
            selected={selected}
            onChange={setSelected}
          />
        </div>
        <footer className="sp-form-footer">
          <div>
            <strong>
              {selected.length} {selected.length === 1 ? "student" : "students"} selected
            </strong>
            <p className="sp-hint">
              Check your project details and selected students before creating.
            </p>
          </div>
          <div className="sp-actions">
            <Button
              disabled={!onCancel}
              onClick={() => {
                if (!inFlight.current && phase === "editing") onCancel?.();
              }}
            >
              Cancel
            </Button>
            {onPreview && (
              <Button
                onClick={() => {
                  const draft = checkedDraft();
                  if (draft) onPreview(draft);
                }}
              >
                Preview project
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={!onSubmit}>
              {phase === "pending" ? "Creating…" : "Create project"}
            </Button>
          </div>
        </footer>
      </fieldset>
    </form>
  );
}
