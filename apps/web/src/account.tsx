import { useContext, useState } from "react";
import { flushSync } from "react-dom";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { startRegistration } from "@simplewebauthn/browser";
import { TotpWizard, downloadCodes } from "./totp-wizard";
import { Button, Field, Modal } from "@palimora/ui";
import { call } from "./api";
import {
  Auth,
  useText,
  useAction,
  Feedback,
  Form,
  val,
  proof,
  PasswordFields,
  PreferencesFields,
  Loading,
  QueryError,
  Heading,
} from "./shared";
export function Account() {
  const t = useText(),
    { user, refresh, leave } = useContext(Auth),
    action = useAction();
  const [deleting, setDeleting] = useState(false);
  const [prefs, setPrefs] = useState(user.preferences);
  return (
    <>
      <Heading>{t("Il tuo account", "Your account")}</Heading>
      <section>
        <h2>
          {user.username} <span className="muted">· {user.role}</span>
        </h2>
        <Form
          busy={action.busy}
          onSubmit={(f) =>
            action.run(
              async () => {
                await call("profile", {
                  email: val(f, "email"),
                  preferences: prefs,
                });
                await refresh();
              },
              t("Preferenze salvate.", "Preferences saved."),
            )
          }
        >
          <Field
            label={t("Email facoltativa", "Email (optional)")}
            name="email"
            type="email"
            defaultValue={user.email ?? ""}
            hint={t(
              "Non verificata. Non utilizzata per il recupero password.",
              "Unverified. Not used for password recovery.",
            )}
          />
          <PreferencesFields value={prefs} onChange={setPrefs} />
          <Feedback action={action} />
          <Button tone="primary" type="submit">
            {t("Salva modifiche", "Save changes")}
          </Button>
        </Form>
      </section>
      {user.role !== "Owner" && (
        <section>
          <h2>{t("Elimina account", "Delete account")}</h2>
          <Button tone="danger" onClick={() => setDeleting(true)}>
            {t("Elimina il mio account", "Delete my account")}
          </Button>
        </section>
      )}
      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Elimina il mio account", "Delete my account")}
        description={t(
          "Perderai l’accesso e tutte le sessioni saranno revocate. I dati personali saranno conservati; un amministratore potrà ripristinare l’account.",
          "You will lose access and all sessions will be revoked. Personal data is retained; an administrator can restore the account.",
        )}
      >
        <Form
          busy={action.busy}
          onSubmit={(f) =>
            action.run(async () => {
              await call("deleteAccount", proof(f));
              leave();
            })
          }
        >
          <PasswordFields confirm />
          <Feedback action={action} />
          <Button type="submit" tone="danger">
            {t("Elimina account", "Delete account")}
          </Button>
        </Form>
      </Modal>
    </>
  );
}
function Codes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const t = useText();
  return (
    <Modal
      open={codes.length > 0}
      onClose={onClose}
      closeLabel={t("Chiudi", "Close")}
      title={t("Codici recovery", "Recovery codes")}
      description={t(
        "Conservali in un luogo sicuro. Ogni codice è utilizzabile una sola volta; non verranno mostrati di nuovo.",
        "Store them safely. Each code can be used once; they will not be shown again.",
      )}
    >
      <ul className="codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <Button
        onClick={() => {
          downloadCodes(codes);
        }}
      >
        {t("Scarica codici", "Download codes")}
      </Button>
    </Modal>
  );
}
function SecurityLink({
  to,
  children,
  className,
  label,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const navigate = useNavigate();
  return (
    <Link
      to={to}
      className={className}
      aria-label={label}
      onClick={(event) => {
        if (
          event.button ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        if (
          !document.startViewTransition ||
          matchMedia("(prefers-reduced-motion: reduce)").matches
        )
          return;
        event.preventDefault();
        document.documentElement.dataset.securityDirection =
          to === "/security" ? "back" : "forward";
        document.startViewTransition(() => flushSync(() => navigate(to)));
      }}
    >
      {children}
    </Link>
  );
}
function SecurityIcon({ kind }: { kind: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "password" ? (
        <>
          <rect x="5" y="10" width="14" height="11" rx="3" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
        </>
      ) : kind === "2fa" ? (
        <>
          <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z" />
          <path d="m8.5 12 2.5 2.5 4.5-5" />
        </>
      ) : (
        <>
          <circle cx="8" cy="9" r="4" />
          <path d="m11 12 9 9m-3-3 3-3m-6 0 3-3" />
        </>
      )}
    </svg>
  );
}
export function Security() {
  const location = useLocation();
  const page = location.pathname.split("/")[2] || "overview";
  if (!["overview", "password", "2fa", "passkeys"].includes(page))
    return <Navigate to="/security" replace />;
  return <SecurityView key={location.pathname} page={page} />;
}
function SecurityView({ page }: { page: string }) {
  const t = useText(),
    { user, refresh, leave } = useContext(Auth),
    passwordAction = useAction(),
    factorAction = useAction(),
    keyAction = useAction();
  const [wizard, setWizard] = useState(false),
    [addingKey, setAddingKey] = useState(false),
    [codes, setCodes] = useState<string[]>([]),
    [keyDelete, setKeyDelete] = useState<string | null>(null);
  const keys = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => call("passkeys", {}),
  });
  const navigationType = useNavigationType();
  const title =
    page === "password"
      ? "Password"
      : page === "2fa"
        ? t("Autenticazione a due fattori", "Two-factor authentication")
        : page === "passkeys"
          ? "Passkeys"
          : t("Sicurezza", "Security");
  const cards = [
    {
      id: "password",
      title: "Password",
      description: t(
        "Aggiorna la password del tuo account.",
        "Update your account password.",
      ),
      status: t("Password impostata", "Password set"),
    },
    {
      id: "2fa",
      title: t("Autenticazione a due fattori", "Two-factor authentication"),
      description: t(
        "Un secondo passaggio per proteggere i tuoi accessi.",
        "An extra step to protect your sign-ins.",
      ),
      status: user.totp_enabled
        ? t("Attiva", "Enabled")
        : t("Non attiva", "Not enabled"),
    },
    {
      id: "passkeys",
      title: "Passkeys",
      description: t(
        "Accedi con impronta, volto o blocco del dispositivo.",
        "Sign in with your fingerprint, face or device lock.",
      ),
      status: keys.isPending
        ? t("Caricamento…", "Loading…")
        : keys.isError
          ? t("Apri per riprovare", "Open to retry")
          : keys.data.length === 0
            ? t("Nessuna passkey", "No passkeys")
            : t(
                `${keys.data.length} registrate`,
                `${keys.data.length} registered`,
              ),
    },
  ];
  return (
    <div className="security-view" data-back={navigationType === "POP"}>
      {page !== "overview" && (
        <SecurityLink to="/security" className="security-back">
          <span aria-hidden="true">←</span>
          {t("Sicurezza", "Security")}
        </SecurityLink>
      )}
      <div className="security-page-heading">
        {page !== "overview" && (
          <span className="security-page-icon">
            <SecurityIcon kind={page} />
          </span>
        )}
        <Heading>{title}</Heading>
        <p>
          {page === "overview"
            ? t(
                "Scegli come accedere e proteggere il tuo account.",
                "Choose how to sign in and protect your account.",
              )
            : cards.find((card) => card.id === page)?.description}
        </p>
      </div>
      {page === "overview" && (
        <div className="security-cards">
          {cards.map((card) => (
            <SecurityLink
              key={card.id}
              to={`/security/${card.id}`}
              className="security-card"
              label={card.title}
            >
              <span className="security-card-icon">
                <SecurityIcon kind={card.id} />
              </span>
              <span className="security-card-copy">
                <strong>{card.title}</strong>
                <span>{card.description}</span>
                <small className="security-card-status">
                  <span
                    className={
                      card.id === "2fa" && !user.totp_enabled
                        ? "status-dot neutral"
                        : "status-dot"
                    }
                  />
                  {card.status}
                </small>
              </span>
              <svg
                className="security-card-arrow"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                aria-hidden="true"
              >
                <path d="m9 5 7 7-7 7" />
              </svg>
            </SecurityLink>
          ))}
        </div>
      )}
      {page === "password" && (
        <section className="security-detail">
          <Form
            busy={passwordAction.busy}
            onSubmit={(f) =>
              passwordAction.run(async () => {
                if (val(f, "newPassword") !== val(f, "confirmPassword"))
                  throw new Error("PASSWORD_MISMATCH");
                await call("password", {
                  ...proof(f),
                  newPassword: val(f, "newPassword"),
                });
                leave();
              })
            }
          >
            <PasswordFields confirm />
            <Field
              label={t("Nuova password", "New password")}
              type="password"
              name="newPassword"
              minLength={12}
              maxLength={128}
              required
              autoComplete="new-password"
              hint={t(
                "Almeno 12 caratteri. Tutti i dispositivi verranno disconnessi.",
                "At least 12 characters. All devices will be signed out.",
              )}
            />
            <Field
              label={t("Conferma nuova password", "Confirm new password")}
              type="password"
              name="confirmPassword"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
            <Feedback action={passwordAction} />
            <Button type="submit">
              {t("Cambia password", "Change password")}
            </Button>
          </Form>
        </section>
      )}
      {page === "2fa" && (
        <section className="security-factor">
          {wizard ? (
            <TotpWizard
              onClose={() => setWizard(false)}
              onEnabled={async () => {
                setWizard(false);
                await refresh();
              }}
            />
          ) : (
            <>
              <h2>
                {t("Autenticazione a due fattori", "Two-factor authentication")}{" "}
                <span className="muted">
                  ·{" "}
                  {user.totp_enabled
                    ? t("Attiva", "Enabled")
                    : t("Non attiva", "Disabled")}
                </span>
              </h2>
              {!user.totp_enabled ? (
                <Button tone="primary" onClick={() => setWizard(true)}>
                  {t("Attiva 2FA", "Enable 2FA")}
                </Button>
              ) : (
                <Form
                  busy={factorAction.busy}
                  onSubmit={(f) =>
                    factorAction.run(async () => {
                      if (user.totp_enabled) {
                        const result = await call("recovery", proof(f));
                        setCodes(result.codes);
                      }
                    })
                  }
                >
                  <PasswordFields confirm />
                  <div className="row">
                    <Button type="submit">
                      {user.totp_enabled
                        ? t(
                            "Rigenera recovery codes",
                            "Regenerate recovery codes",
                          )
                        : t("Configura TOTP", "Set up TOTP")}
                    </Button>
                    {user.totp_enabled && (
                      <Button
                        type="button"
                        tone="danger"
                        onClick={(e) => {
                          const form = e.currentTarget.closest("form")!;
                          if (form.reportValidity())
                            void factorAction.run(
                              async () => {
                                await call(
                                  "totpDisable",
                                  proof(new FormData(form)),
                                );
                                await refresh();
                              },
                              t("TOTP disattivata.", "TOTP disabled."),
                            );
                        }}
                      >
                        {t("Disattiva TOTP", "Disable TOTP")}
                      </Button>
                    )}
                  </div>
                </Form>
              )}
              <Feedback action={factorAction} />
            </>
          )}
        </section>
      )}
      {page === "passkeys" && (
        <section className="security-detail">
          <div className="row security-section-heading">
            <h2>{t("Le tue passkey", "Your passkeys")}</h2>
            <Button
              aria-label={t("Aggiungi passkey", "Add passkey")}
              onClick={() => setAddingKey(true)}
            >
              <span aria-hidden="true">＋</span>
            </Button>
          </div>
          {keys.isPending ? (
            <Loading />
          ) : keys.isError ? (
            <QueryError retry={() => void keys.refetch()} />
          ) : (
            <ul className="records">
              {keys.data.length === 0 && (
                <li className="muted">
                  {t("Nessuna passkey registrata.", "No passkeys registered.")}
                </li>
              )}
              {keys.data.map((key) => (
                <li key={key.id}>
                  <span>
                    {key.name}
                    <small>
                      {new Date(key.created_at).toLocaleDateString()}
                    </small>
                  </span>
                  <Button tone="danger" onClick={() => setKeyDelete(key.id)}>
                    {t("Rimuovi", "Remove")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Feedback action={keyAction} />
        </section>
      )}
      <Modal
        open={addingKey}
        onClose={() => {
          if (!keyAction.busy) setAddingKey(false);
        }}
        closeLabel={t("Chiudi", "Close")}
        title={t("Aggiungi passkey", "Add passkey")}
      >
        <Form
          busy={keyAction.busy}
          onSubmit={(f) =>
            keyAction.run(
              async () => {
                const options = await call("passkeyStart", proof(f));
                const response = await startRegistration({
                  optionsJSON: options as any,
                });
                await call("passkeyFinish", {
                  name: val(f, "name"),
                  response: response as any,
                });
                setAddingKey(false);
                await keys.refetch();
              },
              t("Passkey aggiunta.", "Passkey added."),
            )
          }
        >
          <Field
            label={t("Nome della passkey", "Passkey name")}
            name="name"
            required
            maxLength={80}
            autoComplete="off"
          />
          <PasswordFields confirm />
          <Feedback action={keyAction} />
          <Button type="submit">{t("Aggiungi passkey", "Add passkey")}</Button>
        </Form>
      </Modal>
      <Modal
        open={!!keyDelete}
        onClose={() => setKeyDelete(null)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Rimuovi passkey", "Remove passkey")}
      >
        <Form
          busy={keyAction.busy}
          onSubmit={(f) =>
            keyAction.run(async () => {
              await call("passkeyDelete", { id: keyDelete!, ...proof(f) });
              setKeyDelete(null);
              await keys.refetch();
            })
          }
        >
          <PasswordFields confirm />
          <Feedback action={keyAction} />
          <Button tone="danger" type="submit">
            {t("Rimuovi", "Remove")}
          </Button>
        </Form>
      </Modal>
      <Codes codes={codes} onClose={() => setCodes([])} />
    </div>
  );
}
export function Sessions() {
  const t = useText(),
    action = useAction(),
    { leave } = useContext(Auth);
  const query = useQuery({
    queryKey: ["sessions"],
    queryFn: () => call("sessions", {}),
  });
  return (
    <>
      <Heading>{t("Dispositivi e sessioni", "Devices and sessions")}</Heading>
      <Feedback action={action} />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <QueryError retry={() => void query.refetch()} />
      ) : (
        <>
          <ul className="records">
            {query.data.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>
                    {s.current
                      ? t("Questo dispositivo", "This device")
                      : s.device}
                  </strong>
                  {s.current && <small>{s.device}</small>}
                  <small>
                    {s.ip} · {t("Ultima attività", "Last activity")}:{" "}
                    {new Date(s.last_seen_at).toLocaleString()}
                  </small>
                  <small>
                    {t("Accesso", "Signed in")}:{" "}
                    {new Date(s.created_at).toLocaleString()} ·{" "}
                    {t("Scadenza", "Expires")}:{" "}
                    {new Date(s.expires_at).toLocaleDateString()}
                  </small>
                </div>
                <Button
                  disabled={action.busy}
                  tone="danger"
                  onClick={() =>
                    void action.run(async () => {
                      await call("revokeSession", { id: s.id });
                      if (s.current) leave();
                      else await query.refetch();
                    })
                  }
                >
                  {t("Revoca", "Revoke")}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(
                async () => {
                  await call("revokeOthers", {});
                  await query.refetch();
                },
                t("Altre sessioni revocate.", "Other sessions revoked."),
              )
            }
          >
            {t("Disconnetti gli altri dispositivi", "Sign out other devices")}
          </Button>
        </>
      )}
    </>
  );
}
