import type { PluginContext, PluginSettings, PropertyNames } from "../types";
import { asBool, asString } from "../util";
import { loadNotebookSelection } from "../sync/mapping";
import { loadSetupRecord } from "../sync/setup-store";

/**
 * 内部固定值：不再暴露在插件设置界面（用户无需理解 Data Source / API 版本 / Markdown 版本 / 属性名）。
 * Data Source ID 由「一键生成同步数据库」自动写入 context.storage 并从这里读取。
 */
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

/**
 * Notion 属性名固定，且只包含「用户可见列 + 幂等必需的内部键」。
 * Content Hash / Sync Status / EdgeEver Notebook ID 等技术列不再创建：
 * 双基线 Hash 与同步状态本来就在本地 context.storage 的映射表里。
 * 官方 OpenAPI 的 initialDataSourceRequest 只有 properties，没有视图列可见性字段，
 * 因此「隐藏」通过不创建这些列实现，而不是假装 API 能设置 visible。
 */
export const FIXED_PROPS: PropertyNames = {
  name: "Name",
  tags: "Tags",
  notebook: "Notebook",
  edgeeverUpdated: "EdgeEver Updated At",
  lastSynced: "Last Synced",
  edgeeverId: "EdgeEver ID",
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

  // 一键生成的数据库信息只存在 context.storage，不占设置界面、也不需要用户复制 ID。
  const generated = await loadSetupRecord(ctx);
  const dirRaw = asString(await get("sync-direction"), SETTINGS_DEFAULTS.direction);

  return {
    token,
    dataSourceId: generated?.dataSourceId ?? "",
    dataSourceIdSource: generated ? "generated" : "none",
    databaseId: generated?.databaseId ?? "",
    parentPageId: asString(await get("notion-parent-page-id"), "").trim(),
    apiBaseUrl: SETTINGS_DEFAULTS.apiBaseUrl,
    notionVersion: SETTINGS_DEFAULTS.notionVersion,
    markdownVersion: SETTINGS_DEFAULTS.markdownVersion,
    notebookIds: await loadNotebookSelection(ctx),
    direction: dirRaw === "push" || dirRaw === "pull" ? dirRaw : "bidirectional",
    props: FIXED_PROPS,
    autoSync: asBool(await get("auto-sync"), SETTINGS_DEFAULTS.autoSync),
    autoSyncDelaySec: SETTINGS_DEFAULTS.autoSyncDelaySec,
    uploadAttachments: asBool(await get("upload-attachments"), SETTINGS_DEFAULTS.uploadAttachments),
    maxAttachmentMB: SETTINGS_DEFAULTS.maxAttachmentMB,
  };
}

/** 返回可读的配置错误；null 表示可以继续。未选择笔记本时默认同步全部笔记本。 */
export function validateSettings(s: PluginSettings): string | null {
  if (!s.token) return "请先在插件设置中填写 Notion Integration Token（secret 字段）";
  if (!s.dataSourceId) {
    return "请先点击「一键生成同步数据库」（需先在设置中填写 Notion 父页面 ID）；Data Source ID 会由插件自动保存，无需手动填写";
  }
  return null;
}
