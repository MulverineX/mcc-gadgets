import * as htmlparser2 from "htmlparser2";

// `htmlparser2` types its element union loosely; this alias mirrors what
// the existing diagnostic script uses so the parser logic ports 1:1.
export type Element = NonNullable<
  Parameters<NonNullable<ConstructorParameters<typeof htmlparser2.DomHandler>[2]>>[0]
>;

export { htmlparser2 };
export {
  Comment as DomComment,
  Element as DomElement,
  Text as DomText,
  isComment,
  isTag,
  isText,
  type ChildNode,
} from "domhandler";
export { ElementType } from "domelementtype";

export interface ParsedArticleSection {
  version: string;
  rawTitle: string;
}

export interface BugRef {
  id: `MC-${number}`;
  title: string;
}

export interface ParsedArticle {
  version: string;
  heroImage: string | null;
  source: "minecraft.net" | "mojang";
  body: SerializedAST;
  bugList: BugRef[];
  merged: boolean;
  shortText: string;
}

// Cyclic-graph JSON encoding of a DOM fragment. The `nodes` array is in
// preorder DFS, so `nodes[i].children` are always indexes `> i` and
// `nodes[i].parent.$ref` always points to an index `< i` (or `null` for roots).
// Lossless — `deserializeAst(serializeAst(children))` round-trips.
export type ASTRef = { $ref: number };

export interface ASTElement {
  type: "element";
  tag: string;
  kind: "tag" | "script" | "style";
  attrs: Record<string, string>;
  children: number[];
  parent: ASTRef | null;
  prev: ASTRef | null;
  next: ASTRef | null;
}

export interface ASTText {
  type: "text";
  data: string;
  parent: ASTRef | null;
  prev: ASTRef | null;
  next: ASTRef | null;
}

export interface ASTComment {
  type: "comment";
  data: string;
  parent: ASTRef | null;
  prev: ASTRef | null;
  next: ASTRef | null;
}

export type ASTNode = ASTElement | ASTText | ASTComment;

export interface SerializedAST {
  nodes: ASTNode[];
}
