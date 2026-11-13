import type { PluginResource } from "../types";
import { normalizeMarkdown } from "../sync/hash";

/** 插件维护的 Notion 附件区标记：读取正文时整段剥离，不参与内容 Hash。 */
export const ATTACH_START = "EE-ATTACHMENTS-START";
export const ATTACH_END = "EE-ATTACHMENTS-END";
/** 正文中本地资源的可追溯占位，形如 EE-ATTACH:res_abc123|sunrise.png */
export const ATTACH_LINE = "EE-ATTACH:";

function findResource(resources: PluginResource[], target: string): PluginResource | undefined {
  const raw = target.trim().replace(/^<|>$/g, "");
  const id = raw.startsWith("edgeever://") ? raw.slice("edgeever://".length) : raw;
  return resources.find((r) => r.id === id || r.filename === id || r.fileName === id || r.name === id);
}

function isExternalTarget(target: string): boolean {
  const t = target.trim();
  return /^(https?:|data:|mailto:|ftp:|#)/i.test(t);
}

/** 把 EdgeEver 本地资源引用改写为可追溯占位；外部链接、data URI 保持原样。 */
export function replaceLocalRefs(markdown: string, resources: PluginResource[]): string {
  const lines = (markdown ?? "").split("\n");
  return lines
    .map((line) => {
      return line.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, _label: string, target: string) => {
        if (isExternalTarget(target)) return whole;
        const resource = findResource(resources, target);
        if (!resource) return whole; // 无法识别的引用原样保留，不静默丢弃
        const filename = resource.filename ?? resource.fileName ?? resource.name ?? resource.id;
        return `${ATTACH_LINE}${resource.id}|${filename}`;
      });
    })
    .join("\n");
}

export function parseAttachmentPlaceholders(markdown: string): Array<{ id: string; filename: string }> {
  const out: Array<{ id: string; filename: string }> = [];
  const re = new RegExp(`^\\s*${ATTACH_LINE.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^|\\n]+)\\|(.+?)\\s*$`, "gm");
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown ?? "")) !== null) {
    out.push({ id: m[1].trim(), filename: m[2].trim() });
  }
  return out;
}

/** 把占位行还原为 EdgeEver 本地资源引用；资源已不存在时保留占位并交给报告层提示。 */
export function restorePlaceholders(markdown: string, resources: PluginResource[]): string {
  return (markdown ?? "")
    .split("\n")
    .map((line) => {
      const m = new RegExp(`^\\s*(${ATTACH_LINE})([^|\\n]+)\\|(.+?)\\s*$`).exec(line);
      if (!m) return line;
      const id = m[2].trim();
      const filename = m[3].trim();
      const known = resources.some((r) => r.id === id);
      if (!known) return line;
      return `![${filename}](edgeever://${id})`;
    })
    .join("\n");
}

/** 剥离由插件追加的附件区（含首尾标记行）。 */
export function stripAttachmentSection(markdown: string): { text: string; found: boolean } {
  const lines = (markdown ?? "").split("\n");
  const start = lines.findIndex((l) => l.includes(ATTACH_START));
  if (start < 0) return { text: markdown ?? "", found: false };
  const end = lines.findIndex((l, i) => i > start && l.includes(ATTACH_END));
  const cutTo = end >= 0 ? end + 1 : lines.length;
  const kept = [...lines.slice(0, start), ...lines.slice(cutTo)];
  return { text: kept.join("\n"), found: true };
}

/** Notion v2 要求图片独占一个 Block，连续图片之间要有空行。 */
export function prepareImagesForV2(markdown: string): string {
  const lines = (markdown ?? "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const isImageLine = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line);
    if (isImageLine && out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(line);
    if (isImageLine) out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Notion 特有标签转成可追溯文本，避免回写 EdgeEver 时静默丢失信息。 */
export function preserveUnknownTags(markdown: string): string {
  let s = markdown ?? "";
  s = s.replace(/<unknown\s+url="([^"]*)"[^>]*\/>/g, (_all, url: string) =>
    url ? `[Notion 未加载的内容（原地址）](${url})` : "[Notion 未能加载的内容]",
  );
  s = s.replace(/<link-preview\s+url="([^"]*)"[^>]*\/>/g, (_all, url: string) => `[Notion 链接预览](${url})`);
  s = s.replace(/<page\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/page>/g, (_all, url: string, label: string) =>
    `[Notion 子页面：${label.trim()}](${url})`,
  );
  return s;
}

/** 写入 Notion 的正文（v2 Markdown）。 */
export function toNotionMarkdown(markdown: string, resources: PluginResource[]): string {
  return prepareImagesForV2(replaceLocalRefs(markdown ?? "", resources));
}

/** 从 Notion 读回并写入 EdgeEver 的正文。 */
export function toEdgeeverMarkdown(markdown: string, resources: PluginResource[]): string {
  const stripped = stripAttachmentSection(markdown ?? "");
  return preserveUnknownTags(restorePlaceholders(stripped.text, resources));
}

/**
 * 两端统一的「可比较内容」：剥离附件区 + 本地引用/占位归一 + 排版规范化。
 * 只有这个函数的结果才进入内容 Hash（规范 §9.3：不混入同步时间、Page ID 等元数据）。
 */
export function canonicalContent(markdown: string, resources: PluginResource[]): string {
  const stripped = stripAttachmentSection(markdown ?? "").text;
  return normalizeMarkdown(replaceLocalRefs(preserveUnknownTags(stripped), resources));
}
