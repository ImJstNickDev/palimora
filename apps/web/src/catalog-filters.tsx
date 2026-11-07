import { FilterCombobox } from "./filter-combobox";
import { useState, type ReactNode } from "react";
import type { Output } from "@palimora/contracts";
import { Input as InputControl, Button } from "@palimora/ui";
import { useText } from "./shared";

type Facets = Output<"catalogWorks">["facets"];
type Draft = Record<string, string>;
const names: Record<string, [string, string]> = {
  fandom: ["Fandom", "Fandom"],
  rating: ["Rating", "Rating"],
  warnings: ["Avvertenze", "Warnings"],
  category: ["Categoria", "Category"],
  relationships: ["Relazioni", "Relationships"],
  characters: ["Personaggi", "Characters"],
  freeform: ["Altri tag", "Additional tags"],
  unclassified: ["Tag sorgente", "Source tags"],
  media: ["Media", "Media"],
  include: ["Tag", "Tags"],
  exclude: ["Esclusi", "Excluded"],
  complete: ["Stato", "Status"],
  language: ["Lingua", "Language"],
  crossover: ["Crossover", "Crossovers"],
  singleChapter: ["Un capitolo", "Single chapter"],
  title: ["Titolo", "Title"],
  creators: ["Autore", "Author"],
  words: ["Parole", "Words"],
  wordsFrom: ["Parole da", "Words from"],
  wordsTo: ["Parole fino a", "Words up to"],
  hits: ["Visite", "Hits"],
  kudos: ["Kudos", "Kudos"],
  comments: ["Commenti", "Comments"],
  bookmarks: ["Bookmark", "Bookmarks"],
  dateFrom: ["Aggiornata dal", "Updated from"],
  dateTo: ["Aggiornata fino al", "Updated until"],
  updatedWithin: ["Aggiornamento", "Updated"],
  availability: ["Disponibilità", "Availability"],
  restricted: ["Accesso AO3", "AO3 access"],
  q: ["Ricerca", "Search"],
  fulltext: ["Nel testo", "In the text"],
  series: ["Serie", "Series"],
  collections: ["Collezioni", "Collections"],
};
const tagKinds = [
  "fandom",
  "rating",
  "warnings",
  "category",
  "relationships",
  "characters",
  "freeform",
  "unclassified",
  "media",
] as const;
const tagKeys: string[] = [...tagKinds, "include", "exclude"];
export const filterParts = (value: string) => [
  ...new Set(
    value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
export function selectFilterValue(
  draft: Draft,
  field: string,
  value: string,
): Draft {
  const patch: Draft = {
    [field]: [...new Set([...filterParts(draft[field] ?? ""), value])].join(
      "\n",
    ),
  };
  if (field === "language") return patch;
  for (const key of field === "exclude"
    ? tagKeys.filter((k) => k !== "exclude")
    : ["exclude"])
    patch[key] = filterParts(draft[key] ?? "")
      .filter((v) => v !== value)
      .join("\n");
  return patch;
}
export function filterCaption(
  key: string,
  value: string,
  t: ReturnType<typeof useText>,
) {
  const label = names[key] ? t(...names[key]) : key;
  if (key === "complete" && ["true", "false"].includes(value))
    return (
      label +
      ": " +
      (value === "true"
        ? t("Complete", "Complete")
        : t("In corso", "In progress"))
    );
  if (key === "singleChapter") return t("Un solo capitolo", "Single chapter");
  if (key === "availability") return t("Eliminate da AO3", "Deleted from AO3");
  if (key === "crossover")
    return value === "true"
      ? t("Solo crossover", "Crossovers only")
      : t("Nessun crossover", "No crossovers");
  if (key === "restricted")
    return value === "true"
      ? t("Accesso AO3 riservato", "Restricted AO3 access")
      : t("Accesso AO3 pubblico", "Public AO3 access");
  return label + ": " + value;
}
export function activeFilterEntries(params: URLSearchParams) {
  return Array.from(params)
    .filter(
      ([key, value]) =>
        value &&
        !["cursor", "sort", "direction", "tag", "entity"].includes(key) &&
        !(key === "availability" && value === "all"),
    )
    .flatMap(([key, value]) =>
      (tagKeys.includes(key) || key === "language"
        ? filterParts(value)
        : [value]
      ).map((v) => ({
        key,
        value: v,
      })),
    );
}
function filterDraft(params: URLSearchParams): Draft {
  return Object.fromEntries(
    Array.from(params).filter(
      ([key]) =>
        !["cursor", "sort", "direction", "q", "fulltext"].includes(key),
    ),
  );
}
const stable = (draft: Draft) =>
  JSON.stringify(
    Object.entries(draft)
      .filter(([k, v]) => v && !(k === "availability" && v === "all"))
      .sort(([a], [b]) => a.localeCompare(b)),
  );

function TagPicker({
  draft,
  change,
  facets,
}: {
  draft: Draft;
  change: (patch: Draft) => void;
  facets: Facets;
}) {
  const t = useText();
  const [tagError, setTagError] = useState("");
  const [kind, setKind] = useState<(typeof tagKinds)[number]>("fandom");
  const [mode, setMode] = useState<"include" | "exclude">(
    draft.exclude && !tagKeys.some((k) => k !== "exclude" && draft[k])
      ? "exclude"
      : "include",
  );
  const field = mode === "exclude" ? "exclude" : kind;
  const selected = filterParts(draft[field] ?? "");
  const add = (value: string) => {
    value = value.trim();
    if (!value) return;
    const patch = selectFilterValue(draft, field, value);
    if (patch[field].length > (field === "exclude" ? 3000 : 500)) {
      setTagError(
        t(
          "Limite del filtro raggiunto. Rimuovi un tag prima di aggiungerne altri.",
          "Filter limit reached. Remove a tag before adding another.",
        ),
      );
      return;
    }
    setTagError("");
    change(patch);
  };
  const picked = tagKeys.flatMap((key) =>
    filterParts(draft[key] ?? "").map((value) => ({ key, value })),
  );
  return (
    <div className="tag-picker">
      <div
        className="filter-mode"
        role="group"
        aria-label={t("Azione sul tag", "Tag action")}
      >
        <button
          type="button"
          aria-pressed={mode === "include"}
          onClick={() => {
            setMode("include");
          }}
        >
          + {t("Includi", "Include")}
        </button>
        <button
          type="button"
          aria-pressed={mode === "exclude"}
          data-exclude
          onClick={() => {
            setMode("exclude");
          }}
        >
          − {t("Escludi", "Exclude")}
        </button>
      </div>
      <label>
        {t("Tipo di tag", "Tag type")}
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
          }}
        >
          {tagKinds.map((k) => (
            <option key={k} value={k}>
              {t(...names[k])}
            </option>
          ))}
        </select>
      </label>
      <FilterCombobox
        key={kind + mode}
        kind={kind}
        label={
          mode === "exclude"
            ? t("Tag da escludere", "Tag to exclude")
            : t("Tag da includere", "Tag to include")
        }
        selected={selected}
        onSelect={add}
        facets={facets[kind]}
        exclude={mode === "exclude"}
      />
      {tagError && (
        <small role="alert" className="filter-error">
          {tagError}
        </small>
      )}
      {picked.length > 0 && (
        <ul
          className="selected-tags"
          aria-label={t("Tag selezionati", "Selected tags")}
        >
          {picked.map(({ key, value }) => (
            <li key={key + value} data-excluded={key === "exclude"}>
              <span>
                <small>
                  {key === "exclude"
                    ? t("Escludi", "Exclude")
                    : t("Includi", "Include")}
                </small>
                {value}
              </span>
              <button
                type="button"
                aria-label={t("Rimuovi ", "Remove ") + value}
                onClick={() =>
                  change({
                    [key]: filterParts(draft[key])
                      .filter((v) => v !== value)
                      .join("\n"),
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <small className="filter-hint">
        {mode === "include"
          ? t(
              "Le opere devono contenere tutti i tag inclusi.",
              "Works must contain every included tag.",
            )
          : t(
              "Le opere con questi tag saranno escluse.",
              "Works with these tags will be excluded.",
            )}
      </small>
    </div>
  );
}

function NumberRange({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useText();
  const match = value
    .replaceAll(",", "")
    .match(/^(>=|<=|=)?\s*(\d+)(?:\s*-\s*(\d+))?$/);
  const low = match ? (match[1] === "<=" ? "" : match[2]) : "",
    high = match ? (match[1] === ">=" ? "" : (match[3] ?? match[2])) : "";
  const [advanced, setAdvanced] = useState(!!value && !match);
  return (
    <fieldset className="number-filter">
      <legend>{label}</legend>
      {advanced ? (
        <label>
          {t("Espressione AO3", "AO3 expression")}
          <InputControl
            aria-label={label + " · " + t("Espressione AO3", "AO3 expression")}
            value={value}
            maxLength={100}
            onChange={(e) => onChange(e.target.value)}
            placeholder=">1000"
          />
        </label>
      ) : (
        <div className="filter-range">
          <label>
            {t("Minimo", "Minimum")}
            <InputControl
              aria-label={label + " · " + t("Minimo", "Minimum")}
              type="number"
              inputMode="numeric"
              min="0"
              max={high || Number.MAX_SAFE_INTEGER}
              step="1"
              value={low}
              onChange={(e) =>
                onChange(
                  e.target.value
                    ? high
                      ? e.target.value + "-" + high
                      : ">=" + e.target.value
                    : high
                      ? "<=" + high
                      : "",
                )
              }
            />
          </label>
          <span aria-hidden="true">–</span>
          <label>
            {t("Massimo", "Maximum")}
            <InputControl
              aria-label={label + " · " + t("Massimo", "Maximum")}
              type="number"
              inputMode="numeric"
              min={low || 0}
              max={Number.MAX_SAFE_INTEGER}
              step="1"
              value={high}
              onChange={(e) =>
                onChange(
                  e.target.value
                    ? low
                      ? low + "-" + e.target.value
                      : "<=" + e.target.value
                    : low
                      ? ">=" + low
                      : "",
                )
              }
            />
          </label>
        </div>
      )}
      {(!value || !!match) && (
        <button
          className="text-button range-mode"
          type="button"
          onClick={() => setAdvanced(!advanced)}
        >
          {advanced
            ? t("Intervallo guidato", "Range controls")
            : t("Sintassi AO3", "AO3 syntax")}
        </button>
      )}
    </fieldset>
  );
}

function FilterGroup({
  initialOpen = false,
  children,
}: {
  initialOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <details
      className="filter-group"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      {children}
    </details>
  );
}

export function CatalogFilters({
  params,
  facets,
  busy,
  onReset,
}: {
  params: URLSearchParams;
  facets: Facets;
  busy: boolean;
  onReset: () => void;
}) {
  const t = useText();
  const [draft, setDraft] = useState<Draft>(() => filterDraft(params));
  const change = (patch: Draft) => setDraft((d) => ({ ...d, ...patch }));
  const [languageError, setLanguageError] = useState("");
  const languages = filterParts(draft.language ?? "");
  const dirty = stable(draft) !== stable(filterDraft(params));
  const count = (keys: string[]) =>
    keys.reduce(
      (n, k) =>
        n +
        (draft[k] && !(k === "availability" && draft[k] === "all")
          ? tagKeys.includes(k) || k === "language"
            ? filterParts(draft[k]).length
            : 1
          : 0),
      0,
    );
  const field = (name: string, label: string, type = "text") => (
    <label key={name}>
      {label}
      <InputControl
        type={type}
        value={draft[name] ?? ""}
        onChange={(e) => change({ [name]: e.target.value })}
        maxLength={500}
      />
    </label>
  );
  const select = (name: string, label: string, options: [string, string][]) => (
    <label>
      {label}
      <select
        value={
          (name === "availability" && draft[name] === "all"
            ? ""
            : draft[name]) ?? ""
        }
        onChange={(e) => change({ [name]: e.target.value })}
      >
        {options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
  const badge = (keys: string[]) =>
    count(keys) > 0 ? (
      <span className="filter-count">{count(keys)}</span>
    ) : null;
  return (
    <>
      {Object.entries(draft).map(([key, value]) => (
        <input type="hidden" key={key} name={key} value={value} />
      ))}
      <FilterGroup initialOpen>
        <summary>
          {t("Tag e fandom", "Tags and fandoms")}
          {badge(tagKeys)}
        </summary>
        <TagPicker draft={draft} change={change} facets={facets} />
      </FilterGroup>
      <FilterGroup
        initialOpen={
          count(["complete", "language", "crossover", "singleChapter"]) > 0
        }
      >
        <summary>
          {t("Stato e lingua", "Status and language")}
          {badge(["complete", "language", "crossover", "singleChapter"])}
        </summary>
        {select("complete", t("Stato dell’opera", "Work status"), [
          ["", t("Tutte le opere", "All works")],
          ["true", t("Solo complete", "Complete only")],
          ["false", t("Solo in corso", "In progress only")],
        ])}
        <FilterCombobox
          kind="language"
          label={t("Lingua", "Language")}
          selected={languages}
          onSelect={(language) => {
            const patch = selectFilterValue(draft, "language", language);
            if (patch.language.length > 3000) {
              setLanguageError(
                t(
                  "Limite del filtro raggiunto. Rimuovi una lingua prima di aggiungerne altre.",
                  "Filter limit reached. Remove a language before adding another.",
                ),
              );
              return;
            }
            setLanguageError("");
            change(patch);
          }}
          facets={facets.language}
          maxLength={100}
        />
        {languageError && (
          <small className="filter-error" role="alert">
            {languageError}
          </small>
        )}
        {languages.length > 0 && (
          <ul
            className="selected-tags"
            aria-label={t("Lingue selezionate", "Selected languages")}
          >
            {languages.map((language) => (
              <li key={language}>
                <span>{language}</span>
                <button
                  type="button"
                  aria-label={
                    t("Rimuovi lingua: ", "Remove language: ") + language
                  }
                  onClick={() => {
                    setLanguageError("");
                    change({
                      language: languages
                        .filter((v) => v !== language)
                        .join("\n"),
                    });
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {languages.length > 1 && (
          <small>
            {t(
              "Una qualsiasi delle lingue selezionate.",
              "Any of the selected languages.",
            )}
          </small>
        )}
        {select("crossover", "Crossover", [
          ["", t("Tutte le opere", "All works")],
          ["false", t("Escludi crossover", "Exclude crossovers")],
          ["true", t("Solo crossover", "Crossovers only")],
        ])}
        <label>
          <input
            type="checkbox"
            checked={draft.singleChapter === "true"}
            onChange={(e) =>
              change({ singleChapter: e.target.checked ? "true" : "" })
            }
          />
          {t("Un solo capitolo", "Single chapter")}
        </label>
      </FilterGroup>
      <FilterGroup initialOpen={count(["words", "wordsFrom", "wordsTo"]) > 0}>
        <summary>
          {t("Lunghezza", "Length")}
          {badge(["words", "wordsFrom", "wordsTo"])}
        </summary>
        <NumberRange
          label={t("Parole", "Words")}
          value={
            draft.words ||
            (draft.wordsFrom && draft.wordsTo
              ? draft.wordsFrom + "-" + draft.wordsTo
              : draft.wordsFrom
                ? ">=" + draft.wordsFrom
                : draft.wordsTo
                  ? "<=" + draft.wordsTo
                  : "")
          }
          onChange={(words) => change({ words, wordsFrom: "", wordsTo: "" })}
        />
        <div className="range-presets">
          {[
            ["<=5000", "≤ 5.000"],
            ["5000-20000", "5.000–20.000"],
            [">=20000", "≥ 20.000"],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={draft.words === value}
              onClick={() =>
                change({ words: value, wordsFrom: "", wordsTo: "" })
              }
            >
              {label}
            </button>
          ))}
        </div>
        {draft.words && (draft.wordsFrom || draft.wordsTo) && (
          <div className="legacy-range">
            <small>
              {t("Intervallo attivo: ", "Active range: ") +
                (draft.wordsFrom || "0") +
                "–" +
                (draft.wordsTo || "∞")}
            </small>
            <button
              type="button"
              className="text-button"
              onClick={() => change({ wordsFrom: "", wordsTo: "" })}
            >
              {t("Rimuovi intervallo", "Remove range")}
            </button>
          </div>
        )}
      </FilterGroup>
      <FilterGroup
        initialOpen={
          count([
            "dateFrom",
            "dateTo",
            "updatedWithin",
            "hits",
            "kudos",
            "comments",
            "bookmarks",
          ]) > 0
        }
      >
        <summary>
          {t("Date e statistiche", "Dates and statistics")}
          {badge([
            "dateFrom",
            "dateTo",
            "updatedWithin",
            "hits",
            "kudos",
            "comments",
            "bookmarks",
          ])}
        </summary>
        <label>
          {t("Aggiornata dal", "Updated from")}
          <InputControl
            type="date"
            value={draft.dateFrom ?? ""}
            max={draft.dateTo || undefined}
            onChange={(e) => change({ dateFrom: e.target.value })}
          />
        </label>
        <label>
          {t("Fino al", "Until")}
          <InputControl
            type="date"
            value={draft.dateTo ?? ""}
            min={draft.dateFrom || undefined}
            onChange={(e) => change({ dateTo: e.target.value })}
          />
        </label>
        {["kudos", "hits", "comments", "bookmarks"].map((key) => (
          <NumberRange
            key={key}
            label={t(...names[key])}
            value={draft[key] ?? ""}
            onChange={(v) => change({ [key]: v })}
          />
        ))}
        {field(
          "updatedWithin",
          t("Periodo relativo AO3", "AO3 relative period"),
        )}
        <small className="filter-hint">
          {t("Esempio: < 2 weeks", "Example: < 2 weeks")}
        </small>
      </FilterGroup>
      <FilterGroup
        initialOpen={
          count(["title", "creators", "availability", "restricted"]) > 0
        }
      >
        <summary>
          {t("Altri criteri", "Other criteria")}
          {badge(["title", "creators", "availability", "restricted"])}
        </summary>
        {field("title", t("Titolo", "Title"))}
        {field("creators", t("Autore", "Author"))}
        {select("availability", t("Disponibilità", "Availability"), [
          ["", t("Tutte le opere", "All works")],
          ["deleted", t("Eliminate da AO3", "Deleted from AO3")],
        ])}
        {select("restricted", t("Accesso su AO3", "Access on AO3"), [
          ["", t("Tutte le opere", "All works")],
          ["true", t("Riservato agli iscritti", "Registered users only")],
          ["false", t("Pubblico", "Public")],
        ])}
      </FilterGroup>
      <details className="search-help">
        <summary>{t("Sintassi di ricerca", "Search syntax")}</summary>
        <p>
          <code>title:"sea voyage" AND creators:Alex</code>
          <br />
          <code>"exact phrase" OR dragon*</code>
        </p>
        <p>
          {t(
            "AND, OR, NOT, parentesi, frasi tra virgolette, * e ?.",
            "AND, OR, NOT, parentheses, quoted phrases, * and ?.",
          )}
        </p>
      </details>
      <div className="filter-apply" data-pending={dirty}>
        <small role="status">
          {dirty
            ? t("Modifiche da applicare", "Unapplied changes")
            : t("Filtri aggiornati", "Filters up to date")}
        </small>
        <div className="filter-actions">
          <Button tone="primary" type="submit" disabled={busy}>
            {t("Applica filtri", "Apply filters")}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setDraft(
                Object.fromEntries(
                  Array.from(params).filter(([key]) =>
                    ["entity", "tag"].includes(key),
                  ),
                ),
              );
              onReset();
            }}
          >
            {t("Azzera", "Clear")}
          </Button>
        </div>
      </div>
    </>
  );
}
