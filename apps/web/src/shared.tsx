import React, { createContext, useContext, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { Button, Field, Select, Notice } from "@palimora/ui";
import type { User, ErrorCode } from "@palimora/contracts";
import { ApiFailure } from "./api";
export const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 15000, refetchOnWindowFocus: true },
  },
});
export type Prefs = User["preferences"];
export const initialPrefs: Prefs = {
  language: "it",
  theme: "auto",
  skin: "ink",
};
export const Locale = createContext({
  language: "it",
  setLanguage: (_v: string) => {},
});
export const Auth = createContext<{
  user: User;
  refresh: () => Promise<unknown>;
  leave: () => void;
}>(null!);
export const useText = () => {
  const { language } = useContext(Locale);
  return (it: string, en: string) => (language === "it" ? it : en);
};
export function errorText(error: unknown, t: ReturnType<typeof useText>) {
  const code =
    error instanceof ApiFailure
      ? error.code
      : error instanceof Error && error.message === "PASSWORD_MISMATCH"
        ? "PASSWORD_MISMATCH"
        : "";
  const messages: Record<string, string> = {
    INVALID_INPUT: t(
      "Controlla i campi inseriti.",
      "Check the entered fields.",
    ),
    UNAUTHENTICATED: t("Accedi per continuare.", "Sign in to continue."),
    FORBIDDEN: t(
      "Operazione non consentita.",
      "This operation is not permitted.",
    ),
    CSRF: t(
      "Sessione non valida. Ricarica la pagina.",
      "Invalid session. Reload the page.",
    ),
    CONFLICT: t(
      "Il nome utente è già utilizzato o lo stato è cambiato.",
      "The username is taken or the state has changed.",
    ),
    SETUP_CLOSED: t(
      "La configurazione è già completata. Accedi.",
      "Setup is already complete. Sign in.",
    ),
    INVITE_INVALID: t(
      "Invito scaduto, revocato, esaurito o email non corrispondente.",
      "Invitation expired, revoked, exhausted or email does not match.",
    ),
    PASSWORD_MISMATCH: t(
      "Le nuove password non coincidono.",
      "The new passwords do not match.",
    ),
    CREDENTIALS_INVALID: t("Credenziali non valide.", "Invalid credentials."),
    SECOND_FACTOR_REQUIRED: t(
      "Inserisci il codice di autenticazione o un codice recovery.",
      "Enter your authentication or recovery code.",
    ),
    SECOND_FACTOR_INVALID: t(
      "Codice non valido o già utilizzato. Attendi il prossimo codice.",
      "Invalid or already used code. Wait for the next code.",
    ),
    RATE_LIMITED: t(
      "Troppi tentativi. Riprova tra 15 minuti.",
      "Too many attempts. Try again in 15 minutes.",
    ),
    PASSKEY_INVALID: t(
      "Passkey non verificata. Riprova.",
      "Passkey verification failed. Try again.",
    ),
    CHALLENGE_EXPIRED: t(
      "La richiesta è scaduta. Ricomincia.",
      "The request expired. Start again.",
    ),
    NOT_FOUND: t("Elemento non trovato.", "Item not found."),
  };
  return (
    messages[code] ??
    t(
      "Operazione non riuscita. Riprova.",
      "The operation failed. Please try again.",
    )
  );
}
export function useAction(
  translate?: ReturnType<typeof useText>,
  errors: Partial<Record<ErrorCode, string>> = {},
) {
  const localText = useText();
  const t = translate ?? localText;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  return {
    busy,
    error,
    done,
    setDone,
    reset: () => {
      setError("");
      setDone("");
    },
    run: async (fn: () => Promise<unknown>, success = "") => {
      setBusy(true);
      setError("");
      setDone("");
      try {
        await fn();
        if (success) setDone(success);
        return true;
      } catch (e) {
        setError(
          e instanceof ApiFailure && errors[e.code]
            ? errors[e.code]!
            : errorText(e, t),
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}
export function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <>
      {action.error && <Notice error>{action.error}</Notice>}
      {action.done && <Notice>{action.done}</Notice>}
    </>
  );
}
export function Form({
  children,
  onSubmit,
  busy = false,
}: {
  children: React.ReactNode;
  onSubmit: (form: FormData) => Promise<unknown>;
  busy?: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        void onSubmit(new FormData(form)).then((success) => {
          if (success === true)
            form
              .querySelectorAll<HTMLInputElement>(
                'input[type="password"],input[autocomplete="one-time-code"]',
              )
              .forEach((input) => {
                input.value = "";
              });
        });
      }}
    >
      <fieldset disabled={busy}>{children}</fieldset>
    </form>
  );
}
export const val = (f: FormData, k: string) => String(f.get(k) ?? "");
export const proof = (f: FormData) => ({
  password: val(f, "password"),
  code: val(f, "code") || undefined,
});
export function PasswordFields({ confirm = false }: { confirm?: boolean }) {
  const t = useText();
  const { user } = useContext(Auth) ?? {};
  return (
    <>
      <Field
        label={
          confirm
            ? t("Password attuale", "Current password")
            : t("Password", "Password")
        }
        name="password"
        type="password"
        required
        minLength={confirm ? 1 : 12}
        maxLength={128}
        autoComplete={confirm ? "current-password" : "new-password"}
        hint={
          !confirm
            ? t("Almeno 12 caratteri.", "At least 12 characters.")
            : undefined
        }
      />
      {confirm && user?.totp_enabled && (
        <Field
          label={t("Codice TOTP o recovery", "TOTP or recovery code")}
          name="code"
          required
          autoComplete="one-time-code"
          maxLength={100}
        />
      )}
    </>
  );
}
export function PreferencesFields({
  value,
  onChange,
}: {
  value: Prefs;
  onChange: (p: Prefs) => void;
}) {
  const t = useText();
  return (
    <div className="columns">
      <Select
        label={t("Lingua", "Language")}
        value={value.language}
        onChange={(e) =>
          onChange({ ...value, language: e.target.value as Prefs["language"] })
        }
      >
        <option value="it">Italiano</option>
        <option value="en">English</option>
      </Select>
      <Select
        label={t("Tema", "Theme")}
        value={value.theme}
        onChange={(e) =>
          onChange({ ...value, theme: e.target.value as Prefs["theme"] })
        }
      >
        <option value="auto">{t("Sistema", "System")}</option>
        <option value="light">{t("Chiaro", "Light")}</option>
        <option value="dark">{t("Scuro", "Dark")}</option>
      </Select>
      <Select
        label={t("Stile", "Style")}
        value={value.skin}
        onChange={(e) =>
          onChange({ ...value, skin: e.target.value as Prefs["skin"] })
        }
      >
        <option value="ink">{t("Inchiostro", "Ink")}</option>
        <option value="forest">{t("Foresta", "Forest")}</option>
      </Select>
    </div>
  );
}
export function Loading() {
  const t = useText();
  return <p role="status">{t("Caricamento…", "Loading…")}</p>;
}
export function QueryError({ retry }: { retry: () => void }) {
  const t = useText();
  return (
    <Notice error>
      {t("Impossibile caricare i dati.", "Unable to load data.")}{" "}
      <Button onClick={retry}>{t("Riprova", "Retry")}</Button>
    </Notice>
  );
}
export function Heading({ children }: { children: React.ReactNode }) {
  return <h1 tabIndex={-1}>{children}</h1>;
}
