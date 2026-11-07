import type { Output } from "@palimora/contracts";
import { useText } from "./shared";
export type SyncStatus = Output<"ao3Status">;
export type SyncData = Output<"ao3Jobs">;
export function useSyncLabels() {
  const t = useText();
  const pairs: Record<string, [string, string]> = {
    online: ["Operativo", "Operational"],
    maintenance: ["Manutenzione", "Maintenance"],
    rate_limited: ["Limite richieste", "Rate limited"],
    blocked: ["Accesso bloccato", "Access blocked"],
    unreachable: ["Non raggiungibile", "Unreachable"],
    unknown: ["Non verificato", "Unverified"],
    cooldown: ["Attesa richiesta da AO3", "AO3 cooldown"],
    manual_offline: ["Offline manuale", "Manually offline"],
    paused: ["In pausa", "Paused"],
    work: ["Opere", "Works"],
    discovery: ["Nuove pubblicazioni", "New publications"],
    backfill: ["Archivio storico", "Historical archive"],
    entity: ["Autori, tag e serie", "Authors, tags and series"],
    media: ["Media", "Media"],
    pending: ["In coda", "Queued"],
    retry: ["Da riprovare", "Retry pending"],
    idle: ["In monitoraggio", "Monitoring"],
    running: ["In corso", "Running"],
    stopping: ["Arresto in corso", "Stopping"],
    waiting_service: ["In attesa di AO3", "Waiting for AO3"],
    scheduled: ["Pianificato", "Scheduled"],
    ready: ["Pronto in coda", "Ready in queue"],
    deleted: ["Opera eliminata", "Deleted work"],
    completed: ["Completato", "Completed"],
    interrupted: ["Interrotto", "Interrupted"],
    anonymous: ["Nessun account configurato", "No account configured"],
    authenticated: ["Autenticato", "Authenticated"],
    expired: ["Sessione scaduta", "Session expired"],
    rejected: ["Credenziali rifiutate", "Credentials rejected"],
  };
  return (key: string) => (pairs[key] ? t(...pairs[key]) : key);
}
export function useSyncError() {
  const t = useText();
  const errors: Record<string, [string, string]> = {
    ROBOTS_DISALLOWED: [
      "Acquisizione vietata dalla policy AO3",
      "Acquisition disallowed by AO3 policy",
    ],
    AO3_MAINTENANCE: ["Archivio in manutenzione", "Archive under maintenance"],
    AO3_OFFLINE: ["AO3 non disponibile", "AO3 unavailable"],
    AO3_RATE_LIMIT: ["Limite richieste raggiunto", "Request limit reached"],
    AO3_COOLDOWN: ["Sospensione richiesta da AO3", "AO3 cooldown"],
    AO3_LOGIN_REQUIRED: [
      "Richiede un account AO3 autorizzato",
      "Requires an authorized AO3 account",
    ],
    AO3_LOGIN_REJECTED: [
      "Credenziali AO3 rifiutate",
      "AO3 credentials rejected",
    ],
    AO3_INCOMPLETE_CHAPTERS: [
      "Acquisizione incompleta: versione precedente conservata",
      "Incomplete acquisition: previous version preserved",
    ],
    MEDIA_UNRECOVERABLE: [
      "Risorsa non trovata o rimossa (404/410)",
      "Resource missing or removed (404/410)",
    ],
    MEDIA_NOT_ATTACHMENT: [
      "Il link restituisce una pagina, non un media",
      "The link returns a page, not a media file",
    ],
    MEDIA_NETWORK: [
      "Sorgente media non raggiungibile",
      "Media source unreachable",
    ],
    MEDIA_RATE_LIMIT: [
      "Sorgente media temporaneamente sospesa",
      "Media source temporarily paused",
    ],
    MEDIA_ADDRESS_BLOCKED: ["Indirizzo non consentito", "Address not allowed"],
    AO3_NETWORK: ["Connessione ad AO3 non riuscita", "AO3 connection failed"],
    SYNC_INTERNAL_ERROR: [
      "Errore di elaborazione; riprova pianificata",
      "Processing error; retry scheduled",
    ],
  };
  return (code: string | null) =>
    code
      ? errors[code]
        ? t(...errors[code])
        : t("Acquisizione non riuscita", "Acquisition failed") + " · " + code
      : "—";
}
export function SyncBadge({
  state,
  children,
}: {
  state: string;
  children?: React.ReactNode;
}) {
  const label = useSyncLabels();
  const tone = ["online", "ready", "completed", "authenticated"].includes(state)
    ? "success"
    : ["running"].includes(state)
      ? "active"
      : [
            "maintenance",
            "waiting_service",
            "rate_limited",
            "cooldown",
            "stopping",
          ].includes(state)
        ? "warning"
        : "neutral";
  return (
    <span className={`archive-status ${tone}`}>
      <span aria-hidden="true" />
      {children ?? label(state)}
    </span>
  );
}
export function mediaName(url: string) {
  try {
    return decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean).at(-1) ??
        new URL(url).hostname,
    );
  } catch {
    return url;
  }
}
export function SyncMark() {
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6" />
    </svg>
  );
}
