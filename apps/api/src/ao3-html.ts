import { parseDocument } from "htmlparser2";
export type HNode = {
  name?: string;
  type: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HNode[];
  parent?: HNode;
  startIndex?: number | null;
  endIndex?: number | null;
};
export const dom = (html: string) =>
  parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
  }) as unknown as HNode;
export const attr = (n: HNode | undefined, key: string) =>
  n?.attribs?.[key] ?? "";
export const has = (n: HNode | undefined, c: string) =>
  attr(n, "class").split(/\s+/).includes(c);
export function all(n: HNode, match: (n: HNode) => boolean): HNode[] {
  const out: HNode[] = [];
  function visit(x: HNode) {
    if (match(x)) out.push(x);
    for (const c of x.children ?? []) visit(c);
  }
  visit(n);
  return out;
}
export const first = (n: HNode, match: (n: HNode) => boolean) =>
  all(n, match)[0];
export function textOf(n: HNode | undefined): string {
  return !n
    ? ""
    : n.type === "text"
      ? (n.data ?? "")
      : (n.children ?? []).map(textOf).join("");
}
export const clean = (n: HNode | undefined) =>
  textOf(n).replace(/\s+/g, " ").trim();
export const raw = (html: string, n: HNode) =>
  html.slice(n.startIndex ?? 0, (n.endIndex ?? -1) + 1);
export const links = (n: HNode) =>
  all(n, (x) => x.name === "a" && !!attr(x, "href"));
const tagEscapes: Record<string, string> = {
  "/": "s",
  "&": "a",
  ".": "d",
  "?": "q",
  "#": "h",
};
export function tagPath(name: string) {
  return (
    "/tags/" +
    encodeURIComponent(
      [...name]
        .map((c) => (tagEscapes[c] ? "*" + tagEscapes[c] + "*" : c))
        .join(""),
    )
  );
}
export function tagName(segment: string) {
  return decodeURIComponent(segment).replace(
    /\*([sadqh])\*/g,
    (_s, code) => Object.keys(tagEscapes).find((c) => tagEscapes[c] === code)!,
  );
}
