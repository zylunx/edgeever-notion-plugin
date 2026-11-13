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
  /** 官方 commands.register 的 run() 不接收参数；当前笔记通过文档化的 getDocument() 做防御性探测。 */
  editor?: {
    getDocument(): Promise<unknown>;
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

/** 映射结构；额外保留两条基线 Hash，避免 Notion 回读改写造成误判。 */
export interface NoteMapping {
  edgeeverNoteId: string;
  notionPageId: string;
  edgeeverNotebookId?: string;
  /** 上次成功同步的基线（规范化正文 Hash）。 */
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

/**
 * Notion 属性名固定，不暴露给用户配置。
 * 只保留用户可见列 + 幂等必需的 EdgeEver ID；Hash 等技术值只存本地 storage。
 * Notion 公开 API 不提供视图列可见性配置，因此「隐藏」通过不创建这些列实现。
 */
export interface PropertyNames {
  name: string;
  tags: string;
  /** 笔记本名称（select），便于在 Notion 里按笔记本筛选。 */
  notebook: string;
  edgeeverUpdated: string;
  lastSynced: string;
  /** 内部幂等键：storage 丢失时用于反查页面，避免重复创建。 */
  edgeeverId: string;
}

export interface PluginSettings {
  /** 仅从 context.secrets / secret 类型设置读取，绝不进入 storage 或日志。 */
  token: string;
  /** 一键建库后自动保存在 context.storage，用户无需配置。 */
  dataSourceId: string;
  dataSourceIdSource: "generated" | "none";
  databaseId: string;
  /** 一键建库用的 Notion 父页面 ID（可粘贴页面链接）。 */
  parentPageId: string;
  /** 内部固定，不再暴露为设置项。 */
  apiBaseUrl: string;
  notionVersion: string;
  markdownVersion: "v1" | "v2";
  /** 面板里选择的笔记本（单个或多个）；空数组表示全部笔记本。存在 context.storage。 */
  notebookIds: string[];
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
  /** 笔记所属笔记本 ID 与名称，用于写入 Notion 的 Notebook 属性。 */
  notebookId?: string;
  notebookName?: string;
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
