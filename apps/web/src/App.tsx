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
import { Button, Notice } from "@palimora/ui";
import { call, ApiFailure } from "./api";
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
import { Users, Invites } from "./admin";
export function App() {
  const [language, setLanguage] = useState("it");
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
  const library = /^\/(?:$|works(?:\/|$)|browse\/|bibliography\/)/.test(
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
    return () => window.removeEventListener("session-expired", cb);
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
          <div className={library ? "layout library-layout" : "layout"}>
            <Navigation library={library} />
            <main id="main">
              <Routes>
                <Route path="/" element={<Catalog />} />
                <Route path="/works" element={<Catalog />} />
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
                  <Route path="/admin/users" element={<Users />} />
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
  const t = useText(),
    { user } = useContext(Auth);
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
