import { createRequire } from "node:module";
const css: typeof import("css-tree") = createRequire(__filename)("css-tree");
export function cssMediaURLs(text: string, base: string) {
  const urls = new Set<string>();
  const add = (value: string) => {
    try {
      const url = new URL(value, base);
      if (["https:", "http:"].includes(url.protocol)) urls.add(url.href);
    } catch {}
  };
  try {
    const ast = css.parse(text);
    css.walk(ast, (node: any) => {
      if (node.type === "Url") add(node.value);
      if (
        node.type === "Atrule" &&
        node.name.toLowerCase() === "import" &&
        node.prelude
      )
        css.walk(node.prelude, (part: any) => {
          if (part.type === "String") add(part.value);
        });
    });
  } catch {}
  return [...urls];
}
