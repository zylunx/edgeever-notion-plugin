import type { PluginContext, PluginSettings, PropertyNames } from "../types";
import { asBool, asNumber, asString } from "../util";
import { loadSetupRecord } from "../sync/setup-store";

export const SETTINGS_DEFAULTS = {
  apiBaseUrl: "https://api.notion.com",
  notionVersion: "2026-03-11",
  markdownVersion: "v2",
  direction: "bidirectional",
  autoSync: false,
  autoSyncDelaySec: 60,
  uploadAttachments: false,
  maxAttachmentMB: 5,
} as const;

export const DEFAULT_PROPS: PropertyNames = {
  name: "Name",
  edgeeverId: "EdgeEver ID",
  notebookId: "EdgeEver Notebook ID",
  tags: "Tags",
  contentHash: "Content Hash",
  lastSynced: "Last Synced",
  syncStatus: "Sync Status",
  edgeeverUpdated: "EdgeEver Updated At",
};

/**
 * 读取宿主设置。Token 只通过两条 Secret 通道读取：
 *  1) context.secrets（本地加密凭据区，推荐）
 *  2) manifest 中 type: "secret" 的设置字段（宿主加密保存、不明文回显）
 * 绝不把 Token 写入 context.storage，也不写入普通设置字段。
 */
export async function loadSettings(ctx: PluginContext): Promise<PluginSettings> {
  const get = async (key: string): Promise<unknown> => {
    try {
      return await ctx.settings.get(key);
    } catch {
      return undefined;
    }
  };

  let token = "";
  try {
    token = asString(await ctx.secrets.get("notion-token"), "").trim();
  } catch {
    /* 宿主可能未开放 secrets，回退到 secret 类型设置 */
  }
  if (!token) token = asString(await get("notion-token"), "").trim();

  const mdRaw = asString(await get("markdown-version"), SETTINGS_DEFAULTS.markdownVersion);
  const dirRaw = asString(await get("sync-direction"), SETTINGS_DEFAULTS.direction);
  const manualDataSourceId = asString(await get("notion-data-source-id"), "").trim();
  const manualDatabaseId = asString(await get("notion-database-id"), "").trim();
  // 一键生成的 Data Source ID 只保存在插件 storage：手写配置始终优先，避免旧记录覆盖用户新填的库。
  const generated = !manualDataSourceId && !manualDatabaseId ? await loadSetupRecord(ctx) : undefined;

  const props: PropertyNames = {
    name: asString(await get("prop-name"), DEFAULT_PROPS.name).trim() || DEFAULT_PROPS.name,
    edgeeverId: asString(await get("prop-edgeever-id"), DEFAULT_PROPS.edgeeverId).trim() || DEFAULT_PROPS.edgeeverId,
    notebookId: asString(await get("prop-notebook-id"), DEFAULT_PROPS.notebookId).trim(),
    tags: asString(await get("prop-tags"), DEFAULT_PROPS.tags).trim(),
    contentHash: asString(await get("prop-content-hash"), DEFAULT_PROPS.contentHash).trim(),
    lastSynced: asString(await get("prop-last-synced"), DEFAULT_PROPS.lastSynced).trim(),
    syncStatus: asString(await get("prop-sync-status"), DEFAULT_PROPS.syncStatus).trim(),
    edgeeverUpdated: asString(await get("prop-edgeever-updated"), DEFAULT_PROPS.edgeeverUpdated).trim(),
  };

  return {
    token,
    databaseId: manualDatabaseId,
    dataSourceId: manualDataSourceId || generated?.dataSourceId || "",
    dataSourceIdSource: manualDataSourceId || manualDatabaseId ? "manual" : generated ? "generated" : "none",
    parentPageId: asString(await get("notion-parent-page-id"), "").trim(),
    apiBaseUrl:
      asString(await get("api-base-url"), SETTINGS_DEFAULTS.apiBaseUrl).trim().replace(/\/+$/, "") ||
      SETTINGS_DEFAULTS.apiBaseUrl,
    notionVersion:
      asString(await get("notion-version"), SETTINGS_DEFAULTS.notionVersion).trim() || SETTINGS_DEFAULTS.notionVersion,
    markdownVersion: mdRaw === "v1" ? "v1" : "v2",
    notebookId: asString(await get("sync-notebook-id"), "").trim(),
    direction: dirRaw === "push" || dirRaw === "pull" ? dirRaw : "bidirectional",
    props,
    autoSync: asBool(await get("auto-sync"), SETTINGS_DEFAULTS.autoSync),
    autoSyncDelaySec: Math.max(5, asNumber(await get("auto-sync-delay-sec"), SETTINGS_DEFAULTS.autoSyncDelaySec)),
    uploadAttachments: asBool(await get("upload-attachments"), SETTINGS_DEFAULTS.uploadAttachments),
    maxAttachmentMB: Math.max(0.1, asNumber(await get("max-attachment-mb"), SETTINGS_DEFAULTS.maxAttachmentMB)),
  };
}

/** 返回可读的配置错误；null 表示可以继续。 */
export function validateSettings(s: PluginSettings): string | null {
  if (!s.token) return "请先在插件设置中填写 Notion Integration Token（secret 字段）";
  if (!s.dataSourceId && !s.databaseId) {
    return "请先点击同步面板的「一键生成同步数据库」（需先在设置中填写 Notion 父页面 ID），或手动填写 Data Source ID / 数据库 ID";
  }
  if (!/^https:\/\//i.test(s.apiBaseUrl) && !/^http:\/\/localhost/i.test(s.apiBaseUrl)) {
    return "API 基础地址必须使用 https（本地调试可用 http://localhost）";
  }
  if (!s.notebookId) return "请先在同步面板中选择要同步的 EdgeEver 笔记本";
  return null;
}

export function isCustomApiBase(s: PluginSettings): boolean {
  return s.apiBaseUrl.replace(/\/+$/, "") !== SETTINGS_DEFAULTS.apiBaseUrl;
}
