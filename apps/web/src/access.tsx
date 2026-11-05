import { useContext, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  startAuthentication,
  browserSupportsWebAuthnAutofill,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import { OtpInput } from "./otp-input";
import { Button, Field, Notice } from "@palimora/ui";
import { call, ApiFailure } from "./api";
import {
  Locale,
  initialPrefs,
  type Prefs,
  useText,
  errorText,
  useAction,
  Feedback,
  Form,
  val,
  PasswordFields,
  PreferencesFields,
  Loading,
  Heading,
} from "./shared";
export function Setup({ onDone }: { onDone: () => Promise<void> }) {
  const t = useText(),
    action = useAction(),
    { language } = useContext(Locale);
  const [prefs, setPrefs] = useState<Prefs>({
    ...initialPrefs,
    language: language as "it" | "en",
  });
  return (
    <>
      <p className="eyebrow">{t("Prima configurazione", "Initial setup")}</p>
      <Heading>
        {t("La tua biblioteca, il tuo spazio.", "Your library, your space.")}
      </Heading>
      <Form
        busy={action.busy}
        onSubmit={(f) =>
          action.run(async () => {
            await call("setup", {
              name: val(f, "name"),
              username: val(f, "username"),
              password: val(f, "password"),
              email: val(f, "email"),
              preferences: prefs,
            });
            await onDone();
          })
        }
      >
        <Field
          label={t("Nome della biblioteca", "Library name")}
          name="name"
          required
          maxLength={80}
          defaultValue="Palimora"
        />
        <Field
          label={t("Nome utente Owner", "Owner username")}
          name="username"
          required
          minLength={3}
          maxLength={32}
          pattern="[a-zA-Z0-9_][a-zA-Z0-9_.\-]{2,31}"
          autoComplete="username"
        />
        <Field
          label={t("Email facoltativa", "Email (optional)")}
          name="email"
          type="email"
          autoComplete="email"
        />
        <PasswordFields />
        <PreferencesFields value={prefs} onChange={setPrefs} />
        <Feedback action={action} />
        <Button tone="primary" type="submit">
          {t("Crea la biblioteca", "Create library")}
        </Button>
      </Form>
    </>
  );
}
export function Login({ onDone }: { onDone: () => Promise<void> }) {
  const t = useText(),
    action = useAction();
  const [factor, setFactor] = useState<{
    username: string;
    password: string;
  } | null>(null);
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const [autofillAttempt, setAutofillAttempt] = useState(0);
  const [passkeyError, setPasskeyError] = useState("");
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const submitting = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (factor) heading.current?.focus();
  }, [factor]);
  useEffect(() => {
    if (factor) return;
    let cancelled = false;
    // Conditional mediation only displays credentials held by the user's provider.
    // No username-to-authenticator discovery endpoint is exposed.
    const timer = setTimeout(
      () => setAutofillAttempt((value) => value + 1),
      240000,
    );
    void (async () => {
      try {
        if (!(await browserSupportsWebAuthnAutofill()) || cancelled) return;
        const options = await call("passkeyLoginStart", {});
        if (cancelled || submitting.current) return;
        const response = await startAuthentication({
          optionsJSON: options as any,
          useBrowserAutofill: true,
        });
        if (cancelled || submitting.current) return;
        submitting.current = true;
        setPasskeyBusy(true);
        try {
          await call("passkeyLoginFinish", { response: response as any });
          await done.current();
        } catch (error) {
          if (!cancelled) setPasskeyError(errorText(error, t));
        } finally {
          submitting.current = false;
          if (!cancelled) setPasskeyBusy(false);
        }
      } catch {
        // Unavailable/cancelled browser suggestions never block password login.
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      WebAuthnAbortService.cancelCeremony();
    };
    // Restart only when returning to credentials or retrying; onDone is held in a ref.
  }, [factor, autofillAttempt]);
  const busy = action.busy || passkeyBusy;
  return (
    <>
      <Heading>{t("Accedi a Palimora", "Sign in to Palimora")}</Heading>
      {factor ? (
        <div className="login-factor wizard-step">
          <button
            type="button"
            className="icon-button"
            aria-label={t("Indietro", "Back")}
            disabled={busy}
            onClick={() => {
              action.reset();
              setFactor(null);
              setCode("");
              setPasskeyError("");
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              aria-hidden="true"
            >
              <path d="m12 5-7 7 7 7M5 12h15" />
            </svg>
          </button>
          <h2 ref={heading} tabIndex={-1}>
            {t("Verifica la tua identità", "Verify your identity")}
          </h2>
          <p className="muted">
            {t(
              "Inserisci il codice della tua app di autenticazione per",
              "Enter your authenticator app code for",
            )}{" "}
            <strong>{factor.username}</strong>.
          </p>
          <Form
            busy={busy}
            onSubmit={() =>
              action.run(async () => {
                if (submitting.current) return;
                submitting.current = true;
                try {
                  await call("login", { ...factor, code });
                  setFactor(null);
                  setCode("");
                  await onDone();
                } finally {
                  submitting.current = false;
                }
              })
            }
          >
            <OtpInput value={code} onChange={setCode} />
            <Feedback action={action} />
            <Button tone="primary" type="submit" disabled={code.length !== 6}>
              {t("Accedi", "Sign in")}
            </Button>
          </Form>
        </div>
      ) : (
        <Form
          busy={busy}
          onSubmit={(f) =>
            action.run(async () => {
              if (submitting.current) return;
              submitting.current = true;
              WebAuthnAbortService.cancelCeremony();
              setPasskeyError("");
              const credentials = {
                username: val(f, "username"),
                password: val(f, "password"),
              };
              try {
                await call("login", credentials);
                await onDone();
              } catch (error) {
                if (
                  error instanceof ApiFailure &&
                  error.code === "SECOND_FACTOR_REQUIRED"
                ) {
                  setFactor(credentials);
                  setCode("");
                } else {
                  setAutofillAttempt((value) => value + 1);
                  throw error;
                }
              } finally {
                submitting.current = false;
              }
            })
          }
        >
          <Field
            label={t("Nome utente", "Username")}
            name="username"
            required
            maxLength={100}
            autoComplete="username webauthn"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            required
            maxLength={128}
            autoComplete="current-password"
            hint={t(
              "Puoi inserire un codice di backup al posto della password.",
              "You can enter a backup code instead of your password.",
            )}
          />
          <Feedback action={action} />
          {passkeyError && <Notice error>{passkeyError}</Notice>}
          <Button tone="primary" type="submit">
            {t("Accedi", "Sign in")}
          </Button>
        </Form>
      )}
      <p className="muted">
        {t(
          "Per registrarti, apri il link di invito ricevuto dall’Owner. Per recuperare l’accesso, contatta un amministratore.",
          "To register, open the invitation link from the Owner. To recover access, contact an administrator.",
        )}
      </p>
    </>
  );
}
export function Register({ onDone }: { onDone: () => Promise<void> }) {
  const t = useText(),
    action = useAction(),
    { language } = useContext(Locale);
  const [token] = useState(() =>
    decodeURIComponent(window.location.hash.slice(1)),
  );
  useEffect(() => {
    history.replaceState(null, "", window.location.pathname);
  }, []);
  const invite = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => call("inviteInfo", { token }),
    retry: false,
  });
  const [prefs, setPrefs] = useState<Prefs>({
    ...initialPrefs,
    language: language as "it" | "en",
  });
  return (
    <>
      <Heading>{t("Accetta l’invito", "Accept invitation")}</Heading>
      {invite.isPending ? (
        <Loading />
      ) : invite.isError ? (
        <>
          <Notice error>{errorText(invite.error, t)}</Notice>
          <NavLink to="/login">{t("Accedi", "Sign in")}</NavLink>
        </>
      ) : (
        <Form
          busy={action.busy}
          onSubmit={(f) =>
            action.run(async () => {
              await call("register", {
                token,
                username: val(f, "username"),
                password: val(f, "password"),
                email: val(f, "email"),
                preferences: prefs,
              });
              await onDone();
            })
          }
        >
          <Field
            label={t("Nome utente", "Username")}
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
          />
          <Field
            label={t("Email", "Email")}
            name="email"
            type="email"
            defaultValue={invite.data.email ?? ""}
            readOnly={!!invite.data.email}
            required={!!invite.data.email}
          />
          <PasswordFields />
          <PreferencesFields value={prefs} onChange={setPrefs} />
          <Feedback action={action} />
          <Button tone="primary" type="submit">
            {t("Crea account", "Create account")}
          </Button>
        </Form>
      )}
    </>
  );
}
