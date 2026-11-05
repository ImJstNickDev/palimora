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
      <header>
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
          <div className="layout">
            <Navigation />
            <main id="main">
              <Routes>
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
function Navigation() {
  const t = useText(),
    { user } = useContext(Auth);
  return (
    <nav aria-label={t("Navigazione principale", "Main navigation")}>
      <NavLink to="/account">{t("Account", "Account")}</NavLink>
      <NavLink to="/security">{t("Sicurezza", "Security")}</NavLink>
      <NavLink to="/sessions">{t("Dispositivi", "Devices")}</NavLink>
      {user.role !== "User" && (
        <>
          <span className="nav-heading">
            {t("Amministrazione", "Administration")}
          </span>
          <NavLink to="/admin/users">{t("Utenti", "Users")}</NavLink>
          {user.role === "Owner" && (
            <NavLink to="/admin/invites">{t("Inviti", "Invitations")}</NavLink>
          )}
        </>
      )}
    </nav>
  );
}
