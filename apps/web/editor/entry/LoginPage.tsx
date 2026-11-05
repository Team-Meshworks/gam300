import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowLeft,
  faEye,
  faEyeSlash,
  faUsers,
  faLayerGroup,
  faCube,
} from "@fortawesome/free-solid-svg-icons";
import { Button } from "../../shared/ui/Button";
import { Field } from "../../shared/ui/Field";
import { Dialog } from "../../shared/ui/Dialog";
import { createAccountClient, type AccountSession } from "../accounts/account-client";
import { leaveLinkWithUiSound } from "../audio/ui-sounds";
import { EntryBrand } from "./EntryBrand";
import exhibit from "./assets/login-exhibit.png";

const client = createAccountClient();

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [help, setHelp] = useState(false);
  const [session, setSession] = useState<AccountSession | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLHeadingElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    const current = generation.current;
    let cancelled = false;
    void client
      .getSession()
      .then((value) => {
        if (!cancelled && generation.current === current) setSession(value);
      })
      .catch((failure: unknown) => {
        if (!cancelled && generation.current === current) {
          setError(
            failure instanceof Error
              ? failure.message
              : "The account service is unavailable. Please try again later.",
          );
        }
      });
    return () => {
      mounted.current = false;
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (session?.role === "Administrator" && !session.mustChangePassword) {
      location.replace("/admin/dashboard");
    } else if (session) statusRef.current?.focus();
  }, [session]);
  async function submit() {
    if (busy.current) return;
    if (session?.mustChangePassword && (password === newPassword || newPassword !== confirmation)) {
      setError("Choose a different password and enter the same new password twice.");
      return;
    }
    busy.current = true;
    generation.current++;
    setPending(true);
    setError("");
    try {
      const next = session?.mustChangePassword
        ? await client.changePassword(password, newPassword)
        : await client.signIn(username, password);
      if (mounted.current) setSession(next);
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "Sign-in could not be completed.");
    } finally {
      busy.current = false;
      if (mounted.current) {
        setPending(false);
        setPassword("");
        setNewPassword("");
        setConfirmation("");
        setVisible(false);
      }
    }
  }
  async function signOut() {
    if (busy.current) return;
    busy.current = true;
    generation.current++;
    setPending(true);
    setError("");
    try {
      await client.signOut();
      if (mounted.current) setSession(null);
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : "Sign-out could not be confirmed.");
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <div className="entry-page login-page">
      <a className="sp-skip-link" href="#login-content">
        Skip to login
      </a>
      <header className="entry-header">
        <EntryBrand />
        <a
          className="entry-back"
          href="/landing"
          onClick={(event) => leaveLinkWithUiSound("goingBack", event)}
        >
          <FontAwesomeIcon icon={faArrowLeft} aria-hidden="true" />
          Back to home
        </a>
      </header>
      <main className="login-workspace" id="login-content" tabIndex={-1}>
        <div className="login-access">
          <div className="login-form">
            <div className="login-welcome">
              <p className="entry-eyebrow">Your next discovery starts here</p>
              <h1 ref={statusRef} tabIndex={-1}>
                {session
                  ? session.mustChangePassword
                    ? "Change your password."
                    : session.role === "Administrator"
                      ? "Opening your dashboard…"
                      : "You’re signed in."
                  : "Welcome back."}
              </h1>
              <p>
                {session
                  ? session.mustChangePassword
                    ? "Set a new password before accessing your classroom."
                    : `Welcome, ${session.displayName}.`
                  : "Log in to create, explore, and bring your classroom’s ideas to life."}
              </p>
            </div>
            {error && (
              <p className="entry-error" role="alert" tabIndex={-1} ref={errorRef}>
                {error}
              </p>
            )}
            {session && !session.mustChangePassword ? (
              <div className="login-confirmation">
                <p role="status">
                  Signed in as {session.displayName} · {session.role}
                </p>
                {session.role === "Administrator" ? (
                  <a href="/admin/dashboard">Open admin dashboard</a>
                ) : (
                  <p>
                    Your session is verified. The signed-in project workspace is not connected to
                    this entry screen yet.
                  </p>
                )}
                <Button disabled={pending} onClick={() => void signOut()}>
                  {pending ? "Signing out…" : "Log out"}
                </Button>
              </div>
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
                aria-busy={pending}
              >
                <fieldset disabled={pending} className="login-fields">
                  <legend className="sp-sr-only">
                    {session ? "Change password" : "Account login"}
                  </legend>
                  {!session && (
                    <Field id="login-username" label="Username">
                      <input
                        id="login-username"
                        name="username"
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                        maxLength={256}
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                      />
                    </Field>
                  )}
                  <Field id="login-password" label={session ? "Current password" : "Password"}>
                    <div className="login-password-input">
                      <input
                        id="login-password"
                        name="password"
                        autoComplete="current-password"
                        type={visible ? "text" : "password"}
                        required
                        minLength={12}
                        maxLength={128}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <button
                        type="button"
                        aria-label={visible ? "Hide password" : "Show password"}
                        aria-pressed={visible}
                        onClick={() => setVisible((value) => !value)}
                      >
                        <FontAwesomeIcon icon={visible ? faEyeSlash : faEye} aria-hidden="true" />
                      </button>
                    </div>
                  </Field>
                  {session && (
                    <>
                      <Field
                        id="login-new-password"
                        label="New password"
                        hint="Use 12–128 characters and a different password."
                      >
                        <input
                          id="login-new-password"
                          type="password"
                          autoComplete="new-password"
                          required
                          minLength={12}
                          maxLength={128}
                          aria-describedby="login-new-password-hint"
                          value={newPassword}
                          onChange={(event) => setNewPassword(event.target.value)}
                        />
                      </Field>
                      <Field id="login-confirm-password" label="Confirm new password">
                        <input
                          id="login-confirm-password"
                          type="password"
                          autoComplete="new-password"
                          required
                          minLength={12}
                          maxLength={128}
                          value={confirmation}
                          onChange={(event) => setConfirmation(event.target.value)}
                        />
                      </Field>
                    </>
                  )}
                  {!session && (
                    <button
                      className="entry-text-button login-help"
                      type="button"
                      onClick={() => setHelp(true)}
                    >
                      Need help signing in?
                    </button>
                  )}
                  <Button className="login-submit" type="submit">
                    {pending ? "Please wait…" : session ? "Change password" : "Log in"}
                  </Button>
                </fieldset>
              </form>
            )}
            {session?.mustChangePassword && (
              <Button disabled={pending} onClick={() => void signOut()}>
                Log out
              </Button>
            )}
            <div className="login-account-note">
              <p>
                New to SPATIA?{" "}
                <button className="entry-text-button" onClick={() => setHelp(true)}>
                  Contact your administrator
                </button>
              </p>
              <p>
                <FontAwesomeIcon icon={faUsers} aria-hidden="true" /> One space for student creators
                and teachers.
              </p>
            </div>
          </div>
        </div>
        <aside className="login-art" aria-label="Museum concept preview">
          <img src={exhibit} alt="A museum gallery displaying historical artifacts" />
          <span className="entry-pill">
            <FontAwesomeIcon icon={faLayerGroup} aria-hidden="true" />
            Made for curious minds
          </span>
          <div className="login-featured">
            <div className="entry-between">
              <p className="entry-eyebrow">Museum concept</p>
              <span className="entry-pill">History</span>
            </div>
            <h2>The Silk Road: Curated artifacts and immersive exhibits</h2>
            <p>
              A world of stories, built by students. Turn research into interactive spaces worth
              exploring.
            </p>
            <div>
              <FontAwesomeIcon icon={faCube} aria-hidden="true" /> 3D artifacts · Guided prompts ·
              Class review
            </div>
          </div>
        </aside>
      </main>
      <footer className="entry-footer">
        <p>© 2026 SPATIA. All rights reserved.</p>
        <div>
          <button onClick={() => setHelp(true)}>Need help?</button>
          <button disabled title="Not published yet">
            Privacy
          </button>
          <button disabled title="Not published yet">
            Terms
          </button>
        </div>
      </footer>
      {help && (
        <Dialog title="Account help" onClose={() => setHelp(false)}>
          <p>
            Use the username and password provided by your teacher or organisation administrator.
            Contact them to request an account or reset a forgotten password.
          </p>
        </Dialog>
      )}
    </div>
  );
}
