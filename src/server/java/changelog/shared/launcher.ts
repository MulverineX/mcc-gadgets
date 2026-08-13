import { z } from "zod";

import { cache, fetchAndParse } from "~/lib/fetch";

const LAUNCHER_PATCH_NOTES_URL =
  "https://launchercontent.mojang.com/v2/javaPatchNotes.json";
const LAUNCHER_BASE = "https://launchercontent.mojang.com";

const LAUNCHER_ENTRY_SCHEMA = z.object({
  version: z.string(),
  image: z.object({
    title: z.string(),
    url: z.string(),
  }),
  shortText: z.string().transform(repairLauncherShortText),
  contentPath: z.string(),
});

export type LauncherEntry = z.infer<typeof LAUNCHER_ENTRY_SCHEMA>;

const LAUNCHER_PATCH_NOTES_SCHEMA = z.object({
  entries: z.array(LAUNCHER_ENTRY_SCHEMA),
});

export type LauncherPatchNotes = z.infer<typeof LAUNCHER_PATCH_NOTES_SCHEMA>;

/**
 * Launcher content shipped `1.13+` releases (per PLAN §Data Sources). Fetch
 * once, cache, normalize image URLs to absolute form, repair the broken spacing
 * in upstream `shortText` values.
 */
export const getLauncherPatchNotes = cache(
  async (): Promise<LauncherPatchNotes> => {
    const res = await fetchAndParse(
      LAUNCHER_PATCH_NOTES_URL,
      LAUNCHER_PATCH_NOTES_SCHEMA,
    );

    if (!res.success) {
      throw new Error(`Failed to fetch launcher patch notes: ${String(res.error)}`);
    }

    return {
      entries: res.data.entries.map((entry) => ({
        ...entry,
        image: {
          ...entry.image,
          url: absolutizeImageUrl(entry.image.url),
        },
      })),
    };
  },
  ["java", "changelog", "launcher_patch_notes"],
  { revalidate: 3 * 60 * 60 /* 3 hr */ },
);

/** Quick membership test: is this version id covered by launchercontent? */
export async function hasLauncherEntry(id: string): Promise<boolean> {
  const notes = await getLauncherPatchNotes();
  return notes.entries.some((e) => e.version === id);
}

/** Return the launchercontent record for a version id, or undefined. */
export async function getLauncherEntry(
  id: string,
): Promise<LauncherEntry | undefined> {
  const notes = await getLauncherPatchNotes();
  return notes.entries.find((e) => e.version === id);
}

function absolutizeImageUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${LAUNCHER_BASE}${url}`;
  return `${LAUNCHER_BASE}/${url}`;
}

/**
 * Launchercontent's `shortText` ships with broken spacing between adjacent
 * words when the source article wrapped them at sentence boundaries. Apply the
 * existing repair from `versions.ts` so downstream consumers see clean text.
 */
function repairLauncherShortText(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1. $2")
    .replace(/([a-z][!.])([A-Z])/g, "$1 $2");
}