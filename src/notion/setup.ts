/**
 * 一键生成同步数据库。
 *
 * 官方依据（Notion API 2026-03-11）：
 *  - POST /v1/databases：一次调用创建 database + 首个 data source + 首个 table view；
 *    parent 支持 {"type":"page_id","page_id":"..."}；
 *    initial_data_source.properties 直接给出 schema；
 *    响应 databaseObjectResponse.data_sources[] 携带 data source ID。
 *  - GET  /v1/data_sources/{id}：读取当前 properties schema（每项含 type）。
 *  - PATCH /v1/data_sources/{id}：{"properties":{...}} 只新增缺失属性；
 *    省略的已有属性保持不变，不会改类型、不会删列。
 *  - 权限：建库需要 Insert content；补齐属性需要 Update content；
 *    父页面必须已在 Notion「Connections」中把 Integration 加进去，否则 404。
 *
 * 不推测未文档化的能力：不尝试 workspace 根建库、不自动删除/改类型、
 * 已生成的库再次点击只校验与补属性，绝不重复建库。
 */
import type { NotionClient } from "./client";
import type { PluginContext, PluginSettings, PropertyNames } from "../types";
import { NotionError } from "./client";
import { resolveDataSourceId } from "./data-sources";
import { loadSetupRecord, saveSetupRecord, type SetupRecord } from "../sync/setup-store";
import { errMsg, nowIso, redact } from "../util";

export const DEFAULT_DATABASE_TITLE = "EdgeEver Sync";

interface PropertyConfig {
  title?: Record<string, never>;
  rich_text?: Record<string, never>;
  multi_select?: { options: Array<{ name: string; color?: string }> };
  select?: { options: Array<{ name: string; color?: string }> };
  date?: Record<string, never>;
}

interface DataSourceSchema {
  id?: string;
  properties?: Record<string, { id?: string; name?: string; type?: string; [key: string]: unknown }>;
}

interface DatabaseResponse {
  id?: string;
  url?: string;
  data_sources?: Array<{ id?: string; name?: string }>;
}

export interface SetupResult {
  created: boolean;
  record: SetupRecord;
  addedProperties: string[];
  existingProperties: string[];
  mismatchedProperties: string[];
  message: string;
}

/** 属性 schema（propertyConfigurationRequest）。属性名由设置决定，空名跳过，重名去重。 */
export function desiredProperties(props: PropertyNames): Record<string, PropertyConfig> {
  const out: Record<string, PropertyConfig> = {};
  const put = (name: string, config: PropertyConfig): void => {
    const key = name.trim();
    if (key && !(key in out)) out[key] = config;
  };
  put(props.name, { title: {} });
  put(props.edgeeverId, { rich_text: {} });
  put(props.notebookId, { rich_text: {} });
  put(props.tags, { multi_select: { options: [] } });
  put(props.contentHash, { rich_text: {} });
  put(props.lastSynced, { date: {} });
  put(props.syncStatus, { select: { options: [] } });
  put(props.edgeeverUpdated, { date: {} });
  return out;
}

function expectedType(config: PropertyConfig): string | undefined {
  if (config.title) return "title";
  if (config.rich_text) return "rich_text";
  if (config.multi_select) return "multi_select";
  if (config.select) return "select";
  if (config.date) return "date";
  return undefined;
}

/** 兼容用户直接粘贴 Notion 页面链接（含 32 位 ID 或 p= 参数）。 */
export function normalizeNotionId(raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const fromQuery = u.searchParams.get("p") ?? u.searchParams.get("page_id") ?? u.searchParams.get("d");
      const hex = fromQuery ?? [...u.pathname.matchAll(/[0-9a-f]{32}/gi)].at(-1)?.[0];
      return hex && /^[0-9a-f]{32}$/i.test(hex) ? formatUuid(hex) : "";
    } catch {
      return "";
    }
  }
  const bare = s.replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(bare)) return formatUuid(bare);
  return s;
}

function formatUuid(hex: string): string {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function firstDataSourceId(db: DatabaseResponse | undefined): string {
  return db?.data_sources?.find((d) => typeof d.id === "string" && d.id)?.id ?? "";
}

function setupErrorMessage(e: unknown, token: string): string {
  const status = e instanceof NotionError ? e.status : undefined;
  const detail = redact(errMsg(e), token);
  if (status === 403) {
    return `建库失败：Integration 缺少 Insert content 能力，或未获授权访问该页面。请在 Notion Integration 设置中开启 Read / Update / Insert content，并在父页面「··· → Connections」中添加该 Integration。${detail ? ` 详情：${detail}` : ""}`;
  }
  if (status === 404) {
    return `建库失败：找不到父页面，或 Integration 未获授权访问它。请确认页面 ID 正确，且已在该页面「··· → Connections」中添加 Integration。${detail ? ` 详情：${detail}` : ""}`;
  }
  return `建库失败：${detail}`;
}

function titleRichText(text: string): Array<{ type: "text"; text: { content: string } }> {
  return [{ type: "text", text: { content: text.slice(0, 2000) } }];
}

/**
 * 幂等入口：
 *  - 已有记录 → 只校验 + 补齐缺失属性（不重复建库）
 *  - 无记录 → 用父页面 ID 建库，从响应取 data source ID 并保存
 */
export async function ensureSyncDatabase(
  ctx: PluginContext,
  client: NotionClient,
  settings: PluginSettings,
): Promise<SetupResult> {
  if (!settings.token) throw new Error("请先在插件设置中填写 Notion Integration Token（secret 字段）。");

  const desired = desiredProperties(settings.props);
  const previous = await loadSetupRecord(ctx);
  let created = false;
  let saveRecord = true;
  let usedManualTarget = false;
  let databaseId = "";
  let dataSourceId = "";
  let databaseUrl: string | undefined;
  let parentPageId = "";

  if (settings.dataSourceIdSource === "manual") {
    // 用户在设置里手写了目标：只校验并补齐属性，不新建、不写入自动生成记录。
    usedManualTarget = true;
    saveRecord = false;
    dataSourceId = settings.dataSourceId || (await resolveDataSourceId(client, settings));
    databaseId = settings.databaseId;
  } else if (previous) {
    // 幂等：已生成过，先确认仍可访问。不可访问时不自动新建，避免产生重复数据库。
    try {
      await client.request<DataSourceSchema>(
        "GET",
        `/v1/data_sources/${encodeURIComponent(previous.dataSourceId)}`,
      );
    } catch (e) {
      throw new Error(
        `已生成的同步数据库无法访问（Notion API ${e instanceof NotionError ? e.status ?? "错误" : "错误"}）。请确认 Integration 仍有访问权限；如数据库已被删除或取消共享，请先清空插件数据再重新生成。为避免重复建库，插件不会自动新建。${redact(errMsg(e), settings.token)}`,
      );
    }
    databaseId = previous.databaseId;
    dataSourceId = previous.dataSourceId;
    databaseUrl = previous.databaseUrl;
    parentPageId = previous.parentPageId;
  } else {
    parentPageId = normalizeNotionId(settings.parentPageId);
    if (!parentPageId) {
      throw new Error("请先在插件设置中填写「Notion 父页面 ID」（可粘贴页面链接），再点击一键生成。");
    }

    let db: DatabaseResponse;
    try {
      db = await client.request<DatabaseResponse>("POST", "/v1/databases", {
        parent: { type: "page_id", page_id: parentPageId },
        title: titleRichText(DEFAULT_DATABASE_TITLE),
        is_inline: false,
        initial_data_source: { properties: desired },
      });
    } catch (e) {
      throw new Error(setupErrorMessage(e, settings.token));
    }

    databaseId = typeof db.id === "string" ? db.id : "";
    databaseUrl = typeof db.url === "string" ? db.url : undefined;
    dataSourceId = firstDataSourceId(db);
    if (!dataSourceId && databaseId) {
      // 响应可能是 partialDatabaseObjectResponse（仅 object + id），回退读完整对象。
      try {
        const full = await client.request<DatabaseResponse>(
          "GET",
          `/v1/databases/${encodeURIComponent(databaseId)}`,
        );
        dataSourceId = firstDataSourceId(full);
      } catch (e) {
        throw new Error(`数据库已创建，但读取其 Data Source 失败：${redact(errMsg(e), settings.token)}`);
      }
    }
    if (!dataSourceId || !databaseId) {
      throw new Error("数据库已创建，但 Notion 响应中没有可用的 Data Source ID，请在 Notion 中检查该数据库后重试。");
    }
    created = true;
  }

  // 读取真实 schema：只补缺失属性，类型不符只警告、不改类型（改类型可能破坏已有值）。
  const schema = await client.request<DataSourceSchema>(
    "GET",
    `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
  );
  const existing = schema.properties ?? {};
  const missing: Record<string, PropertyConfig> = {};
  const existingProperties: string[] = [];
  const mismatchedProperties: string[] = [];
  for (const [name, config] of Object.entries(desired)) {
    const current = existing[name];
    if (!current) {
      missing[name] = config;
      continue;
    }
    existingProperties.push(name);
    const want = expectedType(config);
    if (want && current.type && current.type !== want) {
      mismatchedProperties.push(`${name}（当前 ${current.type}，需要 ${want}）`);
    }
  }
  const addedProperties = Object.keys(missing);
  if (addedProperties.length) {
    await client.request<DataSourceSchema>(
      "PATCH",
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
      { properties: missing },
    );
  }

  const record: SetupRecord = {
    databaseId,
    dataSourceId,
    parentPageId,
    databaseUrl,
    databaseTitle: DEFAULT_DATABASE_TITLE,
    createdAt: previous?.createdAt || nowIso(),
    propertyNames: Object.keys(desired),
  };
  if (saveRecord) await saveSetupRecord(ctx, record);

  const parts: string[] = [];
  parts.push(
    usedManualTarget
      ? "检测到设置里手动指定的 Data Source，未新建数据库。"
      : created
        ? `已在父页面下创建同步数据库「${DEFAULT_DATABASE_TITLE}」，Data Source ID 已自动保存，无需手动复制。`
        : "已检测到此前生成的同步数据库，未重复创建。",
  );
  parts.push(addedProperties.length ? `新增属性：${addedProperties.join("、")}。` : "所需属性已齐全。");
  if (mismatchedProperties.length) {
    parts.push(`以下属性类型不匹配，插件不会自动修改，请手动调整：${mismatchedProperties.join("；")}。`);
  }
  parts.push("现在可以「测试连接 → 生成预览 → 执行同步」。");
  return {
    created,
    record,
    addedProperties,
    existingProperties,
    mismatchedProperties,
    message: parts.join(""),
  };
}
