import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { Output } from "@palimora/contracts";
import { Button, Notice, Select } from "@palimora/ui";
import { ActionMenu } from "./action-menu";
import { Icon } from "./icons";
import { IconButton } from "./library-ui";
import { LibrarySearchField } from "./library-search";
import { call } from "./api";
import { useAction, useText, Loading, QueryError } from "./shared";

type Props = {
  id: string;
  members: Output<"collectionDetail">["members"];
  owner: boolean;
  onUpdated: () => Promise<unknown>;
};
export function CollectionMembers(props: Props) {
  const t = useText();
  return (
    <ActionMenu
      compact
      icon="users"
      label={t("Membri e condivisione", "Members and sharing")}
    >
      {() => <MembersPanel {...props} />}
    </ActionMenu>
  );
}
function MembersPanel({ id, members, owner, onUpdated }: Props) {
  const t = useText(),
    action = useAction(t),
    client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [role, setRole] = useState<"Viewer" | "Editor">("Viewer");
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const candidates = useInfiniteQuery({
    queryKey: ["collection-candidates", id, search.trim()],
    enabled: owner,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("collectionCandidates", { id, q: search.trim(), cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  const refresh = async () => {
    await onUpdated();
    await client.invalidateQueries({ queryKey: ["collection-candidates", id] });
  };
  const names = [
    ...new Set([
      ...selected,
      ...(candidates.data?.pages.flatMap((p) =>
        p.items.map((u) => u.username),
      ) ?? []),
    ]),
  ];
  return (
    <div className="collection-members-panel">
      {owner && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              try {
                for (const username of selected) {
                  await call("collectionMember", { id, username, role });
                  setSelected((old) => old.filter((n) => n !== username));
                }
              } finally {
                await refresh();
              }
            });
          }}
        >
          <LibrarySearchField
            label={t("Cerca utenti", "Search users")}
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
          />
          <fieldset
            className="action-menu-options recommendation-recipients"
            disabled={action.busy}
          >
            <legend className="sr-only">
              {t("Utenti da invitare", "Users to invite")}
            </legend>
            {names.map((username) => (
              <label key={username} className="action-menu-option">
                <input
                  type="checkbox"
                  checked={selected.includes(username)}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, username]
                        : old.filter((n) => n !== username),
                    )
                  }
                />
                <span>{username}</span>
                <Icon name="check" />
              </label>
            ))}
            {candidates.isPending && <Loading />}
            {candidates.isError && (
              <QueryError retry={() => void candidates.refetch()} />
            )}
            {candidates.isSuccess && !names.length && (
              <p className="action-menu-empty">
                {t("Nessun utente disponibile.", "No users available.")}
              </p>
            )}
            {candidates.hasNextPage && (
              <Button
                type="button"
                disabled={candidates.isFetchingNextPage}
                onClick={() => void candidates.fetchNextPage()}
              >
                {t("Mostra altri", "Show more")}
              </Button>
            )}
          </fieldset>
          {selected.length > 0 && (
            <div className="collection-invite-actions">
              <Select
                label={t("Permesso degli invitati", "Invitee permission")}
                value={role}
                disabled={action.busy}
                onChange={(e) => setRole(e.target.value as typeof role)}
              >
                <option value="Viewer">{t("Sola lettura", "Read only")}</option>
                <option value="Editor">
                  {t("Può modificare", "Can edit")}
                </option>
              </Select>
              <Button type="submit" disabled={action.busy}>
                {t("Invita", "Invite")} ({selected.length})
              </Button>
            </div>
          )}
        </form>
      )}
      {action.error && <Notice error>{action.error}</Notice>}
      <h3>{t("Membri", "Members")}</h3>
      <ul className="collection-member-list">
        {members.map((m) => (
          <li key={m.user_id}>
            <div className="collection-member-row">
              <div>
                <strong>{m.username}</strong>
                <small>
                  {m.role === "Owner"
                    ? t("Proprietario", "Owner")
                    : m.role === "Editor"
                      ? t("Può modificare", "Can edit")
                      : t("Sola lettura", "Read only")}
                  {!m.accepted &&
                    t(" · Invito in attesa", " · Invitation pending")}
                </small>
              </div>
              {owner && m.role !== "Owner" && (
                <>
                  <IconButton
                    icon="edit"
                    label={
                      t("Modifica permesso di ", "Edit permission for ") +
                      m.username
                    }
                    disabled={action.busy}
                    onClick={() => {
                      setEditing(editing === m.username ? null : m.username);
                      setRemoving(null);
                    }}
                  />
                  <IconButton
                    icon="trash"
                    label={t("Rimuovi ", "Remove ") + m.username}
                    disabled={action.busy}
                    onClick={() => {
                      setRemoving(m.username);
                      setEditing(null);
                    }}
                  />
                </>
              )}
            </div>
            {editing === m.username && (
              <Select
                label={t("Permessi di ", "Permissions for ") + m.username}
                value={m.role}
                disabled={action.busy}
                onChange={(e) => {
                  const next = e.target.value as "Editor" | "Viewer";
                  void action.run(async () => {
                    await call("collectionMember", {
                      id,
                      username: m.username,
                      role: next,
                    });
                    await refresh();
                    setEditing(null);
                  });
                }}
              >
                <option value="Viewer">{t("Sola lettura", "Read only")}</option>
                <option value="Editor">
                  {t("Può modificare", "Can edit")}
                </option>
              </Select>
            )}
            {removing === m.username && (
              <div className="collection-member-confirm">
                <p>
                  {t(
                    `Rimuovere ${m.username} dalla collezione?`,
                    `Remove ${m.username} from this collection?`,
                  )}
                </p>
                <Button
                  disabled={action.busy}
                  onClick={() => setRemoving(null)}
                >
                  {t("Annulla", "Cancel")}
                </Button>
                <Button
                  tone="danger"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await call("collectionMember", {
                        id,
                        username: m.username,
                        role: null,
                      });
                      await refresh();
                      setRemoving(null);
                    })
                  }
                >
                  {t("Rimuovi", "Remove")}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
