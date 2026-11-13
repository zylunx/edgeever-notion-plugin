import type { NotionClient } from "./client";
import type { NotionPage, NotionPropertyValue, NotionRichText, PluginSettings } from "../types";

function richText(content: string): Array<{ text: { content: string } }> {
  // 官方限制：单个 rich_text item 的 text.content ≤ 2000 字符
  const parts: string[] = [];
  for (let i = 0; i < content.length; i += 1900) parts.push(content.slice(i, i + 1900));
  if (parts.length === 0) parts.push("");
  return parts.map((c) => ({ text: { content: c } }));
}

export interface PropertyInput {
  title?: string;
  edgeeverId?: string;
  notebookId?: string;
  tags?: string[];
  contentHash?: string;
  lastSynced?: string;
  syncStatus?: string;
  edgeeverUpdated?: string;
}

function propMap(s: PluginSettings, input: PropertyInput): Record<string, unknown> {
  const p = s.props;
  const out: Record<string, unknown> = {};
  if (input.title !== undefined && p.name) out[p.name] = { title: richText(input.title) };
  if (input.edgeeverId !== undefined && p.edgeeverId) out[p.edgeeverId] = { rich_text: richText(input.edgeeverId) };
  if (input.notebookId !== undefined && p.notebookId) out[p.notebookId] = { rich_text: richText(input.notebookId) };
  if (input.contentHash !== undefined && p.contentHash) out[p.contentHash] = { rich_text: richText(input.contentHash) };
  if (input.tags !== undefined && p.tags) {
    out[p.tags] = { multi_select: input.tags.slice(0, 100).map((name) => ({ name })) };
  }
  if (input.syncStatus !== undefined && p.syncStatus) {
    out[p.syncStatus] = { select: { name: input.syncStatus } };
  }
  if (input.lastSynced !== undefined && p.lastSynced) out[p.lastSynced] = { date: { start: input.lastSynced } };
  if (input.edgeeverUpdated !== undefined && p.edgeeverUpdated) {
    out[p.edgeeverUpdated] = { date: { start: input.edgeeverUpdated } };
  }
  return out;
}

/** 必需属性：标题 + EdgeEver ID。创建页面时只写这两项，降低 schema 不匹配风险。 */
export function requiredProperties(s: PluginSettings, title: string, edgeeverId: string): Record<string, unknown> {
  return propMap(s, { title, edgeeverId });
}

/** 可选元数据属性：单独一次 PATCH，失败只记警告、不阻断正文同步。 */
export function optionalProperties(s: PluginSettings, input: PropertyInput): Record<string, unknown> {
  const all = propMap(s, input);
  delete all[s.props.name];
  delete all[s.props.edgeeverId];
  return all;
}

export async function createPage(
  client: NotionClient,
  settings: PluginSettings,
  dataSourceId: string,
  input: { title: string; edgeeverId: string; markdown?: string },
): Promise<NotionPage> {
  const body: Record<string, unknown> = {
    parent: { data_source_id: dataSourceId },
    properties: requiredProperties(settings, input.title, input.edgeeverId),
    notifications: { mode: "silent" },
  };
  // 官方支持创建页面时直接带 markdown（与 content/children 互斥）
  if (input.markdown) {
    body.markdown = input.markdown;
    body.markdown_version = settings.markdownVersion;
  }
  return client.request<NotionPage>("POST", "/v1/pages", body);
}

export async function retrievePage(client: NotionClient, pageId: string): Promise<NotionPage> {
  return client.request<NotionPage>("GET", `/v1/pages/${encodeURIComponent(pageId)}`);
}

export async function patchProperties(
  client: NotionClient,
  pageId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(properties).length === 0) return;
  await client.request<NotionPage>("PATCH", `/v1/pages/${encodeURIComponent(pageId)}`, {
    properties,
    notifications: { mode: "silent" },
  });
}

export function plainText(prop: NotionPropertyValue | undefined): string {
  if (!prop) return "";
  const items: NotionRichText[] = prop.title ?? prop.rich_text ?? [];
  return items
    .map((it) => it.plain_text ?? it.text?.content ?? "")
    .join("");
}

export function readTitle(page: NotionPage, propertyName: string): string {
  const props = page.properties ?? {};
  const named = props[propertyName];
  if (named) return plainText(named);
  // 兼容属性名被用户改过的情况：取第一个 title 类型属性
  for (const value of Object.values(props)) {
    if (value?.type === "title") return plainText(value);
  }
  return "";
}

export function readTags(prop: NotionPropertyValue | undefined): string[] {
  if (!prop?.multi_select) return [];
  return prop.multi_select.map((o) => o.name ?? "").filter(Boolean);
}

export function isRemoteDeleted(page: NotionPage): boolean {
  return page.in_trash === true || page.is_archived === true;
}
