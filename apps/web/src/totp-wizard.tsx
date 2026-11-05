import { OtpInput } from "./otp-input";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@palimora/ui";
import { call } from "./api";
import {
  Feedback,
  Form,
  PasswordFields,
  proof,
  useAction,
  useText,
} from "./shared";

export function downloadCodes(codes: string[]) {
  const url = URL.createObjectURL(
    new Blob([codes.join("\n")], { type: "text/plain" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "palimora-recovery.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function TotpWizard({
  onClose,
  onEnabled,
}: {
  onClose: () => void;
  onEnabled: () => Promise<void>;
}) {
  const t = useText(),
    action = useAction(),
    copyAction = useAction();
  const [step, setStep] = useState(0),
    [secret, setSecret] = useState(""),
    [qr, setQr] = useState("");
  const [code, setCode] = useState(""),
    [codes, setCodes] = useState<string[]>([]),
    [downloaded, setDownloaded] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const steps = [
    t("Identità", "Identity"),
    t("Autenticatore", "Authenticator"),
    t("Backup", "Backup"),
  ];
  return (
    <div className="totp-wizard">
      <button
        type="button"
        className="icon-button wizard-back"
        disabled={action.busy}
        aria-label={t("Indietro", "Back")}
        title={t("Indietro", "Back")}
        onClick={() => {
          if (step === 0) {
            onClose();
            return;
          }
          if (step === 1) {
            setCodes([]);
            setDownloaded(false);
            setCode("");
            setSecret("");
            setQr("");
          }
          setStep(step - 1);
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="m12 5-7 7 7 7M5 12h15" />
        </svg>
      </button>
      <ol className="security-steps" aria-label={t("Passaggi", "Steps")}>
        {steps.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? "step" : undefined}
            data-complete={i < step}
          >
            <span>{i < step ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className="wizard-step" key={step}>
        <h3 ref={heading} tabIndex={-1}>
          {
            [
              t("Conferma la tua identità", "Confirm your identity"),
              t("Collega la tua app", "Connect your app"),
              t("Conserva i codici di backup", "Save your backup codes"),
            ][step]
          }
        </h3>
        {step === 0 && (
          <Form
            busy={action.busy}
            onSubmit={(f) =>
              action.run(async () => {
                const pending = await call("totpStart", proof(f));
                const image = await QRCode.toDataURL(pending.uri, {
                  width: 208,
                  margin: 2,
                });
                setSecret(pending.secret);
                setQr(image);
                setStep(1);
              })
            }
          >
            <p className="muted">
              {t(
                "Inserisci la password attuale per proteggere il tuo account con un secondo fattore.",
                "Enter your current password to protect your account with a second factor.",
              )}
            </p>
            <PasswordFields confirm />
            <Feedback action={action} />
            <Button tone="primary" type="submit">
              {t("Continua", "Continue")}
            </Button>
          </Form>
        )}
        {step === 1 && (
          <Form
            busy={action.busy}
            onSubmit={() =>
              action.run(async () => {
                if (codes.length) {
                  setStep(2);
                  return;
                }
                const result = await call("totpVerify", { code });
                setCodes(result.codes);
                setStep(2);
              })
            }
          >
            <p className="muted">
              {t(
                "Scansiona il QR con la tua app di autenticazione, poi inserisci il codice generato.",
                "Scan the QR with your authenticator app, then enter the generated code.",
              )}
            </p>
            <div className="authenticator-qr">
              <img
                src={qr}
                width={208}
                height={208}
                alt={t("QR per configurare TOTP", "TOTP setup QR")}
              />
            </div>
            <div className="manual-key">
              <small>
                {t(
                  "Oppure inserisci manualmente questa chiave",
                  "Or enter this key manually",
                )}
              </small>
              <div className="manual-key-value">
                <code>{secret}</code>
                <button
                  className="icon-button"
                  title={t("Copia chiave", "Copy key")}
                  type="button"
                  aria-label={t("Copia chiave", "Copy key")}
                  onClick={() =>
                    void copyAction.run(
                      async () => {
                        await navigator.clipboard.writeText(secret);
                      },
                      t("Chiave copiata.", "Key copied."),
                    )
                  }
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {copyAction.done ? (
                      <path d="m5 12 4 4L19 6" />
                    ) : (
                      <>
                        <rect x="8" y="8" width="12" height="13" rx="2" />
                        <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
            </div>
            <div className={copyAction.error ? "" : "sr-only"}>
              <Feedback action={copyAction} />
            </div>
            <OtpInput
              value={code}
              onChange={setCode}
              verified={codes.length > 0}
            />
            {codes.length > 0 && (
              <p className="otp-verified" role="status">
                {t("Codice verificato", "Code verified")}
              </p>
            )}
            <Feedback action={action} />
            <Button tone="primary" type="submit" disabled={code.length !== 6}>
              {codes.length
                ? t("Continua", "Continue")
                : t("Verifica codice", "Verify code")}
            </Button>
          </Form>
        )}
        {step === 2 && (
          <>
            <p className="muted">
              {t(
                "Ogni codice è utilizzabile una sola volta se perdi l’accesso alla tua app. Scaricali e conservali in un luogo sicuro prima di attivare la 2FA.",
                "Each code can be used once if you lose access to your app. Download and store them safely before enabling 2FA.",
              )}
            </p>
            <ul className="codes backup-codes">
              {codes.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
            <Button
              disabled={action.busy}
              onClick={() => {
                downloadCodes(codes);
                setDownloaded(true);
              }}
            >
              {downloaded
                ? t("Scarica di nuovo", "Download again")
                : t("Scarica codici di backup", "Download backup codes")}
            </Button>
            <p className="muted" role="status">
              {downloaded
                ? t(
                    "Verifica di aver salvato il file, poi conferma l’attivazione.",
                    "Check that you saved the file, then confirm activation.",
                  )
                : t("La 2FA non è ancora attiva.", "2FA is not enabled yet.")}
            </p>
            <Feedback action={action} />
            <Button
              tone="primary"
              disabled={!downloaded || action.busy}
              onClick={() =>
                void action.run(async () => {
                  await call("totpEnable", { backupCodesSaved: true });
                  await onEnabled();
                })
              }
            >
              {t("Conferma e attiva 2FA", "Confirm and enable 2FA")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
