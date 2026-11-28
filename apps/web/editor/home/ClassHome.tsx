import { LoadingSkeleton } from "../../shared/ui/LoadingSkeleton";
import { useEffect, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { classLabels } from "../projects/class-labels";
import { AssignmentListScreen } from "../projects/AssignmentListScreen";
import { Icon } from "@iconify/react/offline";
import closeIcon from "@iconify-icons/lucide/x";
import plusIcon from "@iconify-icons/lucide/plus";
import refreshIcon from "@iconify-icons/lucide/refresh-cw";
import checkIcon from "@iconify-icons/lucide/check";
import { Select } from "../../shared/ui/Select";
import { Avatar } from "../../shared/ui/Avatar";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { Dialog } from "../../shared/ui/Dialog";
import { Table } from "../../shared/ui/Table";
import {
  classroom,
  createClassroomClient,
  type Classroom,
  type ClassMember,
  type EligibleStudent,
} from "./classroom-api";
import { createWorkspaceClient } from "./workspace-api";
import { createDirectoryClient, type ManagedOrganization } from "../directory/directory-client";

import {
  finishConfirmedCreation,
  createOperationKey,
  readCreateOperation,
  sendCreateOperation,
} from "./create-operation";

import { PendingCreateRecovery } from "./PendingCreateRecovery";

const api = createWorkspaceClient();
const classesApi = createClassroomClient();
const accounts = createAccountClient();
const directory = createDirectoryClient();

export function ClassHome({
  session,
  active,
  onCreateAssignment,
  onOpenProject,
  onClose,
}: {
  session: AccountSession;
  active: boolean;
  onCreateAssignment: (classId: string) => void;
  onOpenProject: (projectId: string) => void;
  onClose?: () => void;
}) {
  const [classes, setClasses] = useState<Classroom[] | null>(null);
  const organisationView =
    session.role === "Educator" && new URLSearchParams(location.search).get("organisation") === "1";
  const [classId, setClassId] = useState(
    () => new URLSearchParams(location.search).get("classId") ?? "",
  );
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [roster, setRoster] = useState<{
    key: string;
    members: ClassMember[];
    eligible: EligibleStudent[];
  } | null>(null);
  const [rosterError, setRosterError] = useState("");
  const [name, setName] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [organizations, setOrganizations] = useState<ManagedOrganization[] | null>(null);
  const [organizationError, setOrganizationError] = useState("");
  const [dialog, setDialog] = useState<
    "create" | { userId: string; name: string; enrolled: boolean } | null
  >(() =>
    session.role === "Educator" &&
    session.orgId &&
    new URLSearchParams(location.search).get("create") === "1"
      ? "create"
      : null,
  );
  const [phase, setPhase] = useState<"ready" | "pending" | "unknown">("ready");
  const [notice, setNotice] = useState("");
  const [addedStudents, setAddedStudents] = useState<
    { classId: string; student: EligibleStudent }[]
  >([]);
  const busy = useRef(false);
  const operationKey = createOperationKey(session.userId, "class");
  const [recoverable, setRecoverable] = useState(true);
  const manager = session.role !== "Creator";
  const rosterKey = `${classId}:${refresh}`;
  useEffect(() => {
    if (!organisationView || !classes) return;
    const url = new URL(location.href);
    if (classId) url.searchParams.set("classId", classId);
    else url.searchParams.delete("classId");
    history.replaceState(history.state, "", url);
  }, [classId, classes, organisationView]);
  useEffect(() => {
    if (dialog !== "create" || session.role !== "Administrator") return;
    let active = true;
    void directory.organizations().then(
      async (rows) => {
        try {
          if ((await accounts.getSession())?.userId !== session.userId)
            throw new Error("Account changed");
          if (active) setOrganizations(rows.filter((row) => row.isActive));
        } catch {
          if (active)
            setOrganizationError(
              "Organisations are unavailable. Close and reopen this form to retry.",
            );
        }
      },
      () => {
        if (active)
          setOrganizationError(
            "Organisations are unavailable. Close and reopen this form to retry.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [dialog, session.role, session.userId]);
  useEffect(() => {
    const controller = new AbortController();
    void classesApi
      .classes(controller.signal)
      .then(async (rows) => {
        if ((await accounts.getSession())?.userId !== session.userId)
          throw new Error("Account changed");
        if (controller.signal.aborted) return;
        setClasses(rows);
        setError("");
        setClassId((selected) =>
          rows.some((row) => row.id === selected) ? selected : rows.length === 1 ? rows[0]!.id : "",
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setClasses(null);
          setError("Classes are unavailable for your account. Refresh to try again.");
        }
      });
    return () => controller.abort();
  }, [refresh, session.userId]);
  useEffect(() => {
    if (!classId || !manager) return;
    const controller = new AbortController();
    void classesApi
      .roster(classId, controller.signal)
      .then(async (rows) => {
        if ((await accounts.getSession())?.userId !== session.userId)
          throw new Error("Account changed");
        if (!controller.signal.aborted) {
          setRoster({ key: rosterKey, ...rows });
          setRosterError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setRosterError("The class roster is unavailable. Refresh before making changes.");
      });
    return () => controller.abort();
  }, [classId, rosterKey, manager, session.userId]);
  useEffect(() => {
    if (phase !== "pending") return;
    const preventLoss = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [phase]);
  async function save(retry = false, member?: { userId: string; name: string; enrolled: boolean }) {
    const action = member ?? dialog;
    if (!active || (!retry && (!action || phase !== "ready")) || busy.current) return;
    busy.current = true;
    setPhase("pending");
    setNotice("");
    const result =
      action === "create" || retry
        ? await sendCreateOperation(
            localStorage,
            operationKey,
            session.userId,
            api.write,
            (value) => {
              try {
                const created = classroom(value);
                const pending = readCreateOperation(localStorage, operationKey, session.userId);
                return (
                  created.name === pending?.body.name &&
                  created.organizationId === (pending?.body.orgId ?? session.orgId)
                );
              } catch {
                return false;
              }
            },
            retry
              ? undefined
              : {
                  path: "/api/v1/classes",
                  body: {
                    name: name.trim(),
                    ...(session.role === "Administrator" ? { orgId: organizationId } : {}),
                  },
                },
          )
        : await api.write(
            session.userId,
            `/api/v1/classes/${encodeURIComponent(classId)}/members/${encodeURIComponent(typeof action === "object" && action ? action.userId : "")}`,
            typeof action === "object" && action?.enrolled ? "DELETE" : "PUT",
          );
    busy.current = false;
    try {
      setRecoverable(readCreateOperation(localStorage, operationKey, session.userId) !== null);
    } catch {
      setRecoverable(true);
    }
    let verified =
      result.kind === "confirmed" && (action !== "create" ? result.value === null : false);
    if (result.kind === "confirmed" && (action === "create" || retry)) {
      try {
        const created = classroom(result.value);
        verified =
          retry ||
          (created.name === name.trim() &&
            created.organizationId === (session.orgId ?? organizationId));
        if (verified) setClassId(created.id);
      } catch {
        verified = false;
      }
    }
    if (verified) {
      if (action === "create" && !retry && result.kind === "confirmed") {
        if (
          await finishConfirmedCreation(
            localStorage,
            session.userId,
            "class",
            result.value,
            api.write,
          )
        )
          setRecoverable(false);
      }
      if (member && !member.enrolled) {
        const student = roster?.eligible.find((row) => row.userId === member.userId);
        if (student) setAddedStudents((rows) => [...rows, { classId, student }]);
      }
      setPhase("ready");
      setDialog(null);
      setNotice("");
      if (!member) setRefresh((value) => value + 1);
    } else if (result.kind === "rejected") {
      setPhase("ready");
      setNotice(result.message);
    } else {
      if (member) setDialog(member);
      setPhase("unknown");
      setNotice(
        "The result is uncertain. Refresh classes and check the roster before making another change.",
      );
      setRefresh((value) => value + 1);
    }
  }
  function openClassForm() {
    if (recoverable) return;
    setName("");
    setOrganizationId("");
    setOrganizations(null);
    setOrganizationError("");
    setNotice("");
    setDialog("create");
  }
  const labels = classLabels((classes ?? []).map((row) => ({ id: row.id, label: row.name })));
  const currentRoster = roster?.key === rosterKey && !rosterError ? roster : null;
  const availableStudents = currentRoster
    ? [
        ...currentRoster.eligible.filter((student) => !student.enrolled),
        ...addedStudents
          .filter(
            (row) =>
              row.classId === classId &&
              !currentRoster.eligible.some(
                (student) => student.userId === row.student.userId && !student.enrolled,
              ),
          )
          .map((row) => row.student),
      ]
    : [];
  const studentNames = Object.fromEntries(
    currentRoster?.members.map((member) => [member.userId, member.userName]) ?? [],
  );
  const canRetry = (() => {
    try {
      const operation = readCreateOperation(localStorage, operationKey, session.userId);
      return operation !== null && !operation.receipt;
    } catch {
      return false;
    }
  })();
  const recoveryPanel = (
    <div className="sp-class-recovery">
      <PendingCreateRecovery
        actorId={session.userId}
        purpose="class"
        refreshKey={phase + notice}
        onPendingChange={setRecoverable}
        onRecovered={(value) => {
          setClassId(value.id);
          setDialog(null);
          setPhase("ready");
          setRefresh((value) => value + 1);
        }}
        active={active && phase !== "pending"}
        onReleased={() => {
          setPhase("ready");
          setDialog(null);
          setRefresh((value) => value + 1);
          setNotice(
            "The saved class request was released. Its outcome remains unknown. A new class is a separate creation.",
          );
        }}
      />
    </div>
  );
  return (
    <section
      aria-label="Classes"
      className={`sp-class-home${organisationView ? " sp-organisation-view sp-panel-surface" : ""}`}
    >
      {canRetry && !dialog && (
        <p role="alert">
          An earlier class creation needs confirmation.
          <Button disabled={!active || phase === "pending"} onClick={() => void save(true)}>
            Retry same class
          </Button>
        </p>
      )}
      {!dialog && recoveryPanel}
      <div className="sp-page-heading sp-between">
        <div>
          <h1>{organisationView ? "Organisation Details" : "Classes"}</h1>
          <p>
            {organisationView
              ? "View your organisation’s classes and their members."
              : "Find your class, assignments and instructions."}
          </p>
        </div>
        {organisationView && (
          <Button
            className="sp-close-button sp-organisation-close"
            aria-label="Close organisation"
            disabled={phase === "pending"}
            onClick={onClose}
          >
            <Icon icon={closeIcon} aria-hidden="true" />
          </Button>
        )}
        {manager && !organisationView && (
          <div className="sp-actions">
            <Button
              variant="primary"
              disabled={organisationView && !classId}
              onClick={() =>
                organisationView
                  ? location.assign(`/new-project?${new URLSearchParams({ classId })}`)
                  : onCreateAssignment(classId)
              }
            >
              {organisationView ? "New Project" : "New assignment"}
            </Button>
          </div>
        )}
      </div>
      {organisationView && (
        <div className="sp-organisation-identity">
          <Avatar name={session.orgName ?? "Organisation"} />
          <h2>{session.orgName ?? "Your Organisation"}</h2>
        </div>
      )}
      <div className="sp-home-toolbar">
        {session.role === "Educator" ? (
          <Select
            label="Class"
            value={classId}
            placeholder={
              classes === null
                ? error
                  ? "Unavailable"
                  : "Loading…"
                : classes.length
                  ? organisationView
                    ? "Select class"
                    : "Select a class"
                  : "No classes"
            }
            options={
              classes?.map((row) => ({
                value: row.id,
                label: labels.get(row.id)!,
              })) ?? []
            }
            disabled={!classes?.length}
            className="sp-organisation-class-select"
            menuClassName={`sp-organisation-class-menu${organisationView ? "" : " sp-legacy-class-menu"}`}
            onChange={(value) => {
              setClassId(value);
              setRosterError("");
            }}
          />
        ) : session.role === "Administrator" ? (
          <Select
            label="Class"
            className="sp-field sp-admin-select"
            menuClassName="sp-admin-select-menu"
            value={classId}
            disabled={!classes?.length}
            options={[
              { value: "", label: "Choose a class" },
              ...(classes?.map((row) => ({
                value: row.id,
                label: labels.get(row.id)!,
              })) ?? []),
            ]}
            onChange={(value) => {
              setClassId(value);
              setRosterError("");
            }}
          />
        ) : (
          <Field id="home-class" label="Class">
            <select
              id="home-class"
              value={classId}
              onChange={(event) => {
                setClassId(event.target.value);
                setRosterError("");
              }}
            >
              <option value="">Choose a class</option>
              {classes?.map((row) => (
                <option key={row.id} value={row.id}>
                  {labels.get(row.id)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {(organisationView || session.role === "Educator") && (
          <Button
            variant="primary"
            className="sp-class-create-action"
            disabled={recoverable || (session.role === "Educator" && !session.orgId)}
            onClick={openClassForm}
          >
            <Icon icon={plusIcon} width={16} aria-hidden="true" />
            <span className="sp-button-label">New Class</span>
          </Button>
        )}
        <Button
          variant="secondary"
          className="sp-class-refresh-action"
          onClick={() => {
            setAddedStudents([]);
            setRosterError("");
            setRefresh((value) => value + 1);
          }}
        >
          <Icon icon={refreshIcon} width={16} aria-hidden="true" />
          <span className="sp-button-label">
            {organisationView ? "Refresh" : "Refresh classes"}
          </span>
        </Button>
      </div>
      {organisationView && classes && classes.length > 0 && !classId && (
        <p className="sp-hint" role="status">
          Select a class to view its projects and members.
        </p>
      )}
      {error ? (
        <p role="alert">{error}</p>
      ) : !classes ? (
        organisationView ? (
          <>
            <div className="sp-class-assignments">
              <LoadingSkeleton label="Loading class projects" />
            </div>
            <div className="sp-card">
              <LoadingSkeleton label="Loading class members" />
            </div>
          </>
        ) : (
          <LoadingSkeleton label="Loading classes" />
        )
      ) : classes.length === 0 ? (
        <p role="status">
          {session.role === "Educator" && !session.orgId
            ? "Your account is not assigned to an organisation. Ask your administrator to assign one before creating a class."
            : session.role === "Educator"
              ? "No classes yet. Choose New Class to create one, then add existing students."
              : "No classes are available for your account."}
        </p>
      ) : null}
      {notice && !dialog && (
        <p role="status" className="sp-home-notice">
          {notice}
        </p>
      )}
      {classId && classes?.some((row) => row.id === classId) && (
        <>
          <div className="sp-class-assignments">
            {organisationView && (
              <div className="sp-class-project-heading">
                <h2>Class Projects</h2>
                {manager && (
                  <Button
                    className="sp-class-project-create"
                    onClick={() =>
                      location.assign(`/new-project?${new URLSearchParams({ classId })}`)
                    }
                  >
                    <Icon icon={plusIcon} width={16} aria-hidden="true" />
                    <span className="sp-button-label">New Project</span>
                  </Button>
                )}
              </div>
            )}
            <AssignmentListScreen
              key={`${classId}:${refresh}`}
              classId={classId}
              studentNames={studentNames}
              ownProject={session.role === "Creator"}
              {...(organisationView
                ? {
                    onOpenAssignment: (assignmentId: string) =>
                      location.assign(`/home?${new URLSearchParams({ classId, assignmentId })}`),
                  }
                : {})}
              onOpenProject={onOpenProject}
            />
          </div>
          {manager && (
            <section aria-label="Class roster" className="sp-card">
              <h2>{organisationView ? "Class Members" : "Class roster"}</h2>
              <p className="sp-hint">
                {organisationView
                  ? "Facilitators and students in the selected class."
                  : "Enrolled students can receive independent assignment drafts. Removing a member ends their class access."}
              </p>
              {rosterError ? (
                <p role="alert">{rosterError}</p>
              ) : !currentRoster ? (
                <LoadingSkeleton label="Loading roster" />
              ) : (
                <>
                  <Table
                    caption="Current class members"
                    headings={
                      organisationView
                        ? ["Account", "Role", "Status"]
                        : ["Name", "Role", "Account", "Class access"]
                    }
                  >
                    {currentRoster.members.map((member) => (
                      <tr key={member.userId}>
                        <th scope="row">
                          {organisationView ? `@${member.userName}` : member.userName}
                        </th>
                        <td>
                          {member.role === "Educator"
                            ? organisationView
                              ? "Facilitator"
                              : "Teacher"
                            : "Student"}
                        </td>
                        <td data-active={member.accountActive}>
                          {member.accountActive ? "Active" : "Inactive"}
                        </td>
                        {!organisationView && (
                          <td>
                            <Button
                              aria-label={`Remove ${member.userName}`}
                              title="Remove class access; saved work is retained"
                              onClick={() => {
                                setNotice("");
                                setDialog({
                                  userId: member.userId,
                                  name: member.userName,
                                  enrolled: true,
                                });
                              }}
                            >
                              {organisationView ? "Remove" : `Remove ${member.userName}`}
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </Table>
                  {!currentRoster.members.length && <p role="status">No members are enrolled.</p>}
                  {organisationView && !availableStudents.length && (
                    <p className="sp-organisation-account-hint">
                      Your administrator creates accounts for new students.
                    </p>
                  )}
                  {(!organisationView || availableStudents.length > 0) && (
                    <>
                      <h3 className="sp-home-notice">
                        {organisationView ? "Add Students" : "Add students"}
                      </h3>
                      {organisationView && (
                        <p className="sp-hint">
                          Choose existing student accounts from your organisation.
                        </p>
                      )}
                      <ul className="sp-class-students">
                        {availableStudents.map((student) => (
                          <li key={student.userId}>
                            <span>{student.userName}</span>
                            {organisationView &&
                            addedStudents.some(
                              (row) =>
                                row.classId === classId && row.student.userId === student.userId,
                            ) ? (
                              <span className="sp-class-added" role="status">
                                Added to class
                                <Icon icon={checkIcon} width={14} height={14} aria-hidden="true" />
                              </span>
                            ) : (
                              <Button
                                disabled={phase !== "ready"}
                                aria-label={
                                  organisationView
                                    ? `Add ${student.userName} to class`
                                    : `Enrol ${student.userName}`
                                }
                                onClick={() => {
                                  setNotice("");
                                  const member = {
                                    userId: student.userId,
                                    name: student.userName,
                                    enrolled: false,
                                  };
                                  if (organisationView) void save(false, member);
                                  else setDialog(member);
                                }}
                              >
                                {organisationView ? "Add to Class" : `Enrol ${student.userName}`}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                      {!currentRoster.eligible.some((student) => !student.enrolled) && (
                        <p className="sp-hint">No other eligible students are available.</p>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      {dialog && active && (
        <Dialog
          {...(organisationView || (session.role === "Educator" && dialog === "create")
            ? {
                variant: "admin" as const,
                className:
                  dialog === "create"
                    ? "sp-class-form-dialog sp-dialog--form"
                    : "sp-organisation-dialog",
              }
            : {})}
          title={
            dialog === "create"
              ? organisationView
                ? "New Class"
                : "New class"
              : dialog.enrolled
                ? "Remove class member"
                : organisationView
                  ? "Add Student to Class"
                  : "Enrol student"
          }
          onClose={() => {
            if (phase !== "pending") {
              setDialog(null);
              setPhase("ready");
            }
          }}
        >
          {dialog === "create" && canRetry && phase !== "pending" && (
            <Button onClick={() => void save(true)}>Retry same class</Button>
          )}
          {phase === "unknown" ? (
            <p role="alert">{notice}</p>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset className="sp-home-fields" disabled={phase === "pending"}>
                <legend className="sp-sr-only">Class change</legend>
                {dialog === "create" ? (
                  <>
                    <Field id="class-name" label="Class name">
                      <input
                        id="class-name"
                        required
                        maxLength={256}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                    {session.role === "Administrator" && (
                      <Field id="class-organization" label="Organisation">
                        <select
                          id="class-organization"
                          required
                          value={organizationId}
                          onChange={(event) => setOrganizationId(event.target.value)}
                        >
                          <option value="">Choose an organisation</option>
                          {organizations?.map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                    {session.role === "Administrator" &&
                      (organizationError ? (
                        <p role="alert">{organizationError}</p>
                      ) : organizations === null ? (
                        <LoadingSkeleton label="Loading organisations" />
                      ) : !organizations.length ? (
                        <p role="status">No active organisations are available.</p>
                      ) : null)}
                  </>
                ) : (
                  <p>
                    {dialog.enrolled
                      ? `Remove ${dialog.name} from this class? Their saved work is retained, but class access ends. ${dialog.userId === session.userId ? "You are removing your own access." : ""}`
                      : `Enrol ${dialog.name} in this class?`}
                  </p>
                )}
                {notice && <p role="alert">{notice}</p>}
                <div className="sp-actions sp-form-dialog-actions">
                  {(organisationView || (session.role === "Educator" && dialog === "create")) && (
                    <Button
                      disabled={phase === "pending"}
                      onClick={() => {
                        setDialog(null);
                        setPhase("ready");
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      dialog === "create" &&
                      (!name.trim() || (session.role === "Administrator" && !organizationId))
                    }
                  >
                    {phase === "pending"
                      ? "Saving…"
                      : organisationView
                        ? dialog === "create"
                          ? "Create Class"
                          : "Add to Class"
                        : "Confirm"}
                  </Button>
                </div>
              </fieldset>
            </form>
          )}
          {dialog === "create" && recoveryPanel}
        </Dialog>
      )}
    </section>
  );
}
