import { useId, useState } from "react";
import { useText } from "./shared";

export function OtpInput({
  value,
  onChange,
  verified = false,
}: {
  value: string;
  onChange: (value: string) => void;
  verified?: boolean;
}) {
  const t = useText(),
    id = useId();
  const [focused, setFocused] = useState(false);
  return (
    <div className="field otp-field">
      <label htmlFor={id}>{t("Codice a 6 cifre", "6-digit code")}</label>
      <div className="otp-control" data-focused={focused}>
        <input
          readOnly={verified}
          id={id}
          name="code"
          aria-label={t("Codice a 6 cifre", "6-digit code")}
          value={value}
          onChange={(e) =>
            onChange(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
          maxLength={6}
        />
        <div className="otp-slots" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <span
              key={i}
              data-active={focused && i === Math.min(value.length, 5)}
              data-filled={!!value[i]}
            >
              <span key={value[i] || "empty"}>{value[i] || "·"}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
