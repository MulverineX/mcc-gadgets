import {
  type ChildNode,
  DomElement,
  type Element,
  ElementType,
  htmlparser2,
} from "./types";
import { documentCreateDiv } from "./utils";

export function normalizeArticleMedia(nodes: ChildNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as unknown as Element;
    if (node?.tagName !== "div") continue;
    const classes = (node.attribs?.class ?? "").split(" ");
    if (!classes.includes("article-media")) continue;

    const imgs = htmlparser2.DomUtils.findAll(
      (el) => el.tagName === "img",
      node as unknown as Parameters<typeof htmlparser2.DomUtils.findAll>[1],
    ) as unknown as Element[];
    const imageEl = imgs[0] ?? null;

    let imageLinksTo: string | undefined = undefined;
    if (
      imageEl?.parentNode?.parentNode?.type === ElementType.Tag &&
      imageEl.parentNode.parentNode.tagName === "a"
    ) {
      imageLinksTo = imageEl.parentNode.parentNode.attributes.find(
        (attr) => attr.name === "href",
      )?.value;
      if (
        typeof imageLinksTo === "string" &&
        imageLinksTo.includes("https://youtu")
      ) {
        const youtubeLink = new URL(imageLinksTo);
        // This doesn't work in the __rendered.html either because of something missing in the <head> or because its not actually from a webserver
        // or because the host isnt https, but I tested the element on mcc-gadgets.com and it worked fine.
        // TODO: Add wrapper to this so the user sees the thumbnail mojang chose for the article and when they click the video should start
        nodes[i] = new DomElement(
          "iframe",
          {
            id: "ytplayer",
            width: "640",
            height: "360",
            frameborder: "0",
            src: `https://www.youtube.com/embed/${
              youtubeLink.hostname === "youtu.be"
                ? youtubeLink.pathname.slice(1)
                : youtubeLink.searchParams.get("v")
            }`,
            allow: "compute-pressure",
            referrerpolicy: "strict-origin-when-cross-origin",
          },
          [],
          ElementType.Tag,
        ) as unknown as ChildNode;
        continue;
      }
    }

    let subtitleEl: Element | null = null;
    const stack: Element[] = [...((node.children ?? []) as Element[])];
    while (stack.length) {
      const el = stack.pop()!;
      if (
        (el.attribs?.class ?? "").split(" ").includes("MC_Link_Style_RichText")
      ) {
        subtitleEl = el;
        break;
      }
      for (const c of (el.children ?? []) as Element[]) stack.push(c);
    }

    if (imageEl?.attribs?.src) {
      // Absolutize the src on the img (same rule as the hero image).
      const abs = absolutizeImageUrl(imageEl.attribs.src);
      if (abs !== null) imageEl.attribs.src = abs;
    }

    if (subtitleEl) {
      const wrap = documentCreateDiv("captioned-image");
      if (imageEl) (wrap.children ?? []).push(imageEl);
      for (const c of (subtitleEl.children ?? []) as Element[]) {
        (wrap.children ?? []).push(c);
      }
      nodes[i] = wrap;
    } else if (imageEl) {
      nodes[i] = imageEl;
    }
  }
}

function absolutizeImageUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `https://www.minecraft.net${url}`;
  return `https://www.minecraft.net/${url}`;
}
