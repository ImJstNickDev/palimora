import { CollectionMembers } from "./collection-members";
import { IconButton } from "./library-ui";
import { Icon } from "./icons";
import { LibraryHeading } from "./social";
import { useState, useRef, useLayoutEffect } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button, Field, Modal, Notice } from "@palimora/ui";
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
      <LibraryHeading
        title={<>{t("Collezioni personali", "Personal collections")}</>}
        actions={
          <IconButton
            icon="plus"
            label={t("Nuova collezione", "New collection")}
            onClick={() => {
              setCreateId(crypto.randomUUID());
              setCreate(true);
            }}
          />
        }
      />
      {action.error && <Notice error>{action.error}</Notice>}
      {data.isPending ? (
        <Loading />
      ) : data.isError ? (
        <QueryError retry={() => void data.refetch()} />
      ) : (
        <>
          <ul className="library-entries collection-list">
            {data.data.pages
              .flatMap((p) => p.items)
              .map((c) => (
                <li key={c.id}>
                  <h2>
                    {c.accepted ? (
                      <Link to={"/library/collections/" + c.id}>{c.name}</Link>
                    ) : (
                      c.name
                    )}
                  </h2>
                  {c.description && (
                    <p className="collection-description">{c.description}</p>
                  )}
                  {c.role !== "Owner" && (
                    <span className="library-entry-meta">
                      {c.role === "Editor"
                        ? t("Puoi modificare", "Can edit")
                        : t("Sola lettura", "Read only")}
                    </span>
                  )}
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
    navigate = useNavigate(),
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
  return (
    <section className="personal-library">
      <Link className="library-back" to="/library/collections">
        <Icon name="back" />
        {t("Collezioni personali", "Personal collections")}
      </Link>
      <LibraryHeading
        showContext={false}
        title={<>{c.name}</>}
        actions={
          <div className="library-controls">
            <CollectionMembers
              id={id}
              members={members}
              owner={c.role === "Owner"}
              onUpdated={refresh}
            />
            {write && (
              <IconButton
                icon="edit"
                label={t("Modifica", "Edit")}
                onClick={() => setEdit(true)}
              />
            )}
            {c.role === "Owner" ? (
              <IconButton
                icon="trash"
                label={t("Elimina collezione", "Delete collection")}
                onClick={() => setRemove(true)}
              />
            ) : (
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await call("collectionRespond", { id, accept: false });
                    navigate("/library/collections");
                  })
                }
              >
                {t("Lascia collezione", "Leave collection")}
              </Button>
            )}
          </div>
        }
      />
      {c.description && (
        <p className="collection-description">{c.description}</p>
      )}
      {action.error && <Notice error>{action.error}</Notice>}
      <ul
        className="library-entries collection-works"
        aria-label={t("Opere della collezione", "Collection works")}
      >
        {data.data.pages
          .flatMap((p) => p.works)
          .map((w) => (
            <li key={w.id} className="library-row">
              <h2>
                <Link to={"/works/" + w.id}>{w.title}</Link>
              </h2>
              {write && (
                <IconButton
                  icon="close"
                  label={t("Rimuovi", "Remove")}
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
                />
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
              if (remove) navigate("/library/collections");
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
                "Le opere e i salvataggi personali saranno conservati.",
                "Works and personal saves will be preserved.",
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
export function CollectionChoices({
  work,
  onSaved,
}: {
  work: string;
  onSaved: () => Promise<void>;
}) {
  const t = useText(),
    action = useAction(t);
  const [create, setCreate] = useState(false),
    [createId, setCreateId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const createTrigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const choiceFocus = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!create && !action.busy && choiceFocus.current) {
      choiceFocus.current.focus({ preventScroll: true });
      choiceFocus.current = null;
    }
    if (
      !create &&
      !action.busy &&
      restoreFocus.current &&
      createTrigger.current
    ) {
      createTrigger.current.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [create, action.busy]);
  function showChoices() {
    restoreFocus.current = true;
    setCreate(false);
  }
  const [created, setCreated] = useState(false);
  const data = useInfiniteQuery({
    queryKey: ["collections", "choices", work],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("collectionList", { cursor: pageParam, work }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  const update = async (id: string, remove = false) => {
    await call("collectionWork", { id, work, remove });
    await refresh();
    await onSaved();
    if (create) showChoices();
  };
  return (
    <>
      {create ? (
        <form
          className="collection-quick-create"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              if (!created) {
                await call("collectionCreate", {
                  id: createId,
                  name,
                  description,
                });
                setCreated(true);
              }
              await update(createId);
            });
          }}
        >
          <Field
            label={t("Nome", "Name")}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            autoFocus
            disabled={created}
          />
          <Field
            label={t("Descrizione", "Description")}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={4000}
            disabled={created}
          />
          <div className="library-controls">
            <Button type="button" disabled={action.busy} onClick={showChoices}>
              {t("Indietro", "Back")}
            </Button>
            <Button tone="primary" disabled={action.busy}>
              {created
                ? t("Aggiungi opera", "Add work")
                : t("Crea e aggiungi", "Create and add")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <button
            className="action-menu-item new-collection"
            disabled={action.busy}
            ref={createTrigger}
            onClick={() => {
              setCreateId(crypto.randomUUID());
              setCreated(false);
              setName("");
              setDescription("");
              setCreate(true);
            }}
          >
            <Icon name="plus" />
            <span>{t("Nuova collezione", "New collection")}</span>
          </button>
          {data.isPending ? (
            <Loading />
          ) : data.isError ? (
            <QueryError retry={() => void data.refetch()} />
          ) : (
            <>
              <div className="collection-choices">
                {data.data.pages
                  .flatMap((p) => p.items)
                  .filter((c) => c.accepted && c.role !== "Viewer")
                  .map((c) => (
                    <button
                      key={c.id}
                      className="action-menu-item"
                      disabled={action.busy}
                      aria-pressed={!!c.contains_work}
                      title={
                        c.contains_work
                          ? t(`Rimuovi da ${c.name}`, `Remove from ${c.name}`)
                          : t(`Aggiungi a ${c.name}`, `Add to ${c.name}`)
                      }
                      onClick={(event) => {
                        choiceFocus.current = event.currentTarget;
                        void action.run(() => update(c.id, !!c.contains_work));
                      }}
                    >
                      <Icon name={c.contains_work ? "check" : "folder"} />
                      <span>{c.name}</span>
                    </button>
                  ))}
              </div>
              {!data.data.pages.some((p) =>
                p.items.some((c) => c.accepted && c.role !== "Viewer"),
              ) && (
                <p className="action-menu-empty">
                  {t(
                    "Non hai ancora collezioni modificabili.",
                    "No editable collections yet.",
                  )}
                </p>
              )}
              {data.hasNextPage && (
                <Button
                  disabled={data.isFetchingNextPage}
                  onClick={() => void data.fetchNextPage()}
                >
                  {t("Altre collezioni", "More collections")}
                </Button>
              )}
            </>
          )}
        </>
      )}
      {action.error && <Notice error>{action.error}</Notice>}
    </>
  );
}
