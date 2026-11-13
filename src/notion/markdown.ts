import type { NotionClient } from "./client";
import type { NotionMarkdown } from "../types";

/** GET /v1/pages/{page_id}/markdown —— 必须检查 truncated / unknown_block_ids / warnings。 */
export async function getPageMarkdown(
  client: NotionClient,
  pageId: string,
  markdownVersion: "v1" | "v2" = "v2",
): Promise<NotionMarkdown> {
  const res = await client.request<NotionMarkdown>(
    "GET",
    `/v1/pages/${encodeURIComponent(pageId)}/markdown?markdown_version=${markdownVersion}`,
  );
  return { ...res, markdown: typeof res.markdown === "string" ? res.markdown : "" };
}

/**
 * PATCH /v1/pages/{page_id}/markdown —— 官方推荐的全量替换命令是
 * { type: "replace_content", replace_content: { new_str } }，不是 {"markdown": "..."}。
 * 显式保持 allow_deleting_content = false：绝不因替换正文而删掉子页面/数据库。
 */
export async function replacePageMarkdown(
  client: NotionClient,
  pageId: string,
  content: string,
  markdownVersion: "v1" | "v2" = "v2",
): Promise<NotionMarkdown> {
  return client.request<NotionMarkdown>("PATCH", `/v1/pages/${encodeURIComponent(pageId)}/markdown`, {
    type: "replace_content",
    replace_content: {
      new_str: content,
      allow_deleting_content: false,
    },
    markdown_version: markdownVersion,
  });
}

/** 返回内容不完整/被解析器改写的原因；非空时禁止把该内容回写任一端。 */
export function incompleteReasons(md: NotionMarkdown, phase: "read" | "write" = "read"): string[] {
  const reasons: string[] = [];
  if (md.truncated === true) reasons.push("正文被截断（页面超过记录上限）");
  const unknown = Array.isArray(md.unknown_block_ids) ? md.unknown_block_ids.length : 0;
  if (unknown > 0) reasons.push(`存在 ${unknown} 个未能加载/无法转换的 Block`);
  const warnings = Array.isArray(md.warnings) ? md.warnings : [];
  for (const w of warnings) {
    reasons.push(`内容警告：${w.code ?? "warning"} ${w.message ?? ""}`.trim());
  }
  if (reasons.length && phase === "write") {
    reasons.push("写入可能与预期不一致，请在 Notion 中核对后再同步");
  }
  return reasons;
}
