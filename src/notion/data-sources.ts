import type { NotionClient } from "./client";
import type { NotionList, NotionPage, PluginSettings } from "../types";
import { NotionError } from "./client";

/** 2025-09-03 之后 Database 只是容器，查询/写入必须使用 data_source_id。 */
export async function resolveDataSourceId(client: NotionClient, settings: PluginSettings): Promise<string> {
  if (settings.dataSourceId) return settings.dataSourceId;
  if (!settings.databaseId) {
    throw new NotionError("未配置 Data Source ID 或数据库 ID。");
  }
  const db = await client.request<{ id?: string; data_sources?: Array<{ id?: string; name?: string }> }>(
    "GET",
    `/v1/databases/${encodeURIComponent(settings.databaseId)}`,
  );
  const first = db.data_sources?.find((s) => typeof s.id === "string" && s.id.length > 0);
  if (!first?.id) {
    throw new NotionError(
      "已读取到数据库，但没有可用的 Data Source。请确认该数据库已与 Integration 建立连接，或直接填写 Data Source ID。",
    );
  }
  return first.id;
}

export interface ConnectionInfo {
  botName?: string;
  workspaceName?: string;
  maxFileUploadBytes?: number;
  dataSourceId: string;
  pageCountSample: number;
}

/**
 * 规范 §6.1：GET /users/me 只能证明 Token 有效，还必须验证目标 Data Source 可访问。
 */
export async function verifyConnection(client: NotionClient, dataSourceId: string): Promise<ConnectionInfo> {
  const me = await client.request<{
    name?: string;
    bot?: { workspace_name?: string; workspace_limits?: { max_file_upload_size_in_bytes?: number } };
  }>("GET", "/v1/users/me");

  const sample = await client.request<NotionList<NotionPage>>(
    "POST",
    `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
    { page_size: 1, result_type: "page" },
  );

  return {
    botName: me.name,
    workspaceName: me.bot?.workspace_name,
    maxFileUploadBytes: me.bot?.workspace_limits?.max_file_upload_size_in_bytes,
    dataSourceId,
    pageCountSample: Array.isArray(sample.results) ? sample.results.length : 0,
  };
}

export interface QueryResult {
  pages: NotionPage[];
  incomplete: boolean;
}

/** 分页查询；cursor 一律原样回传，不解析（官方明确要求视为不透明值）。 */
export async function queryAllPages(
  client: NotionClient,
  dataSourceId: string,
  options: { filter?: unknown; pageSize?: number; archived?: boolean } = {},
): Promise<QueryResult> {
  const pages: NotionPage[] = [];
  let cursor: string | null = null;
  let incomplete = false;

  do {
    const body: Record<string, unknown> = {
      page_size: options.pageSize ?? 100,
      result_type: "page",
    };
    if (cursor) body.start_cursor = cursor;
    if (options.filter) body.filter = options.filter;
    if (options.archived) body.is_archived = true;

    const res = await client.request<NotionList<NotionPage>>(
      "POST",
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      body,
    );
    if (Array.isArray(res.results)) pages.push(...res.results.filter((p) => p && typeof p.id === "string"));
    if (res.request_status?.type === "incomplete") incomplete = true;
    cursor = res.has_more && typeof res.next_cursor === "string" ? res.next_cursor : null;
  } while (cursor);

  return { pages, incomplete };
}

/** 按 EdgeEver ID 查询远端页面（缺少本地映射时用于修复映射，避免重复创建）。 */
export async function findPageByEdgeeverId(
  client: NotionClient,
  dataSourceId: string,
  propertyName: string,
  edgeeverId: string,
): Promise<NotionPage | undefined> {
  const { pages } = await queryAllPages(client, dataSourceId, {
    filter: { property: propertyName, rich_text: { equals: edgeeverId } },
    pageSize: 10,
  });
  return pages[0];
}
