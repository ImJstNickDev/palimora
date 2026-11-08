import { canonicalLibraryLocation } from "./library-routes";
import { pendingOperations } from "./offline";
import { OfflineLibrary, OfflineRuntime, useOffline } from "./offline-ui";
import {
  Statistics,
  Activity,
  Subscriptions,
  Notifications,
  SocialSettings,
} from "./social";
import { Collections, CollectionDetail } from "./collections";
import { Library } from "./library";
import { AO3Monitor } from "./ao3";
import { Catalog, Browse, Reader, BibliographyPage } from "./catalog";
import { ArchiveStorage } from "./archive-operations";
import {
  Ingest,
  IngestDetail,
  ArchiveWorks,
  ArchiveWork,
  ArchiveObject,
} from "./archive";
import { useContext, useState, useEffect } from "react";
import {
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Notice, Modal } from "@palimora/ui";
import { call, ApiFailure, settleWrites } from "./api";
import {
  client,
  Auth,
  Locale,
  useText,
  useAction,
  Loading,
  QueryError,
} from "./shared";
import { Setup, Login, Register } from "./access";
import { Account, Security, Sessions } from "./account";
import { Users, UserDetail, Invites } from "./admin";
function LibraryRedirect() {
  const location = useLocation();
  const target = canonicalLibraryLocation(location.pathname, location.search);
  return target ? (
    <Navigate to={target + location.hash} state={location.state} replace />
  ) : (
    <Library />
  );
}
export function App() {
  const { offline } = useOffline();
  const [language, setLanguage] = useState("it");
  const [logoutPending, setLogoutPending] = useState(0);
  const logoutAction = useAction((it, en) => (language === "it" ? it : en));
  const location = useLocation();
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => call("status", {}),
  });
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => call("me", {}),
    enabled: status.data?.state === "active",
  });
  const navigate = useNavigate();
  const library =
    /^\/(?:$|works(?:\/|$)|library(?:\/|$)|collections(?:\/|$)|offline$|statistics$|activity$|subscriptions$|notifications$|social-settings$|browse\/|bibliography\/)/.test(
      location.pathname,
    );
  function leave() {
    client.clear();
    navigate("/login");
  }
  useEffect(() => {
    const cb = () => {
      client.clear();
      navigate("/login");
    };
    window.addEventListener("session-expired", cb);
    window.addEventListener("offline-reset", cb);
    return () => {
      window.removeEventListener("session-expired", cb);
      window.removeEventListener("offline-reset", cb);
    };
  }, [navigate]);
  useEffect(() => {
    if (me.data) {
      setLanguage(me.data.user.preferences.language);
      document.documentElement.dataset.theme = me.data.user.preferences.theme;
      document.documentElement.dataset.skin = me.data.user.preferences.skin;
    }
  }, [me.data]);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    document.querySelector<HTMLElement>("main h1")?.focus();
  }, [location.pathname]);
  return (
    <Locale.Provider value={{ language, setLanguage }}>
      <a className="skip" href="#main">
        {language === "it" ? "Vai al contenuto" : "Skip to content"}
      </a>
      <header className="app-header">
        <NavLink className="brand" to="/">
          Palimora<span aria-hidden="true"> / </span>
        </NavLink>
        <span className="instance">{status.data?.name}</span>
        {me.data ? (
          <>
            <span className="identity">
              {me.data.user.username} <small>{me.data.user.role}</small>
            </span>
            <Button
              disabled={logoutAction.busy}
              onClick={() =>
                void logoutAction.run(async () => {
                  window.dispatchEvent(new Event("pagehide"));
                  await settleWrites();
                  const pending = await pendingOperations().catch(() => []);
                  if (pending.length) {
                    setLogoutPending(pending.length);
                    return;
                  }
                  await call("logout", {});
                  leave();
                })
              }
            >
              {language === "it" ? "Esci" : "Sign out"}
            </Button>
          </>
        ) : (
          <select
            aria-label="Language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </select>
        )}
      </header>
      <Modal
        open={logoutPending > 0}
        onClose={() => setLogoutPending(0)}
        title={
          language === "it" ? "Modifiche non sincronizzate" : "Unsynced changes"
        }
        closeLabel={language === "it" ? "Chiudi" : "Close"}
      >
        <p>
          {logoutPending}{" "}
          {language === "it"
            ? "modifiche locali verranno eliminate insieme alle copie offline."
            : "local changes will be deleted along with offline copies."}
        </p>
        <div className="library-controls">
          <Button
            onClick={() => {
              setLogoutPending(0);
              navigate("/library/offline");
            }}
          >
            {language === "it"
              ? "Gestisci sincronizzazione"
              : "Manage synchronization"}
          </Button>
          <Button
            tone="danger"
            disabled={logoutAction.busy}
            onClick={() =>
              void logoutAction.run(async () => {
                await call("logout", {});
                setLogoutPending(0);
                leave();
              })
            }
          >
            {language === "it"
              ? "Elimina dati locali ed esci"
              : "Delete local data and sign out"}
          </Button>
        </div>
      </Modal>
      {logoutAction.error && <Notice error>{logoutAction.error}</Notice>}
      {status.isPending ? (
        <main id="main">
          <Loading />
        </main>
      ) : status.isError ? (
        <main id="main">
          <QueryError retry={() => void status.refetch()} />
        </main>
      ) : status.data.state === "uninitialized" ? (
        <main id="main" className="auth">
          <Setup
            onDone={async () => {
              await status.refetch();
              await me.refetch();
              navigate("/account");
            }}
          />
        </main>
      ) : me.isPending ? (
        <main id="main">
          <Loading />
        </main>
      ) : me.data ? (
        <Auth.Provider
          value={{ user: me.data.user, refresh: () => me.refetch(), leave }}
        >
          <OfflineRuntime />
          <div className={library ? "layout library-layout" : "layout"}>
            <Navigation library={library} />
            <main id="main">
              <Routes>
                <Route path="/library/offline" element={<OfflineLibrary />} />
                <Route
                  path="/"
                  element={
                    offline ? (
                      <Navigate to="/library/offline" replace />
                    ) : (
                      <Catalog />
                    )
                  }
                />
                <Route
                  path="/works"
                  element={
                    offline ? (
                      <Navigate to="/library/offline" replace />
                    ) : (
                      <Catalog />
                    )
                  }
                />
                <Route path="/library" element={<LibraryRedirect />} />
                <Route
                  path="/library/later"
                  element={<Library kind="later" />}
                />
                <Route
                  path="/library/history"
                  element={<Library kind="history" />}
                />
                {[
                  "/collections",
                  "/collections/:id",
                  "/offline",
                  "/statistics",
                  "/activity",
                  "/subscriptions",
                  "/notifications",
                  "/social-settings",
                ].map((path) => (
                  <Route key={path} path={path} element={<LibraryRedirect />} />
                ))}
                <Route path="/library/statistics" element={<Statistics />} />
                <Route path="/library/activity" element={<Activity />} />
                <Route
                  path="/library/subscriptions"
                  element={<Subscriptions />}
                />
                <Route
                  path="/library/notifications"
                  element={<Notifications />}
                />
                <Route path="/library/settings" element={<SocialSettings />} />
                <Route path="/library/collections" element={<Collections />} />
                <Route
                  path="/library/collections/:id"
                  element={<CollectionDetail />}
                />
                <Route
                  path="/bibliography/:kind/:id"
                  element={<BibliographyPage />}
                />
                <Route path="/works/:id" element={<Reader />} />
                <Route path="/browse/:kind" element={<Browse />} />
                {me.data.user.role !== "User" && (
                  <>
                    <Route
                      path="/admin/archive/storage"
                      element={<ArchiveStorage />}
                    />
                    <Route path="/admin/ao3" element={<AO3Monitor />} />
                    <Route path="/admin/ingest" element={<Ingest />} />
                    <Route
                      path="/admin/ingest/:id"
                      element={<IngestDetail />}
                    />
                    <Route path="/admin/archive" element={<ArchiveWorks />} />
                    <Route
                      path="/admin/archive/objects/:hash"
                      element={<ArchiveObject />}
                    />
                    <Route
                      path="/admin/archive/:id"
                      element={<ArchiveWork />}
                    />
                  </>
                )}
                <Route path="/account" element={<Account />} />
                <Route path="/security/*" element={<Security />} />
                <Route path="/sessions" element={<Sessions />} />
                {me.data.user.role !== "User" && (
                  <>
                    <Route path="/admin/users" element={<Users />} />
                    <Route path="/admin/users/:id/*" element={<UserDetail />} />
                  </>
                )}{" "}
                {me.data.user.role === "Owner" && (
                  <Route path="/admin/invites" element={<Invites />} />
                )}
                <Route path="*" element={<Navigate to="/account" replace />} />
              </Routes>
            </main>
          </div>
        </Auth.Provider>
      ) : me.error instanceof ApiFailure &&
        me.error.code === "UNAUTHENTICATED" ? (
        <main id="main" className="auth">
          <Routes>
            <Route
              path="/register"
              element={
                <Register
                  onDone={async () => {
                    await me.refetch();
                    navigate("/account");
                  }}
                />
              }
            />
            <Route
              path="*"
              element={
                <Login
                  onDone={async () => {
                    await me.refetch();
                    navigate("/account");
                  }}
                />
              }
            />
          </Routes>
        </main>
      ) : (
        <main id="main">
          <QueryError retry={() => void me.refetch()} />
        </main>
      )}
    </Locale.Provider>
  );
}
function Navigation({ library }: { library: boolean }) {
  const location = useLocation();
  const { offline } = useOffline();
  const t = useText(),
    { user } = useContext(Auth);
  if (offline)
    return (
      <nav
        className="library-navigation"
        aria-label={t("Navigazione principale", "Main navigation")}
      >
        <NavLink to="/library/offline">
          {t("Lettura offline", "Offline reading")}
        </NavLink>
      </nav>
    );
  if (library)
    return (
      <nav
        className="library-navigation"
        aria-label={t("Navigazione principale", "Main navigation")}
      >
        <NavLink
          to="/works"
          className={({ isActive }) =>
            isActive || location.pathname === "/" ? "active" : ""
          }
        >
          {t("Opere", "Works")}
        </NavLink>
        <NavLink to="/library">{t("Biblioteca", "Library")}</NavLink>
        <NavLink to="/browse/fandom">Fandom</NavLink>
        <NavLink to="/browse/creators">{t("Autori", "Authors")}</NavLink>
        <NavLink to="/browse/freeform">Tag</NavLink>
        <NavLink to="/browse/series">{t("Serie", "Series")}</NavLink>
        <NavLink to="/browse/collections">
          {t("Collezioni", "Collections")}
        </NavLink>
        <NavLink className="library-account" to="/account">
          Account
        </NavLink>
        {user.role !== "User" && (
          <NavLink to="/admin/ingest">
            {t("Amministrazione", "Administration")}
          </NavLink>
        )}
      </nav>
    );
  return (
    <nav
      className="main-navigation"
      aria-label={t("Navigazione principale", "Main navigation")}
    >
      <NavLink to="/works">{t("Opere", "Works")}</NavLink>
      <NavLink to="/library">{t("Biblioteca", "Library")}</NavLink>
      <NavLink to="/library/notifications">
        {t("Notifiche", "Notifications")}
      </NavLink>
      <NavLink to="/account">{t("Account", "Account")}</NavLink>
      <NavLink to="/security">{t("Sicurezza", "Security")}</NavLink>
      <NavLink to="/sessions">{t("Dispositivi", "Devices")}</NavLink>
      {user.role !== "User" && (
        <>
          <span className="nav-heading">
            {t("Amministrazione", "Administration")}
          </span>
          <NavLink to="/admin/ingest">{t("Importazioni", "Imports")}</NavLink>
          <NavLink to="/admin/ao3">AO3</NavLink>
          <NavLink to="/admin/archive/storage">
            {t("Storage", "Storage")}
          </NavLink>
          <NavLink
            to="/admin/archive"
            end={location.pathname === "/admin/archive/storage"}
          >
            {t("Archivio tecnico", "Technical archive")}
          </NavLink>
          <NavLink to="/admin/users">{t("Utenti", "Users")}</NavLink>
          {user.role === "Owner" && (
            <NavLink to="/admin/invites">{t("Inviti", "Invitations")}</NavLink>
          )}
        </>
      )}
    </nav>
  );
}
