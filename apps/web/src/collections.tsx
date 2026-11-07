import { SocialNav } from "./social";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Field, Modal, Notice, Select } from "@palimora/ui";
import { call } from "./api";
import { client, useAction, useText, Loading, QueryError } from "./shared";
const refresh = () => client.invalidateQueries({ queryKey: ["collections"] });
export function Collections() {
  const t = useText(),
    action = useAction(t),
    [create, setCreate] = useState(false),
    [createId, setCreateId] = useState(() => crypto.randomUUID());
  const data = useInfiniteQuery({
    queryKey: ["collections"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => call("collectionList", { cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  return (
    <section className="personal-library">
      <h1 tabIndex={-1}>{t("Collezioni personali", "Personal collections")}</h1>
      <SocialNav />
      <Button
        onClick={() => {
          setCreateId(crypto.randomUUID());
          setCreate(true);
        }}
      >
        {t("Nuova collezione", "New collection")}
      </Button>
      {action.error && <Notice error>{action.error}</Notice>}
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <QueryError retry={() => void data.refetch()} />
      ) : (
        <>
          <ul className="library-entries">
            {data.data.pages
              .flatMap((p) => p.items)
              .map((c) => (
                <li key={c.id}>
                  <h2>
                    {c.accepted ? (
                      <Link to={"/collections/" + c.id}>{c.name}</Link>
                    ) : (
                      c.name
                    )}
                  </h2>
                  <p>{c.description}</p>
                  <span>{c.role}</span>
                  {!c.accepted && (
                    <div className="library-controls">
                      {[true, false].map((accept) => (
                        <Button
                          key={String(accept)}
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await call("collectionRespond", {
                                id: c.id,
                                accept,
                              });
                              await refresh();
                            })
                          }
                        >
                          {accept
                            ? t("Accetta invito", "Accept invitation")
                            : t("Rifiuta", "Decline")}
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
          </ul>
          {!data.data.pages[0].items.length && (
            <p>{t("Nessuna collezione.", "No collections.")}</p>
          )}
          {data.hasNextPage && (
            <Button
              onClick={() => void data.fetchNextPage()}
              disabled={data.isFetchingNextPage}
            >
              {t("Altre collezioni", "More collections")}
            </Button>
          )}
        </>
      )}
      <Modal
        open={create}
        onClose={() => setCreate(false)}
        title={t("Nuova collezione", "New collection")}
        closeLabel={t("Chiudi", "Close")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void action.run(async () => {
              await call("collectionCreate", {
                id: createId,
                name: String(f.get("name")),
                description: String(f.get("description")),
              });
              setCreate(false);
              await refresh();
            });
          }}
        >
          <Field
            label={t("Nome", "Name")}
            name="name"
            required
            maxLength={120}
          />
          <Field
            label={t("Descrizione", "Description")}
            name="description"
            maxLength={4000}
          />
          <Button disabled={action.busy}>{t("Crea", "Create")}</Button>
          {action.error && <Notice error>{action.error}</Notice>}
        </form>
      </Modal>
    </section>
  );
}
export function CollectionDetail() {
  const { id = "" } = useParams(),
    t = useText(),
    action = useAction(t);
  const [edit, setEdit] = useState(false),
    [remove, setRemove] = useState(false);
  const data = useInfiniteQuery({
    queryKey: ["collections", id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("collectionDetail", { id, cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  if (data.isPending) return <Loading />;
  if (data.isError) return <QueryError retry={() => void data.refetch()} />;
  const { collection: c, members } = data.data.pages[0],
    write = c.role !== "Viewer";
  const member = (username: string, role: "Editor" | "Viewer" | null) =>
    void action.run(async () => {
      await call("collectionMember", { id, username, role });
      await refresh();
    });
  return (
    <section className="personal-library">
      <Link to="/collections">
        {t("Collezioni personali", "Personal collections")}
      </Link>
      <h1 tabIndex={-1}>{c.name}</h1>
      <SocialNav />
      <p>{c.description}</p>
      <div className="library-controls">
        {write && (
          <Button onClick={() => setEdit(true)}>{t("Modifica", "Edit")}</Button>
        )}
        {c.role === "Owner" ? (
          <Button tone="danger" onClick={() => setRemove(true)}>
            {t("Elimina collezione", "Delete collection")}
          </Button>
        ) : (
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await call("collectionRespond", { id, accept: false });
                location.assign("/collections");
              })
            }
          >
            {t("Lascia collezione", "Leave collection")}
          </Button>
        )}
      </div>
      {action.error && <Notice error>{action.error}</Notice>}
      <h2>{t("Opere", "Works")}</h2>
      <p>
        <Link to="/library">
          {t(
            "Aggiungi dalla biblioteca o dal lettore",
            "Add from your library or the reader",
          )}
        </Link>
      </p>
      <ul className="library-entries">
        {data.data.pages
          .flatMap((p) => p.works)
          .map((w) => (
            <li key={w.id}>
              <Link to={"/works/" + w.id}>{w.title}</Link>
              {write && (
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await call("collectionWork", {
                        id,
                        work: w.id,
                        remove: true,
                      });
                      await refresh();
                    })
                  }
                >
                  {t("Rimuovi", "Remove")}
                </Button>
              )}
            </li>
          ))}
      </ul>
      {!data.data.pages[0].works.length && (
        <p>{t("Nessuna opera.", "No works.")}</p>
      )}
      {data.hasNextPage && (
        <Button
          disabled={data.isFetchingNextPage}
          onClick={() => void data.fetchNextPage()}
        >
          {t("Altre opere", "More works")}
        </Button>
      )}
      <details>
        <summary>{t("Membri e condivisione", "Members and sharing")}</summary>
        <ul className="library-entries">
          {members.map((m) => (
            <li key={m.user_id}>
              <strong>{m.username}</strong> · {m.role}{" "}
              {!m.accepted && t("· Invito in attesa", "· Invitation pending")}
              {c.role === "Owner" && m.role !== "Owner" && (
                <div className="library-controls">
                  <Select
                    label={t("Permessi di ", "Permissions for ") + m.username}
                    value={m.role}
                    disabled={action.busy}
                    onChange={(e) =>
                      member(m.username, e.target.value as "Editor" | "Viewer")
                    }
                  >
                    <option>Viewer</option>
                    <option>Editor</option>
                  </Select>
                  <Button
                    disabled={action.busy}
                    onClick={() => member(m.username, null)}
                  >
                    {t("Revoca accesso", "Revoke access")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {c.role === "Owner" && (
          <form
            className="library-filter"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              member(
                String(f.get("username")),
                f.get("role") as "Editor" | "Viewer",
              );
            }}
          >
            <Field
              label={t("Nome utente", "Username")}
              name="username"
              required
            />
            <Select label={t("Permesso", "Permission")} name="role">
              <option>Viewer</option>
              <option>Editor</option>
            </Select>
            <Button disabled={action.busy}>{t("Invita", "Invite")}</Button>
          </form>
        )}
      </details>
      <Modal
        open={edit || remove}
        onClose={() => {
          setEdit(false);
          setRemove(false);
        }}
        title={
          remove
            ? t("Elimina collezione", "Delete collection")
            : t("Modifica collezione", "Edit collection")
        }
        closeLabel={t("Chiudi", "Close")}
      >
        <form
          key={c.revision}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void action.run(async () => {
              await call("collectionUpdate", {
                id,
                revision: c.revision,
                name: String(f.get("name") ?? c.name),
                description: String(f.get("description") ?? c.description),
                deleted: remove,
              });
              if (remove) location.assign("/collections");
              else {
                setEdit(false);
                await refresh();
              }
            });
          }}
        >
          {remove ? (
            <p>
              {t(
                "Le opere e i bookmark saranno conservati.",
                "Works and bookmarks will be preserved.",
              )}
            </p>
          ) : (
            <>
              <Field
                label={t("Nome", "Name")}
                name="name"
                defaultValue={c.name}
                required
                maxLength={120}
              />
              <Field
                label={t("Descrizione", "Description")}
                name="description"
                defaultValue={c.description}
                maxLength={4000}
              />
            </>
          )}
          <Button disabled={action.busy} tone={remove ? "danger" : "primary"}>
            {remove ? t("Elimina", "Delete") : t("Salva", "Save")}
          </Button>
          {action.error && <Notice error>{action.error}</Notice>}
        </form>
      </Modal>
    </section>
  );
}
export function AddToCollection({ work }: { work: string }) {
  const t = useText(),
    action = useAction(t),
    [open, setOpen] = useState(false);
  const data = useInfiniteQuery({
    queryKey: ["collections"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => call("collectionList", { cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
    enabled: open,
  });
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        {t("Aggiungi a collezione", "Add to collection")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("Aggiungi a collezione", "Add to collection")}
        closeLabel={t("Chiudi", "Close")}
      >
        {data.isPending ? (
          <Loading />
        ) : data.isError ? (
          <QueryError retry={() => void data.refetch()} />
        ) : (
          <>
            <ul className="library-entries">
              {data.data.pages
                .flatMap((p) => p.items)
                .filter((c) => c.accepted && c.role !== "Viewer")
                .map((c) => (
                  <li key={c.id}>
                    <Button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await call("collectionWork", {
                            id: c.id,
                            work,
                            remove: false,
                          });
                          await refresh();
                          setOpen(false);
                        })
                      }
                    >
                      {c.name}
                    </Button>
                  </li>
                ))}
            </ul>
            {data.hasNextPage && (
              <Button onClick={() => void data.fetchNextPage()}>
                {t("Altre collezioni", "More collections")}
              </Button>
            )}
            <Link to="/collections">
              {t("Gestisci collezioni", "Manage collections")}
            </Link>
          </>
        )}
        {action.error && <Notice error>{action.error}</Notice>}
      </Modal>
    </>
  );
}
