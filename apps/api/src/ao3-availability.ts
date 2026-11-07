import { parseDocument } from "htmlparser2";

type Node = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: Node[];
};
export type Availability =
  | "online"
  | "maintenance"
  | "rate_limited"
  | "blocked"
  | "unreachable"
  | "unknown";
export function retryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? Math.max(0, seconds * 1000) : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
/** Require an archive search form, not a successful HTTP status or branding. */
export function classifyAO3(status: number, html: string): Availability {
  const root = parseDocument(html) as unknown as Node;
  let text = "",
    search = false,
    title = "",
    content = false;
  function walk(node: Node, inTitle = false) {
    if (node.attribs?.id === "chapters") {
      content = true;
      return;
    }
    if (node.name === "script" || node.name === "style") return;
    if (node.type === "text") {
      text += " " + node.data;
      if (inTitle) title += " " + node.data;
    }
    if (
      node.name === "form" &&
      /^(?:https:\/\/archiveofourown\.org)?\/works\/search(?:\?|$)/.test(
        node.attribs?.action ?? "",
      )
    ) {
      const hasQuery = (n: Node): boolean =>
        (n.name === "input" && n.attribs?.name === "work_search[query]") ||
        (n.children ?? []).some(hasQuery);
      search ||= hasQuery(node);
    }
    for (const child of node.children ?? [])
      walk(child, inTitle || node.name === "title");
  }
  walk(root);
  if (status === 429) return "rate_limited";
  if (
    !content &&
    (/maintenance|temporarily unavailable|archive is down|down for|scheduled downtime/i.test(
      title,
    ) ||
      /down for maintenance|archive (?:is |will be )?(?:currently )?(?:unavailable|offline)|scheduled maintenance|undergoing maintenance|maintenance mode/i.test(
        text,
      ))
  )
    return "maintenance";
  if (status === 503) return "maintenance";
  if (
    status === 401 ||
    status === 403 ||
    /captcha|verify you are human|checking your browser/i.test(text)
  )
    return "blocked";
  return status === 200 && search ? "online" : "unknown";
}
export function nextProbeDelay(
  state: Availability,
  failures: number,
  retry: number | null,
  random = Math.random(),
): number {
  const base =
    state === "online"
      ? 300_000
      : Math.min(
          3_600_000,
          60_000 * 2 ** Math.min(6, Math.max(0, failures - 1)),
        );
  return Math.max(
    retry ?? 0,
    Math.ceil(base * (1 + Math.max(0, Math.min(1, random)) * 0.2)),
  );
}
