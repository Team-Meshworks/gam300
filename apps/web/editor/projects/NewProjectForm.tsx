import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react/offline";
import infoIcon from "@iconify-icons/lucide/info";
import imageIcon from "@iconify-icons/lucide/image";
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

export type FormNavigationState = { dirty: boolean; locked: boolean };

export function NewProjectForm({
  organizationName,
  creatorName,
  classes,
  students,
  showImageOptions = true,
  initialClassId = "",
  dateOnly = false,
  onClassChange,
  onSubmit,
  onCreated,
  onPreview,
  onCancel,
  onNavigationStateChange,
}: {
  organizationName: string;
  creatorName: string;
  classes: readonly ProjectClass[];
  students: readonly EligibleStudent[];
  showImageOptions?: boolean;
  initialClassId?: string;
  dateOnly?: boolean;
  onClassChange?: (classId: string) => void;
  onSubmit?: (draft: NewProjectDraft) => Promise<ProjectCreationResult>;
  onCreated?: (projectId: string) => void;
  onPreview?: (draft: NewProjectDraft) => void;
  onCancel?: () => void;
  onNavigationStateChange?: (state: FormNavigationState) => void;
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
  const [initialForm] = useState(() => ({
    ...emptyForm,
    classId: initialClassId,
  }));
  const [form, setForm] = useState(initialForm);
  const [selectorReset, setSelectorReset] = useState(0);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [coverImage, setCoverImage] = useState<File | null>(null);
  const [gallerySelected, setGallerySelected] = useState(false);
  const dirty =
    phase === "editing" &&
    (JSON.stringify(form) !== JSON.stringify(initialForm) ||
      selected.length > 0 ||
      coverImage !== null);
  useLayoutEffect(() => {
    onNavigationStateChange?.({ dirty, locked: phase === "pending" });
  }, [dirty, phase, onNavigationStateChange]);
  useEffect(
    () => () => onNavigationStateChange?.({ dirty: false, locked: false }),
    [onNavigationStateChange],
  );
  useEffect(() => {
    if (!dirty && phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty, phase]);
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
      dateOnly,
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
                custom={dateOnly}
                id="project-class"
                classes={classes}
                value={form.classId}
                onChange={(value) => {
                  update("classId", value);
                  setSelected([]);
                  setSelectorReset((count) => count + 1);
                  onClassChange?.(value);
                }}
              />
              <Field id="project-due" label={dateOnly ? "Due date" : "Due date and time"} required>
                <div
                  className={dateOnly ? "sp-date-control" : undefined}
                  data-empty={!form.dueDate}
                >
                  <input
                    id="project-due"
                    type={dateOnly ? "date" : "datetime-local"}
                    required
                    value={form.dueDate}
                    onChange={(event) => update("dueDate", event.target.value)}
                  />
                  {dateOnly && !form.dueDate && <span aria-hidden="true">Choose a date</span>}
                </div>
              </Field>
            </div>
            {showImageOptions && (
              <>
                <fieldset className="sp-image-options">
                  <legend>Project image type</legend>
                  <div>
                    {["Cover image", "Gallery", "360°"].map((type) =>
                      type === "Gallery" ? (
                        <Button
                          key={type}
                          className="sp-gallery-button"
                          aria-pressed={gallerySelected}
                          onClick={() => {
                            coverInputRef.current?.click();
                          }}
                        >
                          <Icon icon={imageIcon} aria-hidden="true" />
                          <span>Gallery</span>
                        </Button>
                      ) : (
                        <label key={type} data-active={!gallerySelected && form.imageType === type}>
                          <input
                            type="radio"
                            name="image-type"
                            value={type}
                            checked={form.imageType === type}
                            onChange={() => {
                              setGallerySelected(false);
                              update("imageType", type);
                            }}
                          />
                          <Icon icon={imageIcon} aria-hidden="true" />
                          <span>{type}</span>
                        </label>
                      ),
                    )}
                  </div>
                  <p className="sp-hint">
                    Choose the type of image students will use for this project. You can change this
                    later.
                  </p>
                </fieldset>
                <CoverImagePicker
                  key={selectorReset}
                  file={coverImage}
                  onChange={(file) => {
                    setCoverImage(file);
                    setGallerySelected(file !== null);
                  }}
                  inputRef={coverInputRef}
                />
              </>
            )}
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
            <p className="sp-hint sp-project-edit-hint">
              <span title="Project details, students and the due date can be edited later.">
                <Icon icon={infoIcon} width={14} height={14} aria-hidden="true" />
              </span>{" "}
              {dateOnly
                ? "You can edit project details, students and the due date later."
                : "Each selected student receives an independent draft with these instructions."}
            </p>
          </div>
          <StudentSelector
            key={selectorReset}
            students={available}
            emptyMessage={
              form.classId
                ? "No enrolled students are available in this class."
                : "Choose a class to see its students."
            }
            selected={selected}
            onChange={setSelected}
          />
        </div>
        <footer className="sp-form-footer">
          <div>
            <strong>
              {selected.length} {selected.length === 1 ? "student" : "students"} selected
            </strong>
            <p className="sp-hint">Choose students to assign this project when you create it.</p>
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
