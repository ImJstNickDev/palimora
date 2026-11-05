import { useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { User } from "@palimora/contracts";
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
  Loading,
  QueryError,
  Heading,
} from "./shared";
export function Users() {
  const t = useText(),
    { user } = useContext(Auth),
    action = useAction();
  const [q, setQ] = useState(""),
    [cursor, setCursor] = useState<string>(),
    [selected, setSelected] = useState<User | null>(null),
    [confirm, setConfirm] = useState<{
      target: User;
      change: {
        disabled?: boolean;
        deleted?: boolean;
        role?: "Admin" | "User";
      };
      label: string;
    } | null>(null),
    [reset, setReset] = useState<User | null>(null);
  const query = useQuery({
    queryKey: ["users", q, cursor],
    queryFn: () => call("users", { q, cursor }),
  });
  const sessions = useQuery({
    queryKey: ["user-sessions", selected?.id],
    queryFn: () => call("userSessions", { id: selected!.id }),
    enabled: !!selected,
  });
  const canManage = (u: User) =>
    u.id !== user.id &&
    u.role !== "Owner" &&
    (user.role === "Owner" || u.role === "User");
  return (
    <>
      <Heading>{t("Utenti", "Users")}</Heading>
      <Form
        onSubmit={async (f) => {
          setQ(val(f, "q"));
          setCursor(undefined);
        }}
      >
        <div className="search">
          <Field
            label={t("Cerca nome utente o email", "Search username or email")}
            name="q"
            type="search"
            maxLength={100}
          />
          <Button type="submit">{t("Cerca", "Search")}</Button>
        </div>
      </Form>
      <Feedback action={action} />
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <QueryError retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">
                {t("Account della biblioteca", "Library accounts")}
              </caption>
              <thead>
                <tr>
                  <th>{t("Utente", "User")}</th>
                  <th>{t("Ruolo", "Role")}</th>
                  <th>{t("Stato", "Status")}</th>
                  <th>{t("Azioni", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.username}</strong>
                      <small>{u.email}</small>
                    </td>
                    <td>{u.role}</td>
                    <td>
                      {u.soft_deleted_at
                        ? t("Eliminato", "Deleted")
                        : u.disabled
                          ? t("Disabilitato", "Disabled")
                          : t("Attivo", "Active")}
                    </td>
                    <td>
                      {canManage(u) && (
                        <div className="row">
                          <Button onClick={() => setSelected(u)}>
                            {t("Sessioni", "Sessions")}
                          </Button>
                          <Button onClick={() => setReset(u)}>
                            {t("Ripristina accesso", "Reset access")}
                          </Button>
                          {user.role === "Owner" && (
                            <Button
                              onClick={() =>
                                setConfirm({
                                  target: u,
                                  change: {
                                    role: u.role === "Admin" ? "User" : "Admin",
                                  },
                                  label:
                                    u.role === "Admin"
                                      ? t(
                                          "Rimuovi ruolo Admin",
                                          "Remove Admin role",
                                        )
                                      : t(
                                          "Assegna ruolo Admin",
                                          "Grant Admin role",
                                        ),
                                })
                              }
                            >
                              {u.role === "Admin"
                                ? t("Rimuovi Admin", "Remove Admin")
                                : t("Rendi Admin", "Make Admin")}
                            </Button>
                          )}
                          <Button
                            onClick={() =>
                              setConfirm({
                                target: u,
                                change: { disabled: !u.disabled },
                                label: u.disabled
                                  ? t("Riabilita account", "Enable account")
                                  : t("Disabilita account", "Disable account"),
                              })
                            }
                          >
                            {u.disabled
                              ? t("Riabilita", "Enable")
                              : t("Disabilita", "Disable")}
                          </Button>
                          <Button
                            tone="danger"
                            onClick={() =>
                              setConfirm({
                                target: u,
                                change: { deleted: !u.soft_deleted_at },
                                label: u.soft_deleted_at
                                  ? t("Ripristina account", "Restore account")
                                  : t("Elimina account", "Delete account"),
                              })
                            }
                          >
                            {u.soft_deleted_at
                              ? t("Ripristina", "Restore")
                              : t("Elimina", "Delete")}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {query.data.items.length === 0 && (
            <p>{t("Nessun utente trovato.", "No users found.")}</p>
          )}
          <div className="row pagination">
            {cursor && (
              <Button onClick={() => setCursor(undefined)}>
                {t("Torna all’inizio", "Back to start")}
              </Button>
            )}
            {query.data.next && (
              <Button onClick={() => setCursor(query.data.next!)}>
                {t("Successivi", "Next")}
              </Button>
            )}
          </div>
        </>
      )}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        closeLabel={t("Chiudi", "Close")}
        title={confirm?.label ?? ""}
        description={t(
          "Le sessioni attive saranno revocate. I dati personali vengono conservati.",
          "Active sessions will be revoked. Personal data is retained.",
        )}
      >
        <p>
          <strong>{confirm?.target.username}</strong>
        </p>
        <Feedback action={action} />
        <Button
          tone="danger"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await call("userUpdate", {
                id: confirm!.target.id,
                ...confirm!.change,
              });
              setConfirm(null);
              await query.refetch();
            })
          }
        >
          {t("Conferma", "Confirm")}
        </Button>
      </Modal>
      <Modal
        open={!!reset}
        onClose={() => setReset(null)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Ripristina accesso", "Reset access")}
        description={t(
          "Comunica la nuova password all’utente tramite un canale sicuro. Tutte le sessioni verranno revocate.",
          "Share the new password with the user through a secure channel. All sessions will be revoked.",
        )}
      >
        <p>
          <strong>{reset?.username}</strong>
        </p>
        <Form
          busy={action.busy}
          onSubmit={(f) =>
            action.run(
              async () => {
                await call("userReset", {
                  id: reset!.id,
                  ...proof(f),
                  newPassword: val(f, "newPassword"),
                  resetFactors: f.has("resetFactors"),
                });
                setReset(null);
                await query.refetch();
              },
              t("Accesso ripristinato.", "Access reset."),
            )
          }
        >
          <PasswordFields confirm />
          <Field
            label={t("Nuova password dell’utente", "User’s new password")}
            name="newPassword"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
          <label className="check">
            <input type="checkbox" name="resetFactors" />
            {t(
              "Rimuovi TOTP, recovery codes e passkey",
              "Remove TOTP, recovery codes and passkeys",
            )}
          </label>
          <Feedback action={action} />
          <Button tone="danger" type="submit">
            {t("Ripristina accesso", "Reset access")}
          </Button>
        </Form>
      </Modal>
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Sessioni di ", "Sessions for ") + (selected?.username ?? "")}
      >
        {sessions.isPending ? (
          <Loading />
        ) : sessions.isError ? (
          <QueryError retry={() => void sessions.refetch()} />
        ) : (
          <>
            <ul className="records">
              {sessions.data.map((s) => (
                <li key={s.id}>
                  <div>
                    {s.device}
                    <small>
                      {s.ip} · {new Date(s.last_seen_at).toLocaleString()}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
            {sessions.data.length === 0 ? (
              <p>{t("Nessuna sessione attiva.", "No active sessions.")}</p>
            ) : (
              <Button
                disabled={action.busy}
                tone="danger"
                onClick={() =>
                  void action.run(async () => {
                    await call("userRevoke", { id: selected!.id });
                    await sessions.refetch();
                  })
                }
              >
                {t("Revoca tutte le sessioni", "Revoke all sessions")}
              </Button>
            )}
            <Feedback action={action} />
          </>
        )}
      </Modal>
    </>
  );
}
export function Invites() {
  const t = useText(),
    action = useAction();
  const [cursor, setCursor] = useState<string>(),
    [link, setLink] = useState(""),
    [revoke, setRevoke] = useState<string | null>(null),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const query = useQuery({
    queryKey: ["invites", cursor],
    queryFn: () => call("invites", { cursor }),
  });
  return (
    <>
      <Heading>{t("Inviti", "Invitations")}</Heading>
      <section>
        <h2>{t("Nuovo invito", "New invitation")}</h2>
        <Form
          busy={action.busy}
          onSubmit={(f) =>
            action.run(async () => {
              const result = await call("inviteCreate", {
                email: val(f, "email"),
                days: Number(val(f, "days")),
                maxUses: Number(val(f, "maxUses")),
                requestId,
              });
              setRequestId(crypto.randomUUID());
              setLink(
                result.token
                  ? `${location.origin}/register#${result.token}`
                  : "",
              );
              if (!result.token)
                action.setDone(
                  t(
                    "Invito già creato. Il token non è recuperabile: revoca e crea un nuovo invito.",
                    "Invitation already created. Its token cannot be retrieved: revoke it and create a new invitation.",
                  ),
                );
              await query.refetch();
            })
          }
        >
          <Field
            label={t(
              "Vincola a email (facoltativo)",
              "Restrict to email (optional)",
            )}
            name="email"
            type="email"
          />
          <div className="columns">
            <Field
              label={t("Scade tra (giorni)", "Expires in (days)")}
              name="days"
              type="number"
              min={1}
              max={30}
              defaultValue={7}
              required
            />
            <Field
              label={t("Utilizzi massimi", "Maximum uses")}
              name="maxUses"
              type="number"
              min={1}
              max={100}
              defaultValue={1}
              required
            />
          </div>
          <Feedback action={action} />
          <Button tone="primary" type="submit">
            {t("Genera invito", "Generate invitation")}
          </Button>
        </Form>
      </section>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <QueryError retry={() => void query.refetch()} />
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">
                {t("Inviti generati", "Generated invitations")}
              </caption>
              <thead>
                <tr>
                  <th>{t("Destinatario", "Recipient")}</th>
                  <th>{t("Scadenza", "Expires")}</th>
                  <th>{t("Utilizzi", "Uses")}</th>
                  <th>{t("Stato", "Status")}</th>
                  <th>{t("Azioni", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((i) => {
                  const expired = new Date(i.expires_at) < new Date(),
                    active = !i.revoked_at && !expired && i.uses < i.max_uses;
                  return (
                    <tr key={i.id}>
                      <td>
                        {i.email ||
                          t("Chi possiede il link", "Anyone with the link")}
                      </td>
                      <td>{new Date(i.expires_at).toLocaleString()}</td>
                      <td>
                        {i.uses} / {i.max_uses}
                      </td>
                      <td>
                        {i.revoked_at
                          ? t("Revocato", "Revoked")
                          : expired
                            ? t("Scaduto", "Expired")
                            : i.uses >= i.max_uses
                              ? t("Esaurito", "Used up")
                              : t("Attivo", "Active")}
                      </td>
                      <td>
                        {active && (
                          <Button tone="danger" onClick={() => setRevoke(i.id)}>
                            {t("Revoca", "Revoke")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {query.data.items.length === 0 && (
            <p>{t("Nessun invito generato.", "No invitations generated.")}</p>
          )}
          <div className="row pagination">
            {cursor && (
              <Button onClick={() => setCursor(undefined)}>
                {t("Torna all’inizio", "Back to start")}
              </Button>
            )}
            {query.data.next && (
              <Button onClick={() => setCursor(query.data.next!)}>
                {t("Successivi", "Next")}
              </Button>
            )}
          </div>
        </>
      )}
      <Modal
        open={!!link}
        onClose={() => setLink("")}
        closeLabel={t("Chiudi", "Close")}
        title={t("Link di invito", "Invitation link")}
        description={t(
          "Copia il link ora: non verrà mostrato di nuovo.",
          "Copy the link now: it will not be shown again.",
        )}
      >
        <Field
          label={t("Link", "Link")}
          value={link}
          readOnly
          onFocus={(e) => e.target.select()}
        />
        <Button
          onClick={() =>
            void action.run(
              async () => {
                await navigator.clipboard.writeText(link);
              },
              t("Link copiato.", "Link copied."),
            )
          }
        >
          {t("Copia link", "Copy link")}
        </Button>
        <Feedback action={action} />
      </Modal>
      <Modal
        open={!!revoke}
        onClose={() => setRevoke(null)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Revoca invito", "Revoke invitation")}
        description={t(
          "Il link smetterà immediatamente di consentire nuove registrazioni.",
          "The link will immediately stop accepting registrations.",
        )}
      >
        <Feedback action={action} />
        <Button
          tone="danger"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await call("inviteRevoke", { id: revoke! });
              setRevoke(null);
              await query.refetch();
            })
          }
        >
          {t("Revoca", "Revoke")}
        </Button>
      </Modal>
    </>
  );
}
