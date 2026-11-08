import { useText } from "./shared";
import { createPortal } from "react-dom";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icons";

/** Anchored non-modal action dialog; normal Tab order, Escape and outside dismissal. */
export function ActionMenu({
  label,
  icon,
  title = label,
  active = false,
  compact = false,
  children,
}: {
  label: string;
  title?: string;
  active?: boolean;
  icon: Parameters<typeof Icon>[0]["name"];
  compact?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const t = useText();
  const id = useId(),
    trigger = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [position, setPosition] = useState({ left: 8, top: 8 });
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current!.getBoundingClientRect(),
        height = panel.current?.getBoundingClientRect().height ?? 300;
      const width = Math.min(336, innerWidth - 24);
      setPosition({
        left: Math.max(12, Math.min(innerWidth - width - 12, r.left)),
        top: Math.max(12, Math.min(r.bottom + 8, innerHeight - height - 12)),
      });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    const outside = (e: PointerEvent) => {
      if (
        !panel.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const otherMenu = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setOpen(false);
    };
    window.addEventListener("palimora-action-menu-open", otherMenu);
    place();
    const initial =
      panel.current?.querySelector<HTMLElement>(
        "textarea, input:not([type=checkbox]):not([type=radio]), select",
      ) ??
      panel.current?.querySelector<HTMLElement>(
        "input:checked, .action-menu-item",
      ) ??
      panel.current?.querySelector<HTMLElement>("button");
    initial?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", outside, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("palimora-action-menu-open", otherMenu);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-active={active || undefined}
        className={compact ? "button reader-icon-action" : "button"}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (!open)
            window.dispatchEvent(
              new CustomEvent("palimora-action-menu-open", { detail: id }),
            );
          setOpen(!open);
        }}
      >
        <Icon name={icon} filled={icon === "bookmark" && active} />
        {!compact && <span>{label}</span>}
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={panel}
            role="dialog"
            aria-label={title}
            className="action-menu"
            style={position}
          >
            <div className="action-menu-heading">
              <span>{title}</span>
              <button
                type="button"
                className="text-button"
                aria-label={t("Chiudi", "Close")}
                onClick={close}
              >
                <Icon name="close" />
              </button>
            </div>
            {children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}
