export type Anchor = {
  snapshot: string;
  chapter: string;
  offset: number;
  quote: string;
  prefix: string;
  suffix: string;
};
export function alignAnchor(
  original: Anchor,
  texts: Map<string, string>,
  snapshot: string,
) {
  const text = texts.get(original.chapter);
  if (text === undefined)
    return { anchor: null, status: "unresolved" as const };
  const matches = (offset: number) =>
    text.slice(offset, offset + original.quote.length) === original.quote &&
    text.slice(Math.max(0, offset - original.prefix.length), offset) ===
      original.prefix &&
    text.slice(
      offset + original.quote.length,
      offset + original.quote.length + original.suffix.length,
    ) === original.suffix;
  if (snapshot === original.snapshot && matches(original.offset))
    return { anchor: original, status: "exact" as const };
  const candidates: number[] = [];
  let offset = text.indexOf(original.quote);
  while (offset >= 0) {
    if (matches(offset)) candidates.push(offset);
    offset = text.indexOf(original.quote, offset + 1);
  }
  if (candidates.length !== 1)
    return { anchor: null, status: "unresolved" as const };
  return {
    anchor: { ...original, snapshot, offset: candidates[0] },
    status: "moved" as const,
  };
}
