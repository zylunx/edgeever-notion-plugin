import type { NotionClient } from "./client";
import type { NotionList } from "../types";

export interface BlockShape {
  object?: string;
  type?: string;
  id?: string;
  [key: string]: unknown;
}

/** 追加 Block children，单请求上限 100。用于插件维护的附件区。 */
export async function appendChildren(client: NotionClient, pageId: string, children: unknown[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < children.length; i += 100) {
    const chunk = children.slice(i, i + 100);
    const res = await client.request<NotionList<BlockShape>>(
      "PATCH",
      `/v1/blocks/${encodeURIComponent(pageId)}/children`,
      { children: chunk, notifications: { mode: "silent" } },
    );
    for (const b of res.results ?? []) if (typeof b?.id === "string") ids.push(b.id);
  }
  return ids;
}

/**
 * Markdown 内容不完整时的兜底读取：只做结构报告，不把不完整的正文写回任一端。
 * 完整 Block → Markdown 转换器不在首版范围内（见 README）。
 */
export async function describeBlockChildren(
  client: NotionClient,
  blockId: string,
  maxPages = 5,
): Promise<{ count: number; types: Record<string, number>; paginated: boolean }> {
  const types: Record<string, number> = {};
  let count = 0;
  let cursor: string | null = null;
  let pages = 0;
  let paginated = false;

  do {
    const q: string = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : "";
    const res: NotionList<BlockShape> = await client.request<NotionList<BlockShape>>(
      "GET",
      `/v1/blocks/${encodeURIComponent(blockId)}/children?page_size=100${q}`,
    );
    for (const b of res.results ?? []) {
      count++;
      const t = b?.type ?? "unknown";
      types[t] = (types[t] ?? 0) + 1;
    }
    cursor = res.has_more && typeof res.next_cursor === "string" ? res.next_cursor : null;
    pages++;
    if (cursor && pages >= maxPages) paginated = true;
  } while (cursor && pages < maxPages);

  return { count, types, paginated };
}
