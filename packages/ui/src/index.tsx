import React, { useId, useRef, useLayoutEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import "./tokens.css";
export function Button({
  tone = "normal",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "normal" | "primary" | "danger";
}) {
  return <button className={`button ${tone}`} {...props} />;
}
export function Field({
  label,
  hint,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-describedby={hint ? id + "-hint" : undefined}
        {...props}
      />
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </div>
  );
}
export function Select({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...props}>
        {children}
      </select>
    </div>
  );
}
export function Notice({
  children,
  error = false,
}: React.PropsWithChildren<{ error?: boolean }>) {
  return (
    <p
      className={`notice ${error ? "error" : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </p>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  closeLabel,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  closeLabel: string;
}) {
  const descriptionId = useId();
  const returnFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) returnFocus.current = document.activeElement as HTMLElement;
  }, [open]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="modal"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus.current?.isConnected
              ? returnFocus.current
              : document.querySelector<HTMLElement>("main h1");
            target?.focus({ preventScroll: true });
          }}
          aria-describedby={description ? descriptionId : undefined}
        >
          <div className="row">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button aria-label={closeLabel}>×</Button>
            </Dialog.Close>
          </div>
          {description && (
            <Dialog.Description id={descriptionId}>
              {description}
            </Dialog.Description>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
