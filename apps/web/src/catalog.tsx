import {
  CatalogFilters,
  activeFilterEntries,
  filterCaption,
  filterParts,
} from "./catalog-filters";
import type { Input } from "@palimora/contracts";
import { useState, useEffect, useRef, useContext } from "react";
import {
  Link,
  NavLink,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { Input as InputControl, Button, Notice, Modal } from "@palimora/ui";
import { call, ApiFailure } from "./api";
import { Loading, QueryError, useText, errorText, Auth } from "./shared";
import "./catalog.css";
const values = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .filter((v) => typeof v === "string" || typeof v === "number")
    .map(String);
const labels: Record<string, [string, string]> = {
  creators: ["Autori", "Authors"],
  author: ["Autore", "Author"],
  pseud: ["Pseudonimo", "Pseud"],
  pseuds: ["Pseudonimi", "Pseuds"],
  fandom: ["Fandom", "Fandom"],
  rating: ["Rating", "Rating"],
  warnings: ["Avvertenze", "Archive warnings"],
  category: ["Categoria", "Category"],
  relationships: ["Relazioni", "Relationships"],
  characters: ["Personaggi", "Characters"],
  freeform: ["Altri tag", "Additional tags"],
  unclassified: ["Tag sorgente", "Source tags"],
  media: ["Media", "Media"],
  language: ["Lingua", "Language"],
  series: ["Serie", "Series"],
  collection: ["Collezione AO3", "AO3 collection"],
  collections: ["Collezioni AO3", "AO3 collections"],
  words: ["Parole", "Words"],
  kudos: ["Kudos", "Kudos"],
  comments: ["Commenti", "Comments"],
  hits: ["Visite", "Hits"],
  bookmarks: ["Bookmark", "Bookmarks"],
  published: ["Pubblicazione", "Date posted"],
  updated: ["Aggiornamento", "Date updated"],
  chapter_count: ["Capitoli", "Chapters"],
  relevance: ["Rilevanza", "Best match"],
  archived: ["Archiviazione", "Date archived"],
};
const tagFields = [
  "rating",
  "warnings",
  "category",
  "fandom",
  "relationships",
  "characters",
  "freeform",
  "unclassified",
];
const pageLink = (kind: string, id: string) => `/bibliography/${kind}/${id}`;
function EntityLinks({ items }: { items: any[] }) {
  return (
    <>
      {items.map((e, i) => (
        <span key={e.id}>
          {i > 0 ? ", " : ""}
          <Link to={pageLink(e.kind, e.id)}>{e.name}</Link>
          {e.position !== undefined && <small> · {e.position}</small>}
        </span>
      ))}
    </>
  );
}
function authorEntities(b: any) {
  const entities = b.entities ?? [];
  return entities.filter(
    (e: any) =>
      e.kind === "pseud" ||
      (e.kind === "author" &&
        !entities.some(
          (p: any) =>
            p.kind === "pseud" &&
            (p.owner === e.id || p.owner_id === e.source_id),
        )),
  );
}
function Metadata({
  m,
  b = {},
}: {
  m: Record<string, any>;
  b?: Record<string, any>;
}) {
  const t = useText();
  const tags = (b.tags ?? []) as any[];
  return (
    <>
      <dl className="work-metadata">
        {tagFields.map(
          (f) =>
            values(m[f]).length > 0 && (
              <div key={f}>
                <dt>{t(...labels[f])}</dt>
                <dd>
                  {values(m[f]).map((v) => {
                    const tag = tags.find((g) => g.kind === f && g.name === v);
                    return (
                      <Link
                        key={v}
                        to={
                          tag
                            ? pageLink("tag", tag.id)
                            : "/works?" + new URLSearchParams({ [f]: v })
                        }
                      >
                        {v}
                      </Link>
                    );
                  })}
                </dd>
              </div>
            ),
        )}
        {["series", "collection"].map(
          (kind) =>
            b.entities?.some((e: any) => e.kind === kind) && (
              <div key={kind}>
                <dt>{t(...labels[kind])}</dt>
                <dd>
                  <EntityLinks
                    items={b.entities.filter((e: any) => e.kind === kind)}
                  />
                </dd>
              </div>
            ),
        )}
      </dl>
      <WorkStats m={m} />
      {m.availability === "deleted" && (
        <small>{t("Non più disponibile su AO3", "Unavailable from AO3")}</small>
      )}
    </>
  );
}
function WorkStats({ m }: { m: Record<string, any> }) {
  const t = useText();
  return (
    <dl className="work-stats">
      {[
        "published",
        "updated",
        "language",
        "words",
        "chapter_count",
        "kudos",
        "comments",
        "hits",
        "bookmarks",
      ].map(
        (f) =>
          m[f] !== undefined &&
          m[f] !== null &&
          values(m[f]).length > 0 && (
            <div key={f}>
              <dt>{t(...labels[f])}</dt>
              <dd>
                {f === "chapter_count"
                  ? `${m[f]}/${m.expected_chapters ?? "?"}`
                  : typeof m[f] === "number"
                    ? m[f].toLocaleString(t("it", "en"))
                    : values(m[f]).join(", ")}
              </dd>
            </div>
          ),
      )}
    </dl>
  );
}
function Icon({
  name,
}: {
  name:
    | "search"
    | "filter"
    | "download"
    | "type"
    | "expand"
    | "back"
    | "next"
    | "close"
    | "history";
}) {
  const paths = {
    search: "m21 21-5-5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15",
    filter: "M4 7h16M7 12h10M10 17h4",
    download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
    type: "M3 19 9 5l6 14M5 15h8M16 11h6m-3 0v8",
    expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
    back: "m14 6-6 6 6 6",
    next: "m10 6 6 6-6 6",
    close: "m6 6 12 12M6 18 18 6",
    history: "M3 11a9 9 0 1 1 2 7M3 4v7h7m2-5v6l4 2",
  };
  return (
    <svg
      className="catalog-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function WorkSummary({ text }: { text: string }) {
  const t = useText(),
    ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false),
    [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div className="blurb-summary">
      <p
        ref={ref}
        className={expanded ? "work-summary" : "work-summary clamped"}
      >
        {text}
      </p>
      {(truncated || expanded) && (
        <button
          className="text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? t("Riduci", "Show less")
            : t("Leggi il riassunto", "Read summary")}
        </button>
      )}
    </div>
  );
}
function Blurb({ work }: { work: any }) {
  const location = useLocation();
  const t = useText(),
    m = work.metadata,
    b = work.bibliography ?? {};
  const authors = authorEntities(b);
  const otherTags = tagFields
    .filter((f) => !["rating", "warnings", "fandom"].includes(f))
    .reduce((n, f) => n + values(m[f]).length, 0);
  return (
    <article className="work-blurb">
      <div className="blurb-heading">
        <h2>
          <Link
            to={"/works/" + work.id}
            state={{ catalogReturn: location.pathname + location.search }}
          >
            {values(m.title).join(" · ") ||
              t("Titolo non disponibile", "Title unavailable")}
          </Link>
        </h2>
        {typeof m.complete === "boolean" && (
          <span className="work-status">
            {m.complete
              ? t("Completa", "Complete")
              : t("In corso", "In progress")}
          </span>
        )}
      </div>
      <div className="byline">
        {authors.length ? (
          <EntityLinks items={authors} />
        ) : (
          values(m.creators).join(", ")
        )}
      </div>
      <div className="blurb-fandom">
        {values(m.fandom).map((v) => {
          const tag = b.tags?.find(
            (g: any) => g.kind === "fandom" && g.name === v,
          );
          return (
            <Link
              key={v}
              to={
                tag
                  ? pageLink("tag", tag.id)
                  : "/works?" + new URLSearchParams({ fandom: v })
              }
            >
              {v}
            </Link>
          );
        })}
      </div>
      <div className="blurb-warnings">
        {[...values(m.rating), ...values(m.warnings)].map((v) => (
          <span key={v}>{v}</span>
        ))}
      </div>
      {m.summary && <WorkSummary text={String(m.summary)} />}
      {(otherTags > 0 ||
        b.entities?.some((e: any) =>
          ["series", "collection"].includes(e.kind),
        )) && (
        <details className="blurb-tags">
          <summary>
            {t("Relazioni e tag", "Relationships and tags")}
            {otherTags > 0 && <span>{otherTags}</span>}
          </summary>
          <Metadata
            m={{
              ...m,
              rating: undefined,
              warnings: undefined,
              fandom: undefined,
              published: undefined,
              updated: undefined,
              language: undefined,
              words: undefined,
              chapter_count: undefined,
              kudos: undefined,
              comments: undefined,
              hits: undefined,
              bookmarks: undefined,
            }}
            b={b}
          />
        </details>
      )}
      <WorkStats m={m} />
      {m.availability === "deleted" && (
        <small>{t("Non più disponibile su AO3", "Unavailable from AO3")}</small>
      )}
    </article>
  );
}

function SearchFailure({
  error,
  retry,
  reset,
}: {
  error: unknown;
  retry: () => void;
  reset: () => void;
}) {
  const t = useText();
  return (
    <Notice error>
      {errorText(error, t)}{" "}
      <Button
        onClick={
          error instanceof ApiFailure && error.code === "SEARCH_CURSOR_EXPIRED"
            ? reset
            : retry
        }
      >
        {error instanceof ApiFailure && error.code === "SEARCH_CURSOR_EXPIRED"
          ? t("Ricomincia", "Start again")
          : t("Riprova", "Retry")}
      </Button>
    </Notice>
  );
}
function CatalogPagination({ next }: { next: string | null }) {
  const t = useText(),
    location = useLocation(),
    [params, setParams] = useSearchParams();
  if (!params.has("cursor") && !next) return null;
  const canGoBack = location.state?.resultsPage === location.pathname;
  return (
    <nav
      className="catalog-pagination"
      aria-label={t("Paginazione", "Pagination")}
    >
      {params.has("cursor") && (
        <Button
          onClick={() => {
            if (canGoBack) window.history.back();
            else {
              const p = new URLSearchParams(params);
              p.delete("cursor");
              setParams(p);
            }
            window.scrollTo(0, 0);
          }}
        >
          {canGoBack
            ? t("Precedenti", "Previous")
            : t("Prima pagina", "First page")}
        </Button>
      )}
      {next && (
        <Button
          onClick={() => {
            const p = new URLSearchParams(params);
            p.set("cursor", next);
            setParams(p, { state: { resultsPage: location.pathname } });
            window.scrollTo(0, 0);
          }}
        >
          {t("Successivi", "Next")}
        </Button>
      )}
    </nav>
  );
}
export function Catalog({
  scope = {},
  embedded = false,
  defaultSort,
}: {
  scope?: Record<string, string>;
  embedded?: boolean;
  defaultSort?: Input<"catalogWorks">["sort"];
}) {
  const t = useText(),
    [params, setParams] = useSearchParams();
  const input = {
    ...(defaultSort ? { sort: defaultSort } : {}),
    ...Object.fromEntries(params),
    ...scope,
  };
  const [filtersOpen, setFiltersOpen] = useState(
    () => !window.matchMedia("(max-width:900px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width:900px)");
    const update = () => setFiltersOpen(!media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const query = useQuery({
    queryKey: ["catalog", input],
    queryFn: () => call("catalogWorks", input),
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.indexing ? 2000 : false),
  });
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete("cursor");
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const removeFilter = (key: string, value: string) => {
    const form = document.getElementById(
      "catalog-search",
    ) as HTMLFormElement | null;
    const next = form
      ? new URLSearchParams(
          Array.from(new FormData(form)).map(([k, v]) => [k, String(v)]),
        )
      : new URLSearchParams(params);
    const remaining = filterParts(next.get(key) ?? "")
      .filter((v) => v !== value)
      .join("\n");
    if (remaining) next.set(key, remaining);
    else next.delete(key);
    next.delete("cursor");
    for (const [k, v] of next) if (!v.trim()) next.delete(k);
    setParams(next);
  };
  const resetFilters = () =>
    setParams(
      new URLSearchParams(
        Array.from(params).filter(([key]) =>
          ["q", "fulltext", "sort", "direction", "entity", "tag"].includes(key),
        ),
      ),
    );
  return (
    <section className="catalog">
      <div className="catalog-heading">
        {!embedded && (
          <div>
            <p className="eyebrow">{t("La biblioteca", "The library")}</p>
            <h1 tabIndex={-1}>{t("Opere", "Works")}</h1>
          </div>
        )}
        <div className="results-tools" key={"sort-" + params.toString()}>
          {query.data && (
            <div className="results-heading" role="status">
              <strong>
                {query.data.total.toLocaleString(t("it", "en"))}{" "}
                {query.data.total === 1
                  ? t("opera", "work")
                  : t("opere", "works")}
              </strong>
              {query.data.indexing && (
                <span role="status">
                  {t("Indicizzazione in corso", "Indexing in progress")}
                </span>
              )}
            </div>
          )}{" "}
          <label>
            {t("Ordina per", "Sort by")}
            <select
              name="sort"
              aria-label={t("Ordina per", "Sort by")}
              form="catalog-search"
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
              defaultValue={
                params.get("sort") ??
                defaultSort ??
                (params.get("q") || params.get("fulltext")
                  ? "relevance"
                  : "updated")
              }
            >
              {defaultSort === "series" && (
                <option value="series">
                  {t("Ordine della serie", "Series order")}
                </option>
              )}
              {[
                "relevance",
                "creators",
                "title",
                "published",
                "updated",
                "words",
                "hits",
                "kudos",
                "comments",
                "bookmarks",
                "archived",
              ].map((k) => (
                <option key={k} value={k}>
                  {k === "title" ? t("Titolo", "Title") : t(...labels[k])}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Direzione", "Direction")}
            <select
              name="direction"
              aria-label={t("Direzione", "Direction")}
              form="catalog-search"
              onChange={(e) => e.currentTarget.form?.requestSubmit()}
              defaultValue={params.get("direction") ?? "desc"}
            >
              <option value="desc">{t("Decrescente", "Descending")}</option>
              <option value="asc">{t("Crescente", "Ascending")}</option>
            </select>
          </label>
        </div>
      </div>
      <div className="catalog-searchbar" key={"search-" + params.toString()}>
        <label className="catalog-search-field">
          <Icon name="search" />
          <span className="sr-only">
            {t("Cerca nei metadati", "Search metadata")}
          </span>
          <InputControl
            type="search"
            name="q"
            form="catalog-search"
            defaultValue={params.get("q") ?? ""}
            placeholder={t("Titolo, autore o tag", "Title, author or tag")}
          />
        </label>
        <label className="catalog-search-field">
          <span className="search-field-label">
            {t("Nel testo", "In the text")}
          </span>
          <InputControl
            type="search"
            name="fulltext"
            form="catalog-search"
            defaultValue={params.get("fulltext") ?? ""}
            aria-label={t("Cerca nei capitoli", "Search chapters")}
            placeholder={t("Parole o frasi", "Words or phrases")}
          />
        </label>
        <Button type="submit" form="catalog-search" tone="primary">
          {t("Cerca", "Search")}
        </Button>
      </div>
      <div className="active-filters">
        {activeFilterEntries(params).map(({ key, value }) => (
          <button
            className="filter-chip"
            data-excluded={key === "exclude"}
            key={key + value}
            onClick={() => removeFilter(key, value)}
            aria-label={
              t("Rimuovi filtro: ", "Remove filter: ") +
              filterCaption(key, value, t)
            }
          >
            <span>{filterCaption(key, value, t)}</span>
            <Icon name="close" />
          </button>
        ))}
      </div>
      <div className="catalog-layout">
        <details
          className="filter-drawer"
          open={filtersOpen}
          onToggle={(e) => setFiltersOpen(e.currentTarget.open)}
        >
          <summary>
            <Icon name="filter" />
            {t("Filtri", "Filters")}
            {activeFilterEntries(params).filter(
              ({ key }) => !["q", "fulltext"].includes(key),
            ).length > 0 && (
              <span className="filter-count">
                {
                  activeFilterEntries(params).filter(
                    ({ key }) => !["q", "fulltext"].includes(key),
                  ).length
                }
              </span>
            )}
          </summary>
          <form
            className="catalog-filters"
            autoComplete="off"
            id="catalog-search"
            key={params.toString()}
            onInvalidCapture={(e) => {
              let node: HTMLElement | null = e.target as HTMLElement;
              while (node) {
                if (node instanceof HTMLDetailsElement) node.open = true;
                node = node.parentElement;
              }
            }}
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const p = new URLSearchParams();
              for (const [k, v] of form.entries())
                if (String(v).trim()) p.set(k, String(v).trim());
              setParams(p);
              if (window.matchMedia("(max-width:900px)").matches) {
                setFiltersOpen(false);
                requestAnimationFrame(() => {
                  const results =
                    document.querySelector<HTMLElement>(".catalog-results");
                  results?.focus({ preventScroll: true });
                  results?.scrollIntoView({ block: "start" });
                });
              }
            }}
          >
            <CatalogFilters
              params={params}
              facets={query.data?.facets ?? {}}
              busy={query.isFetching}
              onReset={resetFilters}
            />
          </form>
        </details>
        <div
          className="catalog-results"
          tabIndex={-1}
          aria-label={t("Risultati della ricerca", "Search results")}
        >
          {query.isPending ? (
            <Loading />
          ) : query.isError ? (
            <SearchFailure
              error={query.error}
              retry={() => void query.refetch()}
              reset={() => change("cursor", "")}
            />
          ) : (
            <>
              {query.data.items.map((w) => (
                <Blurb key={w.id} work={w} />
              ))}
              {!query.data.items.length && (
                <div className="catalog-empty">
                  <p>{t("Nessuna opera trovata.", "No works found.")}</p>
                  {activeFilterEntries(params).some(
                    ({ key }) => !["q", "fulltext"].includes(key),
                  ) && (
                    <Button onClick={resetFilters}>
                      {t("Azzera filtri", "Clear filters")}
                    </Button>
                  )}
                </div>
              )}
              <CatalogPagination next={query.data.next} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
export function Browse() {
  const { kind = "fandom" } = useParams(),
    t = useText(),
    [params, setParams] = useSearchParams();
  const q = useQuery({
    queryKey: ["browse", kind, params.toString()],
    queryFn: () =>
      call("catalogBrowse", {
        kind: kind as "fandom",
        q: params.get("q") ?? undefined,
        cursor: params.get("cursor") ?? undefined,
      }),
  });
  return (
    <section className="browse-page">
      <div className="catalog-heading">
        <div>
          <p className="eyebrow">
            {t("Esplora la biblioteca", "Explore the library")}
          </p>
          <h1 tabIndex={-1}>
            {kind === "language"
              ? t("Lingue", "Languages")
              : labels[kind]
                ? t(...labels[kind])
                : kind}
          </h1>
        </div>
      </div>
      <nav
        className="catalog-tabs"
        aria-label={t("Categorie della biblioteca", "Library categories")}
      >
        {[
          "fandom",
          "language",
          "media",
          "creators",
          "pseuds",
          "relationships",
          "characters",
          "freeform",
          "unclassified",
          "series",
          "collections",
        ].map((k) => (
          <NavLink key={k} to={"/browse/" + k}>
            {k === "language" ? t("Lingue", "Languages") : t(...labels[k])}
          </NavLink>
        ))}
      </nav>
      <form
        className="catalog-searchbar browse-search"
        autoComplete="off"
        key={kind + params.toString()}
        onSubmit={(e) => {
          e.preventDefault();
          setParams({
            q: String(new FormData(e.currentTarget).get("q") ?? ""),
          });
        }}
      >
        <label className="catalog-search-field">
          <Icon name="search" />
          <span className="sr-only">{t("Cerca", "Search")}</span>
          <InputControl
            type="search"
            name="q"
            maxLength={500}
            placeholder={t("Cerca per nome…", "Search by name…")}
            defaultValue={params.get("q") ?? ""}
          />
        </label>
        <Button type="submit" tone="primary">
          {t("Cerca", "Search")}
        </Button>
      </form>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <ul className="browse-list">
            {q.data.items.map((v) => (
              <li key={v.id}>
                <Link
                  to={
                    v.page_kind === "language"
                      ? "/works?" + new URLSearchParams({ language: v.name })
                      : pageLink(v.page_kind, v.id)
                  }
                >
                  <span>{v.name}</span>
                  <small>
                    {v.works.toLocaleString(t("it", "en"))}{" "}
                    {v.works === 1 ? t("opera", "work") : t("opere", "works")}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
          {!q.data.items.length && (
            <p>{t("Nessun risultato.", "No results.")}</p>
          )}
          <CatalogPagination next={q.data.next} />
        </>
      )}
    </section>
  );
}
export function BibliographyPage() {
  const { kind = "", id = "" } = useParams(),
    t = useText();
  const q = useQuery({
    queryKey: ["bibliography", kind, id],
    queryFn: () => call("bibliographyPage", { kind: kind as "tag", id }),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  const item = q.data.item as any,
    details = item.details ?? {};
  return (
    <section className="bibliography-page">
      <Link
        className="catalog-back"
        to={
          "/browse/" +
          (kind === "tag"
            ? item.kind
            : ((
                {
                  author: "creators",
                  pseud: "pseuds",
                  series: "series",
                  collection: "collections",
                } as Record<string, string>
              )[kind] ?? "fandom"))
        }
      >
        <Icon name="back" />
        {t("Esplora", "Browse")}
      </Link>
      <p className="eyebrow">
        {kind === "tag"
          ? labels[item.kind]
            ? t(...labels[item.kind])
            : item.kind
          : t(...labels[kind])}
      </p>
      <h1 tabIndex={-1}>{item.name}</h1>
      {item.canonical === true && (
        <small>{t("Tag canonico", "Canonical tag")}</small>
      )}
      {item.canonical === false && (
        <small>{t("Tag non canonico", "Non-canonical tag")}</small>
      )}
      {item.url && (
        <p>
          <a href={item.url} rel="noreferrer" target="_blank">
            AO3 ↗
          </a>
        </p>
      )}
      {details.description && (
        <div
          className="work-summary"
          dangerouslySetInnerHTML={{ __html: details.description }}
        />
      )}
      {["notes", "introduction", "faq", "rules"].map(
        (field) =>
          details[field] && (
            <details key={field}>
              <summary>
                {
                  (
                    {
                      notes: t("Note", "Notes"),
                      introduction: t("Introduzione", "Introduction"),
                      faq: "FAQ",
                      rules: t("Regole", "Rules"),
                    } as any
                  )[field]
                }
              </summary>
              <div
                className="work-summary"
                dangerouslySetInnerHTML={{ __html: details[field] }}
              />
            </details>
          ),
      )}
      <dl className="work-stats">
        {Object.entries(details.statistics ?? {}).map(([field, value]) => (
          <div key={field}>
            <dt>
              {field === "works" ? t("Opere", "Works") : t(...labels[field])}
            </dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
        {["created", "updated"].map(
          (f) =>
            details[f] && (
              <div key={f}>
                <dt>
                  {f === "created"
                    ? t("Creazione", "Created")
                    : t("Aggiornamento", "Updated")}
                </dt>
                <dd>{details[f]}</dd>
              </div>
            ),
        )}
        {["closed", "moderated", "anonymous", "unrevealed"].map(
          (flag) =>
            typeof details[flag] === "boolean" && (
              <div key={flag}>
                <dt>
                  {
                    (
                      {
                        closed: t("Chiusa", "Closed"),
                        moderated: t("Moderata", "Moderated"),
                        anonymous: t("Anonima", "Anonymous"),
                        unrevealed: t("Non rivelata", "Unrevealed"),
                      } as any
                    )[flag]
                  }
                </dt>
                <dd>{details[flag] ? t("Sì", "Yes") : t("No", "No")}</dd>
              </div>
            ),
        )}
        {typeof details.complete === "boolean" && (
          <div>
            <dt>{t("Stato", "Status")}</dt>
            <dd>
              {details.complete
                ? t("Completa", "Complete")
                : t("In corso", "In progress")}
            </dd>
          </div>
        )}
      </dl>
      {q.data.relations.length > 0 && (
        <ul className="bibliography-relations">
          {q.data.relations.map((r: any) => (
            <li
              key={r.id + String(r.relation ?? "") + String(r.direction ?? "")}
            >
              {r.relation && (
                <span>
                  {r.relation === "synonym"
                    ? r.direction === "parent"
                      ? t("Sinonimo di", "Synonym of")
                      : t("Sinonimo", "Synonym")
                    : r.relation === "meta"
                      ? r.direction === "parent"
                        ? "Metatag"
                        : t("Sottotag", "Subtag")
                      : r.direction === "parent"
                        ? t("Tag superiore", "Parent tag")
                        : t("Tag collegato", "Related tag")}
                  :{" "}
                </span>
              )}
              <Link to={pageLink(kind === "tag" ? "tag" : r.kind, r.id)}>
                {r.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Catalog
        scope={kind === "tag" ? { tag: id } : { entity: id }}
        embedded
        defaultSort={kind === "series" ? "series" : undefined}
      />
    </section>
  );
}
function CommentThread({
  id,
  snapshot,
  parent,
}: {
  id: string;
  snapshot?: string;
  parent?: string;
}) {
  const t = useText();
  const q = useInfiniteQuery({
    queryKey: ["comments", id, snapshot, parent],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("readerInteractions", { id, snapshot, parent, cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  return (
    <>
      <ol className="comment-thread">
        {q.data.pages
          .flatMap((p) => p.comments)
          .map((c: any) => (
            <Comment key={c.id} comment={c} id={id} snapshot={snapshot} />
          ))}
      </ol>
      {q.hasNextPage && (
        <Button
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {t("Altri commenti", "More comments")}
        </Button>
      )}
    </>
  );
}
function Comment({
  comment: c,
  id,
  snapshot,
}: {
  comment: any;
  id: string;
  snapshot?: string;
}) {
  const t = useText(),
    [open, setOpen] = useState(false);
  return (
    <li className="source-comment" id={"comment-" + c.id}>
      <div className="comment-byline">
        {c.author_url ? (
          <a href={c.author_url} rel="noreferrer" target="_blank">
            {c.author}
          </a>
        ) : (
          (c.author ??
          (c.guest
            ? t("Ospite", "Guest")
            : t("Autore non disponibile", "Author unavailable")))
        )}
        {c.posted_at && <time dateTime={c.posted_at}>{c.posted_at}</time>}
      </div>
      {c.deleted ? (
        <p>{t("Commento eliminato su AO3", "Comment deleted on AO3")}</p>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: c.html }} />
      )}
      {c.children > 0 && (
        <Button onClick={() => setOpen(!open)} aria-expanded={open}>
          {c.children} {t("risposte", "replies")}
        </Button>
      )}
      {open && <CommentThread id={id} snapshot={snapshot} parent={c.id} />}
    </li>
  );
}
function Interactions({ id, snapshot }: { id: string; snapshot?: string }) {
  const t = useText(),
    q = useInfiniteQuery({
      queryKey: ["interactions", id, snapshot],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) =>
        call("readerInteractions", { id, snapshot, kudosCursor: pageParam }),
      getNextPageParam: (p) => p.nextKudos ?? undefined,
    });
  if (q.isPending) return null;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  const data = q.data.pages[0];
  return (
    <section className="source-interactions">
      {data.kudos && (
        <>
          <h2>Kudos</h2>
          {data.kudosCoverage !== "complete" && (
            <small>
              {t("Elenco acquisito parzialmente", "Partially acquired list")}
            </small>
          )}
          <p>
            {q.data.pages
              .flatMap((p) => (p.kudos?.users ?? []) as any[])
              .map((u: any, i) => (
                <span key={i}>
                  {i ? ", " : ""}
                  {u.url ? (
                    <a href={u.url} rel="noreferrer" target="_blank">
                      {u.name}
                    </a>
                  ) : (
                    u.name
                  )}
                </span>
              ))}
            {data.kudos.guests !== undefined && data.kudos.guests !== null && (
              <>
                {" "}
                · {String(data.kudos.guests)} {t("ospiti", "guests")}
              </>
            )}
          </p>
          {q.hasNextPage && (
            <Button onClick={() => void q.fetchNextPage()}>
              {t("Altri kudos", "More kudos")}
            </Button>
          )}
        </>
      )}
      {data.available && (
        <>
          <h2>{t("Commenti AO3", "AO3 comments")}</h2>
          {data.commentsCoverage !== "complete" && (
            <small>
              {t(
                "Copertura dei commenti parziale o sconosciuta",
                "Partial or unknown comment coverage",
              )}
            </small>
          )}
          <CommentThread id={id} snapshot={snapshot} />
        </>
      )}
      {!!data.statistics?.observed_at && (
        <small>
          {t("Statistiche osservate il ", "Statistics observed on ") +
            String(data.statistics.observed_at)}
        </small>
      )}
    </section>
  );
}
function ReaderFrame({
  document,
  immersive,
  onExit,
}: {
  document: string;
  immersive: boolean;
  onExit: () => void;
}) {
  const t = useText();
  const frame = useRef<HTMLIFrameElement>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const resize = () => {
    observer.current?.disconnect();
    const el = frame.current,
      body = el?.contentDocument?.body;
    if (!el || !body) return;
    body.ownerDocument.onkeydown = (e) => {
      if (e.key === "Escape" && immersive) onExit();
    };
    if (immersive) {
      el.style.height = "";
      return;
    }
    const measure = () => {
      el.style.height =
        Math.ceil(body.getBoundingClientRect().height) + 2 + "px";
    };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(body);
  };
  useEffect(() => {
    resize();
    return () => observer.current?.disconnect();
  }, [immersive]);
  return (
    <iframe
      ref={frame}
      className="reader-frame"
      title={t("Testo dell’opera", "Work text")}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={document}
      onLoad={resize}
    />
  );
}
export function Reader() {
  const location = useLocation();
  const backTo =
    typeof location.state?.catalogReturn === "string" &&
    /^\/(?:works(?:\?|$)|bibliography\/)/.test(location.state.catalogReturn)
      ? location.state.catalogReturn
      : "/works";
  const { id = "" } = useParams(),
    t = useText(),
    [params, setParams] = useSearchParams();
  const { user } = useContext(Auth);
  const [immersive, setImmersive] = useState(false);
  const readerRoot = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!immersive || !readerRoot.current) return;
    const outside: { element: HTMLElement; inert: boolean }[] = [];
    let node: HTMLElement | null = readerRoot.current;
    while (node?.parentElement) {
      for (const sibling of node.parentElement.children)
        if (sibling !== node && sibling instanceof HTMLElement) {
          outside.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      node = node.parentElement;
      if (node === document.body) break;
    }
    readerRoot.current
      ?.querySelector<HTMLButtonElement>("[data-focus-toggle]")
      ?.focus({ preventScroll: true });
    return () => {
      for (const { element, inert } of outside) element.inert = inert;
      readerRoot.current
        ?.querySelector<HTMLButtonElement>("[data-focus-toggle]")
        ?.focus({ preventScroll: true });
    };
  }, [immersive]);
  const [panel, setPanel] = useState<
    "appearance" | "versions" | "download" | null
  >(null);
  const [format, setFormat] = useState("epub"),
    [downloading, setDownloading] = useState(false),
    [downloadError, setDownloadError] = useState("");
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!immersive) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !panel) setImmersive(false);
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener("keydown", key);
    };
  }, [immersive, panel]);
  useEffect(() => {
    setImmersive(false);
    setPanel(null);
  }, [id]);
  const snapshot = params.get("snapshot") ?? undefined,
    chapter = params.get("chapter") ?? undefined;
  const skin = params.get("skin") === "on" ? "on" : "off";
  const siteDark =
    user.preferences.theme === "dark" ||
    (user.preferences.theme === "auto" && systemDark);
  const theme =
    params.get("theme") === "dark"
      ? "dark"
      : params.get("theme") === "light"
        ? "light"
        : siteDark
          ? "dark"
          : "light";
  const font = params.get("font") === "sans" ? "sans" : "serif";
  const rawSize = Number(params.get("size") ?? 19),
    size = Number.isFinite(rawSize) ? Math.max(14, Math.min(28, rawSize)) : 19;
  const work = useQuery({
    queryKey: ["reader", id, snapshot],
    queryFn: () => call("readerWork", { id, snapshot }),
  });
  useEffect(() => {
    if (!id || !work.isSuccess) return;
    let recorded = false;
    const opened = () => {
      if (recorded || document.visibilityState !== "visible") return;
      recorded = true;
      void call("readerOpen", { id }).catch(() => {});
    };
    opened();
    document.addEventListener("visibilitychange", opened);
    return () => document.removeEventListener("visibilitychange", opened);
  }, [id, work.isSuccess]);

  const versions = useInfiniteQuery({
    queryKey: ["versions", id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => call("readerWork", { id, cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
    enabled: panel === "versions",
  });
  const content = useQuery({
    queryKey: ["content", id, snapshot, chapter, skin, theme, font, size],
    queryFn: () =>
      call("readerContent", { id, snapshot, chapter, skin, theme, font, size }),
    enabled: !!work.data?.manifest,
    placeholderData: (previous, query) =>
      query?.queryKey[1] === id &&
      query.queryKey[2] === snapshot &&
      query.queryKey[3] === chapter
        ? previous
        : undefined,
  });
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "snapshot") next.delete("chapter");
    setParams(next, {
      replace: ["skin", "theme", "font", "size"].includes(key),
      state: location.state,
    });
  };
  const chapterChange = (value: string) => {
    update("chapter", value);
    document
      .getElementById("reading-start")
      ?.scrollIntoView({ block: "start" });
  };
  if (work.isPending) return <Loading />;
  if (work.isError) return <QueryError retry={() => void work.refetch()} />;
  const m = work.data.metadata as any,
    b = work.data.bibliography as any;
  const chapters = ((work.data.manifest?.chapters ?? []) as any[]).filter(
    (c) => c.scope !== "entire_work",
  );
  const pos = chapters.findIndex((c) => c.chapter_id === chapter);
  const title =
    values(m.title).join(" · ") ||
    t("Titolo non disponibile", "Title unavailable");
  const selectedVersion = work.data.versions.find((v) => v.id === snapshot);
  const download = async () => {
    setDownloading(true);
    setDownloadError("");
    try {
      const query = new URLSearchParams({
        format,
        ...(work.data.snapshot ? { snapshot: work.data.snapshot } : {}),
      });
      const response = await fetch(`/api/v1/works/${id}/download?${query}`, {
        credentials: "same-origin",
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new ApiFailure(error.code ?? "INTERNAL_ERROR");
      }
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download =
        title.replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 120) + "." + format;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setPanel((current) => (current === "download" ? null : current));
    } catch (e) {
      setDownloadError(errorText(e, t));
    } finally {
      setDownloading(false);
    }
  };
  const chapterNav = (
    <>
      {pos > 0 && (
        <Button
          onClick={() => chapterChange(chapters[pos - 1].chapter_id)}
          aria-label={t("Capitolo precedente", "Previous chapter")}
        >
          <Icon name="back" />
          <span>{t("Precedente", "Previous")}</span>
        </Button>
      )}
      {pos >= 0 && pos < chapters.length - 1 && (
        <Button
          onClick={() => chapterChange(chapters[pos + 1].chapter_id)}
          aria-label={t("Capitolo successivo", "Next chapter")}
        >
          <span>{t("Successivo", "Next")}</span>
          <Icon name="next" />
        </Button>
      )}
    </>
  );
  return (
    <section
      ref={readerRoot}
      className={immersive ? "reader immersive" : "reader"}
      data-reading-theme={theme}
    >
      {!immersive && (
        <div className="reader-breadcrumb">
          <Link to={backTo}>
            <Icon name="back" />
            {backTo !== "/works"
              ? t("Torna ai risultati", "Back to results")
              : t("Opere", "Works")}
          </Link>
          <div className="reader-secondary-actions">
            {work.data.work.external_id && (
              <a
                href={
                  "https://archiveofourown.org/works/" +
                  work.data.work.external_id
                }
                target="_blank"
                rel="noreferrer"
              >
                AO3 ↗
              </a>
            )}
            <button
              className="text-button"
              onClick={() => setPanel("versions")}
            >
              <Icon name="history" />
              {snapshot
                ? t("Versione storica", "Historical version")
                : t("Versioni", "Versions")}
            </button>
            {!!work.data.manifest && (
              <button
                className="text-button"
                onClick={() => {
                  setDownloadError("");
                  setPanel("download");
                }}
              >
                <Icon name="download" />
                {t("Scarica opera", "Download work")}
              </button>
            )}
          </div>
        </div>
      )}
      <div className="reader-heading">
        {snapshot && !immersive && (
          <p className="version-indicator">
            {t("Versione storica", "Historical version")}
            {selectedVersion &&
              " · " +
                new Date(selectedVersion.imported_at).toLocaleDateString(
                  t("it", "en"),
                )}{" "}
            <button
              className="text-button"
              onClick={() => update("snapshot", "")}
            >
              {t("Torna alla corrente", "Return to current")}
            </button>
          </p>
        )}
        <h1 tabIndex={-1}>{title}</h1>
        {!immersive && (
          <>
            <div className="byline">
              {authorEntities(b).length ? (
                <EntityLinks items={authorEntities(b)} />
              ) : (
                values(m.creators).join(", ")
              )}
            </div>
            <WorkStats m={m} />
            {m.summary && <p className="work-summary">{m.summary}</p>}
            <details className="reader-metadata">
              <summary>
                {t("Dettagli dell’opera e tag", "Work details and tags")}
              </summary>
              <Metadata
                m={{
                  ...m,
                  published: undefined,
                  updated: undefined,
                  language: undefined,
                  words: undefined,
                  chapter_count: undefined,
                  kudos: undefined,
                  comments: undefined,
                  hits: undefined,
                  bookmarks: undefined,
                }}
                b={b}
              />
              {b.relations?.length > 0 && (
                <ul className="bibliography-relations">
                  {b.relations.map((r: any) => (
                    <li key={r.type + r.work_id}>
                      {
                        (
                          {
                            inspired_by: t("Ispirata a", "Inspired by"),
                            inspiration: t("Ha ispirato", "Inspired"),
                            translation_of: t(
                              "Traduzione di",
                              "Translation of",
                            ),
                            translation: t("Traduzione", "Translation"),
                            related: t("Opera correlata", "Related work"),
                          } as any
                        )[r.type]
                      }
                      :{" "}
                      <a
                        href={
                          r.local_id
                            ? "/works/" + r.local_id
                            : "https://archiveofourown.org/works/" + r.work_id
                        }
                      >
                        {r.label ?? r.work_id}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </>
        )}
      </div>
      {!!work.data.manifest && (
        <div className="reader-toolbar" id="reading-start">
          <label className="chapter-picker">
            <span className="sr-only">{t("Capitolo", "Chapter")}</span>
            <select
              value={chapter ?? ""}
              onChange={(e) => chapterChange(e.target.value)}
            >
              <option value="">Entire Work</option>
              {chapters.map((c, i) => (
                <option key={c.chapter_id} value={c.chapter_id}>
                  {i + 1}
                  {c.title ? ". " + c.title : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="reader-tools">
            <Button onClick={() => setPanel("appearance")}>
              <Icon name="type" />
              {t("Aspetto", "Appearance")}
            </Button>
            <Button
              data-focus-toggle
              onClick={() => setImmersive(!immersive)}
              aria-label={
                immersive
                  ? t("Esci dalla lettura immersiva", "Exit immersive mode")
                  : t("Lettura immersiva", "Immersive mode")
              }
            >
              <Icon name={immersive ? "close" : "expand"} />
              <span>
                {immersive ? t("Esci", "Exit") : t("Concentrazione", "Focus")}
              </span>
            </Button>
          </div>
        </div>
      )}
      <div className="reader-paper" aria-busy={content.isFetching}>
        {!work.data.manifest ? (
          <p className="reader-empty">
            {t("Testo non acquisito.", "Text not acquired.")}
          </p>
        ) : content.isPending ? (
          <Loading />
        ) : content.isError ? (
          <QueryError retry={() => void content.refetch()} />
        ) : (
          <ReaderFrame
            document={content.data.document}
            immersive={immersive}
            onExit={() => setImmersive(false)}
          />
        )}
      </div>
      <div className="reader-chapter-nav">{chapterNav}</div>
      {!immersive && work.data.manifest && (
        <Interactions id={id} snapshot={work.data.snapshot ?? undefined} />
      )}
      <Modal
        open={panel === "appearance"}
        onClose={() => setPanel(null)}
        title={t("Aspetto del lettore", "Reader appearance")}
        closeLabel={t("Chiudi", "Close")}
      >
        <div className="appearance-settings">
          <fieldset>
            <legend>{t("Tema", "Theme")}</legend>
            <div className="appearance-options">
              {["light", "dark"].map((v) => (
                <button
                  key={v}
                  className={"theme-option " + v}
                  aria-pressed={theme === v}
                  onClick={() => update("theme", v)}
                >
                  <span aria-hidden="true">Aa</span>
                  {v === "dark" ? t("Scuro", "Dark") : t("Chiaro", "Light")}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Font</legend>
            <div className="appearance-options">
              {["serif", "sans"].map((v) => (
                <button
                  key={v}
                  className={"font-option " + v}
                  aria-pressed={font === v}
                  onClick={() => update("font", v)}
                >
                  {v === "serif" ? "Serif" : "Sans serif"}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="size-control">
            {t("Dimensione testo", "Text size")}
            <output>{size} px</output>
            <input
              type="range"
              min="14"
              max="28"
              value={size}
              onChange={(e) => update("size", e.target.value)}
            />
          </label>
          <label className="skin-control">
            <span>
              Work Skin
              <small>
                {t("Stile originale dell’opera", "Original work styling")}
              </small>
            </span>
            <input
              type="checkbox"
              checked={skin === "on"}
              onChange={(e) => update("skin", e.target.checked ? "on" : "off")}
            />
          </label>
        </div>
      </Modal>
      <Modal
        open={panel === "versions"}
        onClose={() => setPanel(null)}
        title={t("Versioni dell’opera", "Work versions")}
        closeLabel={t("Chiudi", "Close")}
      >
        <label className="field">
          {t("Versione", "Version")}
          <select
            value={snapshot ?? ""}
            onChange={(e) => {
              update("snapshot", e.target.value);
              setPanel(null);
            }}
          >
            <option value="">{t("Corrente", "Current")}</option>
            {snapshot &&
              !(
                versions.data?.pages.flatMap((p) => p.versions) ??
                work.data.versions
              ).some((v) => v.id === snapshot) && (
                <option value={snapshot}>
                  {t(
                    "Versione storica selezionata",
                    "Selected historical version",
                  )}
                </option>
              )}
            {(
              versions.data?.pages.flatMap((p) => p.versions) ??
              work.data.versions
            ).map((v) => (
              <option key={v.id} value={v.id}>
                {t("Acquisita: ", "Acquired: ") +
                  new Date(v.imported_at).toLocaleString(t("it", "en"))}
              </option>
            ))}
          </select>
        </label>
        {versions.isError && (
          <QueryError retry={() => void versions.refetch()} />
        )}
        {versions.hasNextPage && (
          <Button
            disabled={versions.isFetchingNextPage}
            onClick={() => void versions.fetchNextPage()}
          >
            {t("Versioni precedenti", "Earlier versions")}
          </Button>
        )}
      </Modal>
      <Modal
        open={panel === "download"}
        onClose={() => setPanel(null)}
        title={t("Scarica opera", "Download work")}
        description={t(
          "Opera intera, nella versione selezionata.",
          "The entire work, in the selected version.",
        )}
        closeLabel={t("Chiudi", "Close")}
      >
        <p className="download-title">{title}</p>
        <fieldset className="download-formats">
          <legend className="sr-only">{t("Formato", "Format")}</legend>
          {["epub", "html", "pdf"].map((f) => (
            <label key={f}>
              <input
                type="radio"
                name="download-format"
                value={f}
                checked={format === f}
                onChange={() => setFormat(f)}
                disabled={downloading}
              />
              <span>
                <strong>{f.toUpperCase()}</strong>
                <small>
                  {f === "epub"
                    ? t(
                        "E-reader e app di lettura",
                        "E-readers and reading apps",
                      )
                    : f === "html"
                      ? t(
                          "Pagina web con media inclusi",
                          "Web page with embedded media",
                        )
                      : t("Documento impaginato", "Paginated document")}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
        {downloadError && <Notice error>{downloadError}</Notice>}
        <div className="download-actions">
          <Button
            tone="primary"
            disabled={downloading}
            onClick={() => void download()}
          >
            <Icon name="download" />
            {downloading
              ? t("Preparazione…", "Preparing…")
              : t("Scarica ", "Download ") + format.toUpperCase()}
          </Button>
          <span role="status">
            {downloading
              ? t(
                  "Puoi continuare a leggere durante la preparazione.",
                  "You can keep reading while the file is prepared.",
                )
              : ""}
          </span>
        </div>
      </Modal>
    </section>
  );
}
