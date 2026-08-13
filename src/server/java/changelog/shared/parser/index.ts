import {
  DomComment,
  DomElement,
  DomText,
  ElementType,
  isComment,
  isTag,
  isText,
  type ChildNode,
  type Element,
  htmlparser2,
} from "./types";
import type {
  ASTNode,
  ASTRef,
  BugRef,
  ParsedArticle,
  SerializedAST,
} from "./types";
export type {
  ASTComment,
  ASTElement,
  ASTNode,
  ASTRef,
  ASTText,
  BugRef,
  ParsedArticle,
  ParsedArticleSection,
  SerializedAST,
} from "./types";

import {
  buildBodyElement,
  containerChildren,
  findFirst,
  findOldestRange,
  makeShortTextFromChildren,
  pickRange,
  trimRootEdges,
  wrapperChildren,
} from "./utils";
import { normalizeArticleMedia } from "./media";
import { splitMojangByVersion } from "./mojang.com.shared";
import { findMojangLegacyFooterEnd } from "./mojang.com.old";
import { splitMinecraftNetByVersion, findIntroProse } from "./minecraft.net.aem";
import type { SectionRange } from "./utils";

const MINECRAFT_NET_BASE = "https://www.minecraft.net";

export function absolutizeImageUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${MINECRAFT_NET_BASE}${url}`;
  return `${MINECRAFT_NET_BASE}/${url}`;
}

function findFirstHeroInBody(root: Element): string | null {
  const imgs = htmlparser2.DomUtils.findAll(
    (el) => el.tagName === "img",
    root as unknown as Parameters<typeof htmlparser2.DomUtils.findAll>[1],
  ) as unknown as Element[];
  for (const img of imgs) {
    const src = img.attribs?.src;
    if (!src) continue;
    if (!src.includes("media.mojang.com")) continue;
    return src;
  }
  return null;
}

const UNWRAP_CLASSES = new Set<string>([
  "MC_Link_Style_RichText",
  "article-text",
]);

function findArticleBodyContainer(root: Element): Element | null {
  const articleGridHits = htmlparser2.DomUtils.findAll(
    (el) => {
      const cls = (el as Element).attribs?.class ?? "";
      return cls.split(" ").includes("article-grid-a");
    },
    root as unknown as Parameters<typeof htmlparser2.DomUtils.findAll>[1],
  ) as unknown as Element[];
  if (articleGridHits.length === 0) return null;

  function gridHasArticleText(g: Element): boolean {
    const stack: Element[] = [...((g.children ?? []) as Element[])];
    while (stack.length) {
      const el = stack.pop()!;
      const cls = (el.attribs?.class ?? "").split(" ");
      if (cls.includes("article-text")) return true;
      for (const c of (el.children ?? []) as Element[]) stack.push(c);
    }
    return false;
  }
  const firstContentIdx = articleGridHits.findIndex(gridHasArticleText);
  if (firstContentIdx === -1) return null;
  let lastContentIdx = firstContentIdx;
  for (let i = firstContentIdx + 1; i < articleGridHits.length; i++) {
    if (gridHasArticleText(articleGridHits[i]!)) lastContentIdx = i;
  }
  const contentGrids = articleGridHits.slice(
    firstContentIdx,
    lastContentIdx + 1,
  );

  const STRUCTURAL_CLASS_PREFIXES = [
    "MC_Bg_Inherit",
    "MC_Theme_Vanilla",
    "MC_articleHeroA",
    "MC_articleGridA",
    "article-section",
    "article-grid-a",
  ];
  const isStructuralWrapper = (el: Element): boolean => {
    const cls = (el as Element).attribs?.class ?? "";
    if (!cls) return false;
    const classes = cls.split(" ");
    return STRUCTURAL_CLASS_PREFIXES.some((p) =>
      classes.some(
        (c) => c === p || c.startsWith(p + "-") || c.startsWith(p + "_"),
      ),
    );
  };

  const isUnwrap = (el: Element): boolean => {
    const cls = (el as Element).attribs?.class ?? "";
    if (!cls) return false;
    return cls.split(" ").some((c) => UNWRAP_CLASSES.has(c));
  };

  const collected: Element[] = [];
  function collect(el: Element): void {
    if (isStructuralWrapper(el) || isUnwrap(el)) {
      for (const c of (el.children ?? []) as Element[]) collect(c);
      return;
    }
    collected.push(el);
  }
  for (const g of contentGrids) {
    for (const c of (g.children ?? []) as Element[]) collect(c);
  }
  if (collected.length === 0) return null;

  const firstGrid = contentGrids[0]!;
  function firstStructuralDescendant(g: Element): Element | null {
    for (const c of (g.children ?? []) as Element[]) {
      if (isStructuralWrapper(c)) return c;
    }
    return null;
  }
  const shell = firstStructuralDescendant(firstGrid) ?? firstGrid;
  (shell as { children?: Element[] }).children = collected;
  return shell;
}

export function parseArticle(
  html: string,
  source: "mojang" | "minecraft.net",
  version: string,
): ParsedArticle {
  const root = htmlparser2.parseDocument(html) as unknown as Element;

  const container =
    source === "mojang"
      ? findFirst(
          (el) =>
            el.tagName === "article" &&
            (el.attribs?.class ?? "").includes("post-content"),
          root,
        ) ??
        findFirst(
          (el) =>
            el.tagName === "div" &&
            (el.attribs?.class ?? "").includes("post-content") &&
            wrapperChildren(el).filter((c) => c.tagName === "p").length > 1,
          root,
        )
      : findArticleBodyContainer(root);
  const heroImage =
    source === "mojang"
      ? (() => {
          const div = findFirst(
            (el) => el.attribs?.class === "post-header__image",
            root,
          );
          const img = div?.children?.find(
            (c) => (c as Element).tagName === "img",
          ) as Element | undefined;
          if (img?.attribs?.src) return img.attribs.src;
          return findFirstHeroInBody(container ?? root);
        })()
      : (() => {
          const og = findFirst(
            (el) =>
              el.tagName === "meta" && el.attribs?.property === "og:image",
            root,
          );
          return og?.attribs?.content ?? null;
        })();

  if (!container) {
    return {
      version,
      heroImage,
      source,
      body: { nodes: [] },
      bugList: [],
      merged: false,
      shortText: "",
    };
  }

  const rawRanges =
    source === "mojang"
      ? splitMojangByVersion(container, version)
      : splitMinecraftNetByVersion(container, version);

  const ranges: SectionRange[] =
    rawRanges.length === 0
      ? [
          {
            version,
            rawTitle: "",
            children:
              source === "mojang"
                ? findMojangLegacyFooterEnd(container)
                : containerChildren(container),
          },
        ]
      : rawRanges;

  const matched = pickRange(ranges, version);

  // For minecraft.net merged pre-release pages (multiple "Changes in X" /
  // "Fixed bugs in X" sections), the page-level intro prose belongs to the
  // OLDEST version — the one the article was originally published for.
  // Mojang appends newer pre-release updates below, so pre-2/3/4/5 in the
  // 1.14-pre1 article get just their own section, no shared intro. Single-
  // section pages (1.20.6) already include the intro via sectionStart=0,
  // so we skip them here to avoid duplicating it.
  const isMerged = ranges.length > 1;
  const isOldest = matched !== null && matched === findOldestRange(ranges);
  if (matched && source === "minecraft.net" && container && isMerged && isOldest) {
    const introEls = findIntroProse(container);
    if (introEls.length > 0) {
      matched.children = [...introEls, ...matched.children];
    }
  }

  const bugList: BugRef[] = matched ? buildBodyElement(matched) : [];
  const survivors = matched
    ? matched.children.filter((c) => {
        if (c.parent === null) return false;
        if (
          c.tagName === "ul" &&
          (c.children ?? []).filter(
            (cc) => (cc as { tagName?: string }).tagName === "li",
          ).length === 0
        ) {
          return false;
        }
        return true;
      })
    : [];
  normalizeArticleMedia(survivors);
  const body = serializeAst(trimRootEdges(survivors));
  const shortText = makeShortTextFromChildren(survivors);

  return {
    version,
    heroImage,
    source,
    body,
    bugList,
    merged: ranges.length > 1,
    shortText,
  };
}

export function serializeAst(roots: ChildNode[]): SerializedAST {
  const nodes: ASTNode[] = [];
  const rootIndexes: number[] = [];

  function visit(node: ChildNode, parentIdx: number | null): void {
    const idx = nodes.length;
    const parent: ASTRef | null = parentIdx === null ? null : { $ref: parentIdx };
    if (isText(node)) {
      nodes.push({
        type: "text",
        data: (node as { data: string }).data,
        parent,
        prev: null,
        next: null,
      });
      return;
    }
    if (isComment(node)) {
      nodes.push({
        type: "comment",
        data: (node as { data: string }).data,
        parent,
        prev: null,
        next: null,
      });
      return;
    }
    if (isTag(node)) {
      const children: number[] = [];
      const t = node.type as string;
      const kind: "tag" | "script" | "style" =
        t === "script" ? "script" : t === "style" ? "style" : "tag";
      nodes.push({
        type: "element",
        tag: node.tagName,
        kind,
        attrs: { ...node.attribs },
        children,
        parent,
        prev: null,
        next: null,
      });
      for (const child of node.children) {
        const childIdx = nodes.length;
        visit(child, idx);
        children.push(childIdx);
      }
      return;
    }
  }

  function wireSiblings(indexes: number[]): void {
    for (let i = 0; i < indexes.length; i++) {
      const idx = indexes[i]!;
      const prev: ASTRef | null = i > 0 ? { $ref: indexes[i - 1]! } : null;
      const next: ASTRef | null =
        i < indexes.length - 1 ? { $ref: indexes[i + 1]! } : null;
      nodes[idx] = { ...nodes[idx]!, prev, next };
    }
  }

  for (const root of roots) {
    rootIndexes.push(nodes.length);
    visit(root, null);
  }
  wireSiblings(rootIndexes);
  for (const n of nodes) {
    if (n.type === "element" && n.children.length > 0) {
      wireSiblings(n.children);
    }
  }

  return { nodes };
}

export function deserializeAst(serialized: SerializedAST): DomElement[] {
  const { nodes } = serialized;
  const domNodes: ChildNode[] = nodes.map((n) => {
    if (n.type === "text") return new DomText(n.data);
    if (n.type === "comment") return new DomComment(n.data);
    const type =
      n.kind === "script"
        ? ElementType.Script
        : n.kind === "style"
          ? ElementType.Style
          : ElementType.Tag;
    return new DomElement(n.tag, { ...n.attrs }, [], type);
  });
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.type === "element") {
      const elem = domNodes[i] as DomElement;
      for (const childIdx of n.children) {
        elem.children.push(domNodes[childIdx]!);
      }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const domNode = domNodes[i]!;
    domNode.prev = n.prev ? domNodes[n.prev.$ref]! : null;
    domNode.next = n.next ? domNodes[n.next.$ref]! : null;
  }
  const roots: DomElement[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]!.parent === null) roots.push(domNodes[i] as DomElement);
  }
  return roots;
}
