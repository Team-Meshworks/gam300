import { useEffect, useRef, useState } from "react";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { AssignmentListScreen } from "../projects/AssignmentScreens";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { Dialog } from "../../shared/ui/Dialog";
import { PageState } from "../../shared/ui/PageState";
import { Table } from "../../shared/ui/Table";
import {
  classroom,
  createClassroomClient,
  type Classroom,
  type ClassMember,
  type EligibleStudent,
} from "./classroom-api";
import { createWorkspaceClient } from "./workspace-api";

const api = createWorkspaceClient();
const classesApi = createClassroomClient();
const accounts = createAccountClient();

export function ClassHome({
  session,
  onCreateAssignment,
}: {
  session: AccountSession;
  onCreateAssignment: () => void;
}) {
  const [classes, setClasses] = useState<Classroom[] | null>(null);
  const [classId, setClassId] = useState("");
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
  const [dialog, setDialog] = useState<
    "create" | { userId: string; name: string; enrolled: boolean } | null
  >(null);
  const [phase, setPhase] = useState<"ready" | "pending" | "unknown">("ready");
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const manager = session.role !== "Creator";
  const rosterKey = `${classId}:${refresh}`;
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
  async function save() {
    if (!dialog || busy.current || phase !== "ready") return;
    busy.current = true;
    setPhase("pending");
    setNotice("");
    const result =
      dialog === "create"
        ? await api.write(session.userId, "/api/classes", "POST", {
            name: name.trim(),
            ...(session.role === "Administrator" ? { orgId: organizationId } : {}),
          })
        : await api.write(
            session.userId,
            `/api/classes/${encodeURIComponent(classId)}/members/${encodeURIComponent(dialog.userId)}`,
            dialog.enrolled ? "DELETE" : "PUT",
          );
    busy.current = false;
    let verified =
      result.kind === "confirmed" && (dialog !== "create" ? result.value === null : false);
    if (result.kind === "confirmed" && dialog === "create") {
      try {
        const created = classroom(result.value);
        verified =
          created.name === name.trim() &&
          created.organizationId === (session.orgId ?? organizationId);
        if (verified) setClassId(created.id);
      } catch {
        verified = false;
      }
    }
    if (verified) {
      setPhase("ready");
      setDialog(null);
      setNotice("Class change confirmed.");
      setRefresh((value) => value + 1);
    } else if (result.kind === "rejected") {
      setPhase("ready");
      setNotice(result.message);
    } else {
      setPhase("unknown");
      setNotice(
        "The result is uncertain. Refresh classes and check the roster before making another change.",
      );
      setRefresh((value) => value + 1);
    }
  }
  const currentRoster = roster?.key === rosterKey && !rosterError ? roster : null;
  const studentNames = Object.fromEntries(
    currentRoster?.members.map((member) => [member.userId, member.userName]) ?? [],
  );
  return (
    <section aria-label="Classes" className="sp-class-home">
      <div className="sp-page-heading sp-between">
        <div>
          <h1>Classes</h1>
          <p>Find your class, assignments and instructions.</p>
        </div>
        {manager && (
          <div className="sp-actions">
            <Button
              onClick={() => {
                setName("");
                setOrganizationId("");
                setNotice("");
                setDialog("create");
              }}
            >
              New class
            </Button>
            <Button variant="primary" onClick={onCreateAssignment}>
              New assignment
            </Button>
          </div>
        )}
      </div>
      <div className="sp-home-toolbar">
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
                {row.name}
              </option>
            ))}
          </select>
        </Field>
        <Button
          onClick={() => {
            setRosterError("");
            setRefresh((value) => value + 1);
          }}
        >
          Refresh classes
        </Button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !classes ? (
        <PageState state="loading" onRetry={() => {}} />
      ) : classes.length === 0 ? (
        <p role="status">No classes are available for your account.</p>
      ) : null}
      {notice && !dialog && (
        <p role="status" className="sp-home-notice">
          {notice}
        </p>
      )}
      {classId && classes?.some((row) => row.id === classId) && (
        <>
          <div className="sp-class-assignments">
            <AssignmentListScreen
              key={`${classId}:${refresh}`}
              classId={classId}
              studentNames={studentNames}
              ownProject={session.role === "Creator"}
            />
          </div>
          {manager && (
            <section aria-label="Class roster" className="sp-card">
              <h2>Class roster</h2>
              <p className="sp-hint">
                Enrolled students can receive independent assignment drafts. Removing a member ends
                their class access.
              </p>
              {rosterError ? (
                <p role="alert">{rosterError}</p>
              ) : !currentRoster ? (
                <p role="status">Loading roster…</p>
              ) : (
                <>
                  <Table
                    caption="Current class members"
                    headings={["Name", "Role", "Account", "Class access"]}
                  >
                    {currentRoster.members.map((member) => (
                      <tr key={member.userId}>
                        <th scope="row">{member.userName}</th>
                        <td>{member.role === "Educator" ? "Teacher" : "Student"}</td>
                        <td>{member.accountActive ? "Active" : "Inactive"}</td>
                        <td>
                          <Button
                            onClick={() => {
                              setNotice("");
                              setDialog({
                                userId: member.userId,
                                name: member.userName,
                                enrolled: true,
                              });
                            }}
                          >
                            Remove {member.userName}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </Table>
                  {!currentRoster.members.length && <p role="status">No members are enrolled.</p>}
                  <h3 className="sp-home-notice">Add students</h3>
                  <ul className="sp-class-students">
                    {currentRoster.eligible
                      .filter((student) => !student.enrolled)
                      .map((student) => (
                        <li key={student.userId}>
                          <span>{student.userName}</span>
                          <Button
                            onClick={() => {
                              setNotice("");
                              setDialog({
                                userId: student.userId,
                                name: student.userName,
                                enrolled: false,
                              });
                            }}
                          >
                            Enrol {student.userName}
                          </Button>
                        </li>
                      ))}
                  </ul>
                  {!currentRoster.eligible.some((student) => !student.enrolled) && (
                    <p className="sp-hint">No other eligible students are available.</p>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      {dialog && (
        <Dialog
          title={
            dialog === "create"
              ? "New class"
              : dialog.enrolled
                ? "Remove class member"
                : "Enrol student"
          }
          onClose={() => {
            if (phase !== "pending") {
              setDialog(null);
              setPhase("ready");
            }
          }}
        >
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
                      <Field
                        id="class-organization"
                        label="Organisation"
                        hint="Choose the organisation of an existing class."
                      >
                        <select
                          id="class-organization"
                          required
                          value={organizationId}
                          onChange={(event) => setOrganizationId(event.target.value)}
                        >
                          <option value="">Choose an organisation</option>
                          {classes
                            ?.filter(
                              (row, index, rows) =>
                                rows.findIndex(
                                  (item) => item.organizationId === row.organizationId,
                                ) === index,
                            )
                            .map((row) => (
                              <option key={row.organizationId} value={row.organizationId}>
                                Same organisation as {row.name}
                              </option>
                            ))}
                        </select>
                      </Field>
                    )}
                    {session.role === "Administrator" && !classes?.length && (
                      <p role="status">
                        Organisation selection is unavailable until an organisation directory is
                        connected.
                      </p>
                    )}
                  </>
                ) : (
                  <p>
                    {dialog.enrolled
                      ? `Remove ${dialog.name} from this class? Their saved work is retained, but class access ends. ${dialog.userId === session.userId ? "You are removing your own access." : ""}`
                      : `Enrol ${dialog.name} in this class?`}
                  </p>
                )}
                {notice && <p role="alert">{notice}</p>}
                <Button
                  type="submit"
                  variant="primary"
                  disabled={
                    dialog === "create" &&
                    (!name.trim() || (session.role === "Administrator" && !organizationId))
                  }
                >
                  {phase === "pending" ? "Saving…" : "Confirm"}
                </Button>
              </fieldset>
            </form>
          )}
        </Dialog>
      )}
    </section>
  );
}
