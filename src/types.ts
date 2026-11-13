/**
 * 类型定义。
 *
 * EdgeEver 侧类型按官方插件开发文档（docs/plugin-development.zh-CN.md）中
 * 可确认的调用形式与返回结构定义；未展开的部分用宽松类型 + 运行时防御处理。
 * Notion 侧类型按 2026-03-11 版官方 API 参考定义，响应解析一律忽略未知字段。
 */

// ---------------------------------------------------------------- EdgeEver

export interface PluginNoteSummary {
  id: string;
  title?: string;
  kind?: string;
  notebookId?: string;
  notebook_id?: string;
  tags?: string[];
  updatedAt?: string;
  updated_at?: string;
  createdAt?: string;
  revision?: number | string;
  contentHash?: string;
  deletedAt?: string | null;
}

export interface PluginNote extends PluginNoteSummary {
  contentMarkdown?: string;
  contentJson?: unknown;
}

export interface PluginNotebook {
  id: string;
  name?: string;
  title?: string;
  parentId?: string | null;
}

export interface PluginResource {
  id: string;
  name?: string;
  filename?: string;
  fileName?: string;
  mimeType?: string;
  mime?: string;
  size?: number;
  contentHash?: string;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface PanelShell {
  set(config: unknown): void;
}

export interface PanelMountArgs {
  shell: PanelShell;
  requestClose(): void;
  state?: Record<string, unknown>;
}

export interface PluginContext {
  notes: {
    query(options?: Record<string, unknown>): Promise<{
      notes: PluginNoteSummary[];
      totalCount?: number;
      nextOffset?: number | null;
    }>;
    queryContent(options?: Record<string, unknown>): Promise<PluginNote[] | { notes: PluginNote[] }>;
    get(noteId: string): Promise<PluginNote | null>;
    create(input: Record<string, unknown>): Promise<PluginNote>;
    update(noteId: string, patch: Record<string, unknown>): Promise<PluginNote>;
    delete(noteId: string, options?: Record<string, unknown>): Promise<unknown>;
    restore(noteId: string): Promise<unknown>;
  };
  notebooks: { list(): Promise<PluginNotebook[]> };
  tags: { list(): Promise<unknown[]> };
  resources: {
    list(noteId: string): Promise<PluginResource[]>;
    read(resourceId: string): Promise<Blob | ArrayBuffer | Uint8Array | { data: ArrayBuffer | Uint8Array }>;
  };
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  };
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  };
  secrets: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  };
  network: {
    fetch(url: string, options?: Record<string, unknown>): Promise<FetchLikeResponse>;
  };
  events: {
    on(event: string, handler: (payload: unknown) => void): () => void;
  };
  commands: {
    register(command: { id: string; title: string; listed?: boolean; menu?: boolean; run: () => unknown }): () => void;
  };
  ui: {
    showNotice(message: string): void;
    openNote(noteId: string, options?: Record<string, unknown>): Promise<unknown>;
    panels: {
      register(panel: {
        id: string;
        title: string;
        purpose?: string;
        presentation?: string;
        mount(container: HTMLElement, args: PanelMountArgs): (() => void) | void;
        beforeClose?(): boolean | unknown;
      }): () => void;
      open(id: string, args?: Record<string, unknown>): Promise<unknown>;
    };
  };
}

// ------------------------------------------------------------------ Notion

export interface NotionRichText {
  type?: string;
  plain_text?: string;
  text?: { content?: string; link?: { url?: string } | null };
  href?: string | null;
}

export interface NotionPropertyValue {
  id?: string;
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  multi_select?: Array<{ id?: string; name?: string; color?: string }>;
  select?: { id?: string; name?: string; color?: string } | null;
  date?: { start?: string; end?: string | null } | null;
  number?: number | null;
  [key: string]: unknown;
}

export interface NotionPage {
  object?: string;
  id: string;
  created_time?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  is_archived?: boolean;
  is_locked?: boolean;
  url?: string;
  parent?: { type?: string; data_source_id?: string; database_id?: string; page_id?: string };
  properties?: Record<string, NotionPropertyValue>;
  [key: string]: unknown;
}

export interface NotionMarkdown {
  object?: string;
  id?: string;
  markdown?: string;
  truncated?: boolean;
  unknown_block_ids?: string[];
  warnings?: Array<{ code?: string; message?: string }>;
  [key: string]: unknown;
}

export interface NotionList<T> {
  object?: string;
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
  request_status?: { type?: string; incomplete_reason?: string };
  [key: string]: unknown;
}

export interface NotionFileUpload {
  object?: string;
  id: string;
  status?: "pending" | "uploaded" | "expired" | "failed";
  upload_url?: string;
  filename?: string | null;
  content_type?: string | null;
  expiry_time?: string | null;
  [key: string]: unknown;
}

// ------------------------------------------------------------- plugin state

/** 文档 §5.2 的映射结构；额外保留两条基线 Hash，避免 Notion 回读改写造成误判。 */
export interface NoteMapping {
  edgeeverNoteId: string;
  notionPageId: string;
  edgeeverNotebookId?: string;
  /** 上次成功同步的基线（规范化正文 Hash），兼容文档 §9.3 的 B。 */
  lastSyncedHash: string;
  lastSyncedAt: string;
  /** 上次成功同步时 EdgeEver 侧规范化正文 Hash。 */
  lastEdgeEverHash?: string;
  /** 上次成功同步时 Notion 侧规范化正文 Hash。 */
  lastNotionHash?: string;
  status: "synced" | "conflict" | "error" | "deleted";
  title?: string;
  deletedAt?: string;
  lastError?: string;
}

export interface ResourceMapping {
  edgeeverResourceId: string;
  notionFileUploadId?: string;
  notionFileUrl?: string;
  notionBlockId?: string;
  sha256: string;
  filename: string;
  mimeType: string;
  status: "pending" | "uploaded" | "attached" | "failed";
  error?: string;
}

export interface PropertyNames {
  name: string;
  edgeeverId: string;
  notebookId: string;
  tags: string;
  contentHash: string;
  lastSynced: string;
  syncStatus: string;
  edgeeverUpdated: string;
}

export interface PluginSettings {
  /** 仅从 context.secrets / secret 类型设置读取，绝不进入 storage 或日志。 */
  token: string;
  databaseId: string;
  dataSourceId: string;
  /** 区分手写配置与一键生成后自动保存的配置。 */
  dataSourceIdSource: "manual" | "generated" | "none";
  /** 一键建库用的 Notion 父页面 ID（可粘贴页面链接）。 */
  parentPageId: string;
  apiBaseUrl: string;
  notionVersion: string;
  markdownVersion: "v1" | "v2";
  notebookId: string;
  direction: "bidirectional" | "push" | "pull";
  props: PropertyNames;
  autoSync: boolean;
  autoSyncDelaySec: number;
  uploadAttachments: boolean;
  maxAttachmentMB: number;
}

export type SyncAction =
  | "create-notion"
  | "update-notion"
  | "create-edgeever"
  | "update-edgeever"
  | "skip"
  | "conflict"
  | "unsupported"
  | "incomplete"
  | "deleted"
  | "error";

export type ConflictResolution = "edgeever" | "notion" | "later";

export interface SyncPlanItem {
  key: string;
  action: SyncAction;
  title: string;
  reason: string;
  edgeeverNoteId?: string;
  notionPageId?: string;
  edgeeverHash?: string;
  notionHash?: string;
  baselineHash?: string;
  resolution?: ConflictResolution;
  /** apply 阶段需要的内部数据（不写入 storage，不展示给用户）。 */
  note?: PluginNote;
  page?: NotionPage;
  markdown?: string;
  noteTitle?: string;
  tags?: string[];
  resources?: PluginResource[];
  remoteMarkdown?: string;
}

export interface SyncReportItem {
  key: string;
  title: string;
  action: SyncAction;
  message: string;
}

export interface SyncReport {
  startedAt: string;
  finishedAt: string;
  direction: PluginSettings["direction"];
  counts: {
    created: number;
    updated: number;
    skipped: number;
    conflicts: number;
    unsupported: number;
    incomplete: number;
    failed: number;
    deleted: number;
  };
  warnings: string[];
  items: SyncReportItem[];
}
