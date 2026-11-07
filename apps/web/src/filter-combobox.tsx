import { Input as InputControl } from "@palimora/ui";
import { useEffect, useId, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Input } from "@palimora/contracts";
import { call } from "./api";
import { useText } from "./shared";

/** One interaction model for searchable source values, including keyboard/touch. */
export function FilterCombobox({
  kind,
  label,
  selected,
  onSelect,
  facets = [],
  exclude = false,
  maxLength = 500,
}: {
  kind: Input<"catalogBrowse">["kind"];
  label: string;
  selected: string[];
  onSelect: (value: string) => void;
  facets?: { name: string; count: number }[];
  exclude?: boolean;
  maxLength?: number;
}) {
  const t = useText(),
    id = useId();
  const field = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false),
    [listHeight, setListHeight] = useState(240);
  const [text, setText] = useState(""),
    [search, setSearch] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(-1);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 180);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (!open) return;
    const input = document.getElementById(id);
    const inputRect = input?.getBoundingClientRect();
    const footerRect = field.current
      ?.closest("form")
      ?.querySelector(".filter-apply")
      ?.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const visibleBottom = Math.min(
      viewportTop + (viewport?.height ?? window.innerHeight),
      footerRect?.top ?? Infinity,
    );
    if (
      inputRect &&
      (inputRect.bottom > visibleBottom - 12 ||
        inputRect.top < viewportTop + 12)
    )
      input?.scrollIntoView({ block: "center" });
    const position = () => {
      const rect = field.current?.getBoundingClientRect();
      if (!rect) return;
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0,
        bottom = top + (viewport?.height ?? window.innerHeight);
      const footer =
        field.current
          ?.closest("form")
          ?.querySelector(".filter-apply")
          ?.getBoundingClientRect().height ?? 0;
      const below = bottom - rect.bottom - footer - 12,
        before = rect.top - top - 12;
      const flip = below < 230 && before > below;
      setAbove(flip);
      setListHeight(Math.max(80, Math.min(240, (flip ? before : below) - 48)));
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
    };
  }, [open, id]);
  const browse = useQuery({
    queryKey: ["filter-suggestions", kind, search],
    queryFn: () => call("catalogBrowse", { kind, q: search || undefined }),
    enabled: open,
    staleTime: 60000,
  });
  const local = !search && facets.length > 0;
  const suggestions = (
    local
      ? facets
      : (browse.data?.items.map((v) => ({ name: v.name, count: v.works })) ??
        [])
  ).slice(0, 8);
  const pending = text.trim() !== search;
  const custom =
    !!text.trim() && !suggestions.some((s) => s.name === text.trim());
  const choices = [
    ...(pending ? [] : suggestions.map((s) => s.name)),
    ...(custom ? [text.trim()] : []),
  ];
  const choose = (value: string) => {
    if (!value.trim()) return;
    onSelect(value.trim());
    setText("");
    setSearch("");
    setOpen(false);
    setActive(-1);
  };
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(id + "-" + active)
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open, id]);
  return (
    <div
      ref={field}
      className="tag-combobox"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={id}>{label}</label>
      <div className="combobox-field">
        <InputControl
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={id + "-options"}
          aria-activedescendant={
            open && active >= 0 && active < choices.length
              ? id + "-" + active
              : undefined
          }
          value={text}
          placeholder={
            kind === "language"
              ? t("Cerca una lingua…", "Find a language…")
              : t("Cerca o scrivi un tag…", "Find or enter a tag…")
          }
          autoComplete="off"
          maxLength={maxLength}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setActive((i) =>
                !choices.length
                  ? -1
                  : i < 0
                    ? e.key === "ArrowDown"
                      ? 0
                      : choices.length - 1
                    : (i + (e.key === "ArrowDown" ? 1 : -1) + choices.length) %
                      choices.length,
              );
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              setActive(-1);
            } else if (
              e.key === "Enter" &&
              (text.trim() || (open && active >= 0))
            ) {
              e.preventDefault();
              choose(open && active >= 0 ? (choices[active] ?? text) : text);
            }
          }}
        />
        <button
          type="button"
          className="combobox-toggle"
          aria-label={t("Mostra suggerimenti: ", "Show suggestions: ") + label}
          aria-expanded={open}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            document.getElementById(id)?.focus();
            setOpen(!open);
            setActive(-1);
          }}
        >
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path
              d="m5 8 5 5 5-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        </button>
      </div>
      {open && (
        <div className="tag-options" data-above={above}>
          <small>
            {local
              ? t("Nei risultati attuali", "In current results")
              : t("Nella biblioteca", "In the library")}
          </small>
          <ul
            id={id + "-options"}
            role="listbox"
            style={{ maxHeight: listHeight }}
            aria-label={
              kind === "language"
                ? t("Suggerimenti lingua", "Language suggestions")
                : t("Suggerimenti tag", "Tag suggestions")
            }
          >
            {!pending &&
              suggestions.map((item, i) => (
                <li
                  key={item.name}
                  id={id + "-" + i}
                  role="option"
                  aria-selected={selected.includes(item.name)}
                  data-active={active === i}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(item.name)}
                >
                  <span>
                    {selected.includes(item.name)
                      ? "✓ "
                      : exclude
                        ? "− "
                        : "+ "}
                    {item.name}
                  </span>
                  <small>{item.count.toLocaleString(t("it", "en"))}</small>
                </li>
              ))}
            {custom && (
              <li
                id={id + "-" + (pending ? 0 : suggestions.length)}
                role="option"
                aria-selected={false}
                data-active={active === (pending ? 0 : suggestions.length)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(text)}
              >
                {t("Usa il testo: ", "Use text: ")}
                <strong>{text.trim()}</strong>
              </li>
            )}
          </ul>
          {(pending || (!local && browse.isFetching)) && (
            <small role="status">{t("Ricerca…", "Searching…")}</small>
          )}
          {!pending && !browse.isFetching && !suggestions.length && !custom && (
            <small>
              {t(
                "Nessun suggerimento disponibile.",
                "No suggestions available.",
              )}
            </small>
          )}
          {!local && browse.isError && (
            <button
              type="button"
              className="text-button"
              onClick={() => void browse.refetch()}
            >
              {t("Riprova i suggerimenti", "Retry suggestions")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
