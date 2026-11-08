import { createRequire } from "node:module";
const localRequire = createRequire(__filename);
const sanitize: typeof import("sanitize-html") = localRequire("sanitize-html");
const css: typeof import("css-tree") = localRequire("css-tree");
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export type Resolver = (url: string) => string;
export function safeCss(
  source: string,
  resource: Resolver = () => "",
  declarations = false,
) {
  try {
    const ast = css.parse(source, {
      context: declarations ? "declarationList" : "stylesheet",
    });
    css.walk(ast, {
      visit: "Atrule",
      enter(node, item, list) {
        if (
          ![
            "media",
            "supports",
            "font-face",
            "keyframes",
            "-webkit-keyframes",
            "layer",
            "container",
            "scope",
            "page",
          ].includes(node.name.toLowerCase())
        )
          list.remove(item);
      },
    });
    css.walk(ast, {
      visit: "Declaration",
      enter(node, item, list) {
        // Inline source styles must yield to explicit reader preferences.
        if (declarations) node.important = false;
        let unsafe =
          /^(?:behavior|-moz-binding)$/i.test(node.property) ||
          node.property.startsWith("--");
        css.walk(node.value, (n) => {
          if (
            (n.type === "String" &&
              /^(?:https?:|\/\/|data:|file:|javascript:)/i.test(n.value)) ||
            n.type === "Raw" ||
            (n.type === "Function" && /^(?:expression|var|attr)$/i.test(n.name))
          )
            unsafe = true;
          if (n.type === "Function" && /^(?:-webkit-)?image-set$/i.test(n.name))
            css.walk(n, (v) => {
              if (v.type === "String") {
                const local = resource(v.value);
                if (local) v.value = local;
                else unsafe = true;
              }
            });
          if (n.type === "Url") {
            const local = /^#[\w.-]+$/.test(n.value)
              ? n.value
              : resource(n.value);
            if (!local) unsafe = true;
            else n.value = local;
          }
        });
        if (
          node.property.toLowerCase() === "position" &&
          css.generate(node.value).toLowerCase() === "fixed"
        )
          unsafe = true;
        if (unsafe) list.remove(item);
      },
    });
    return css.generate(ast).replace(/</g, "\\3c ");
  } catch {
    return "";
  }
}
export function safeHtml(
  html: string,
  media: Resolver = () => "",
  download = false,
  links: Resolver = (url) => url,
  skin = true,
) {
  const rewrite = (tag: string, a: Record<string, string>) => ({
    tagName: tag,
    attribs: {
      ...a,
      ...(a.src ? { src: media(a.src) } : {}),
      ...(a.poster ? { poster: media(a.poster) } : {}),
      ...(a.style ? { style: skin ? safeCss(a.style, media, true) : "" } : {}),
      ...(["audio", "video"].includes(tag)
        ? { controls: "", preload: "metadata" }
        : {}),
    },
  });
  return sanitize(html, {
    nonTextTags: ["script", "style", "textarea", "option", "head", "title"],
    allowedTags: [
      ...sanitize.defaults.allowedTags,
      "img",
      "audio",
      "video",
      "source",
      "track",
      "figure",
      "figcaption",
      "hr",
      "ruby",
      "rt",
      "rp",
      "details",
      "summary",
    ],
    allowedAttributes: {
      "*": ["id", "class", "lang", "dir", "title", "style"],
      a: ["href", "name", "rel", "target"],
      img: ["src", "alt", "width", "height"],
      audio: ["src", "controls", "preload"],
      video: ["src", "controls", "poster", "width", "height", "preload"],
      source: ["src", "type"],
      track: ["src", "kind", "srclang", "label"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan", "scope"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      a: download
        ? ["http", "https", "mailto", "data"]
        : ["http", "https", "mailto"],
      img: download ? ["data"] : [],
      audio: download ? ["data"] : [],
      video: download ? ["data"] : [],
      source: download ? ["data"] : [],
    },
    allowProtocolRelative: false,
    parseStyleAttributes: false,
    transformTags: {
      "*": rewrite,
      a: (tag, a) => {
        const href = links(a.href ?? "");
        return {
          tagName: tag,
          attribs: {
            ...rewrite(tag, a).attribs,
            href,
            rel: "noreferrer noopener",
            ...(href.startsWith("#") ? {} : { target: "_blank" }),
          },
        };
      },
    },
    exclusiveFilter: (frame) =>
      ["img", "source", "track"].includes(frame.tag) && !frame.attribs.src,
  });
}
export function readerDocument(
  body: string,
  style = "",
  options: {
    theme?: string;
    font?: string;
    size?: number;
    language?: string;
  } = {},
) {
  const dark = options.theme === "dark";
  const font =
    options.font === "sans" ? "system-ui,sans-serif" : "Georgia,serif";
  const size = Math.max(14, Math.min(28, options.size ?? 18));
  const paper = dark ? "#20272e" : "#fffefa";
  const ink = dark ? "#e9e7e1" : "#292c31";
  const link = dark ? "#9bc5ed" : "#284f74";
  const line = dark ? "#414b55" : "#deddd6";
  const workStyle = safeCss(style, (url) =>
    /^(?:\/api\/v1\/works\/[a-f0-9-]+\/media\/[a-f0-9]{64}\?|palimora-asset-[a-f0-9]{64}$)/.test(
      url,
    )
      ? url
      : "",
  );
  // Reader geometry and palette belong to the host. Source layout stays inside
  // #workskin; dark mode deliberately overrides source colours, never media pixels.
  const palette = dark
    ? `#workskin,#workskin *:not(img):not(video):not(svg):not(svg *),#workskin *::before,#workskin *::after{color:${ink}!important;background-color:transparent!important;background-image:none!important;border-color:${line}!important;text-shadow:none!important;-webkit-text-fill-color:currentColor!important}#workskin a,#workskin a *{color:${link}!important}`
    : "";
  return `<!doctype html><html lang="${escapeHtml(options.language ?? "und")}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>
    @layer palimora-reader;
    *{box-sizing:border-box}body{font:${size}px/1.85 ${font};overflow-wrap:anywhere;text-align:start}
    #workskin{max-width:68ch;margin:0 auto}img,video{max-width:100%;height:auto}audio{max-width:100%}a{color:${link}}pre{white-space:pre-wrap}table{max-width:100%}p{margin:0 0 1.2em}h1,h2,h3,h4{line-height:1.35;text-wrap:balance}h3.fff_chapter_title,.chapter>h2{font-size:1.3em;font-weight:500;text-align:center;margin:0 0 2em}.chapter+.chapter{margin-top:4em;padding-top:2em;border-top:1px solid ${line}}.notes{font-size:.9em;border-block:1px solid ${line};padding:1em 0;margin:1.5em 0}blockquote{margin:1.5em 0;padding-left:1.5em;border-left:2px solid ${line}}
    ${workStyle}
    @layer palimora-reader { html{color-scheme:${dark ? "dark" : "light"}!important;background:${paper}!important}
    body{text-align:start!important;width:auto!important;max-width:none!important;margin:0!important;padding:clamp(1.5rem,5vw,4rem) clamp(1rem,4vw,3rem)!important;background:${paper}!important;color:${ink}!important;font-family:${font}!important;font-size:${size}px!important}
    ${palette} }
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
    </style></head><body><div id="workskin">${body}</div></body></html>`;
}

export function safeInlineHtml(html: string) {
  return sanitize(html, {
    allowedTags: [
      "p",
      "br",
      "em",
      "strong",
      "b",
      "i",
      "s",
      "u",
      "blockquote",
      "pre",
      "code",
      "ol",
      "ul",
      "li",
      "a",
      "span",
      "sup",
      "sub",
    ],
    allowedAttributes: { a: ["href", "rel", "target"] },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: (tag, a) => ({
        tagName: tag,
        attribs: {
          href: a.href ?? "",
          rel: "noreferrer noopener",
          target: "_blank",
        },
      }),
    },
  });
}
