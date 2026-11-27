// E9-277 — somebody else's HTML, made safe to show in this page.
//
// The info sheet shows a README (Markdown, which may carry HTML) and posts
// from lines (Discourse's own HTML). Both are written by people this page
// has never met, and this page holds the user's files and a running
// instrument. So nothing is inserted as it came: the HTML is parsed into an
// inert document (DOMParser runs no script and loads nothing), and a NEW
// tree is built from it, element by element, keeping only the tags and
// attributes below. Everything else goes: a tag not on the list keeps its
// text and loses itself; script, style, iframe, forms and their kind go
// with everything inside them; no `on…`, no `style`, no `class` but the one
// that sizes an emoji. Addresses go through `resolve`, which decides what a
// link points at and where a picture is loaded from; one it refuses is not
// kept.

export interface Resolver {
  /** Where a link goes, or null to keep the text and drop the link. `#x` stays `#x`. */
  link(href: string): string | null;
  /**
   * Where a picture is loaded from: `{ src }` (with `cors` when it is another
   * origin that must be asked anonymously), `{ link }` to show its text as a
   * link instead, or null to drop it.
   */
  image(src: string): { src: string; cors?: boolean } | { link: string } | null;
}

/** Kept, with their children. */
const KEEP = new Set([
  "a", "abbr", "aside", "b", "blockquote", "br", "caption", "code", "dd", "del", "details", "div", "dl", "dt",
  "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li",
  "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strike", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var",
]);
/** Gone, with everything inside them. */
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button",
  "textarea", "select", "option", "noscript", "template", "svg", "math", "link", "meta", "base", "head",
  "title", "audio", "video", "source", "track", "canvas", "dialog", "portal",
]);
/** Attributes kept per tag, besides the addresses handled on their own. */
const ATTRS: Record<string, readonly string[]> = {
  a: ["title"],
  img: ["alt", "title", "width", "height"],
  td: ["align", "colspan", "rowspan"],
  th: ["align", "colspan", "rowspan"],
  ol: ["start", "reversed"],
  li: ["value"],
  details: ["open"],
  abbr: ["title"],
};

/** A heading's anchor, as GitHub makes it: `## How to use it?` → `how-to-use-it`. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** `html`, rebuilt from what is allowed, as nodes of `into`'s document. */
export function sanitizeInto(html: string, resolve: Resolver, into: HTMLElement): void {
  const doc = into.ownerDocument;
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
  const seen = new Map<string, number>();

  const copy = (src: Node, dst: Node): void => {
    for (const child of [...src.childNodes]) {
      if (child.nodeType === 3) {
        dst.appendChild(doc.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) continue;
      // Discourse: the size line under a picture, and its icons.
      if (el.classList.contains("meta") && el.closest("a.lightbox") !== null) continue;
      // A Discourse video is a placeholder with the file in an attribute:
      // a link to it says more than nothing.
      if (tag === "div" && el.hasAttribute("data-video-src")) {
        const href = resolve.link(el.getAttribute("data-video-src") ?? "");
        if (href !== null) {
          const a = doc.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "video";
          dst.appendChild(a);
        }
        continue;
      }
      if (!KEEP.has(tag)) {
        copy(el, dst);
        continue;
      }
      if (tag === "img") {
        const r = resolve.image(el.getAttribute("src") ?? "");
        if (r === null) continue;
        if ("link" in r) {
          // Inside a link already (a video's still in a preview): its title,
          // as text, and the link it is in still goes where it went.
          if (el.closest("a") !== null) {
            const label = el.getAttribute("title") || el.getAttribute("alt");
            if (label) dst.appendChild(doc.createTextNode(label));
            continue;
          }
          const a = doc.createElement("a");
          a.href = r.link;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = el.getAttribute("alt") || "picture";
          dst.appendChild(a);
          continue;
        }
        const img = doc.createElement("img");
        for (const name of ATTRS["img"]!) {
          const v = el.getAttribute(name);
          if (v !== null && (name !== "width" && name !== "height" ? true : /^\d{1,4}%?$/.test(v))) img.setAttribute(name, v);
        }
        if (el.classList.contains("emoji")) img.className = "emoji";
        img.loading = "lazy";
        img.decoding = "async";
        img.referrerPolicy = "no-referrer";
        if (r.cors === true) img.crossOrigin = "anonymous";
        img.src = r.src;
        dst.appendChild(img);
        continue;
      }
      const out = doc.createElement(tag);
      for (const name of ATTRS[tag] ?? []) {
        const v = el.getAttribute(name);
        if (v !== null) out.setAttribute(name, v);
      }
      if (tag === "a") {
        const raw = el.getAttribute("href");
        if (raw !== null) {
          if (raw.startsWith("#")) out.setAttribute("href", raw);
          else {
            const href = resolve.link(raw);
            if (href === null) {
              copy(el, dst);
              continue;
            }
            out.setAttribute("href", href);
            out.setAttribute("target", "_blank");
            out.setAttribute("rel", "noopener noreferrer");
          }
        }
      }
      if (/^h[1-6]$/.test(tag)) {
        const base = slug(el.textContent ?? "");
        if (base !== "") {
          const k = seen.get(base) ?? 0;
          seen.set(base, k + 1);
          out.id = `inf-${k === 0 ? base : `${base}-${k}`}`;
        }
      }
      copy(el, out);
      dst.appendChild(out);
    }
  };
  copy(parsed.body, into);
}
