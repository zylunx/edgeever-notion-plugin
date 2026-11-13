/**
 * EdgeEver 宿主 + Notion API 的 Mock 环境。
 * 仅用于本地冒烟测试，不参与打包。
 */
import assert from "node:assert/strict";

// 仅在测试中压缩请求队列的最小间隔（生产环境为 340ms），不改动插件代码。
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, Math.min(Number(ms) || 0, 5), ...args);

const DS_ID = "ds-00000001";
export const TOKEN = "ntn_test_token_abcdefghijklmnopqrstuvwxyz";

function json(data, status = 200, headers = {}) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? String(headers[key]) : null;
      },
    },
    text: async () => text,
    json: async () => data,
  };
}

class FakeElement {
  constructor() {
    this.className = "";
    this.innerHTML = "";
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.checked = false;
    this.value = "";
  }
  append(el) { this.children.push(el); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((h) => h !== handler);
  }
  remove() { this.removed = true; }
}

function installFakeDom() {
  if (!globalThis.document) {
    globalThis.document = { createElement: () => new FakeElement() };
  }
}

const DEFAULT_NOTES = [
  {
    id: "note-1",
    title: "第一篇笔记",
    kind: "text",
    notebookId: "nb-1",
    tags: ["工作"],
    contentMarkdown: "# 标题\n\n正文第一段。",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "note-2",
    title: "思维导图",
    kind: "mind-map",
    notebookId: "nb-1",
    tags: [],
    contentMarkdown: "{\"nodes\":[]}",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "note-3",
    title: "带附件的笔记",
    kind: "text",
    notebookId: "nb-1",
    tags: [],
    contentMarkdown: "文字\n\n![日出](edgeever://res-1)\n\n结尾",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

/** 设置界面只保留 5 项；Data Source ID / 属性名 / API 地址都由插件内部管理。 */
const DEFAULT_SETTINGS = {
  "notion-token": TOKEN,
  "notion-parent-page-id": "",
  "sync-direction": "bidirectional",
  "auto-sync": false,
  "upload-attachments": false,
};

/** 精简后的 schema：只有用户可见列 + 幂等必需的 EdgeEver ID。 */
function defaultSchema() {
  return {
    Name: { type: "title", title: {} },
    Tags: { type: "multi_select", multi_select: { options: [] } },
    Notebook: { type: "select", select: { options: [] } },
    "EdgeEver Updated At": { type: "date", date: {} },
    "Last Synced": { type: "date", date: {} },
    "EdgeEver ID": { type: "rich_text", rich_text: {} },
  };
}

function richTextValue(text) {
  return { rich_text: [{ plain_text: text, text: { content: text } }], type: "rich_text" };
}
function titleValue(text) {
  return { title: [{ plain_text: text, text: { content: text } }], type: "title" };
}

export function createMockContext(options = {}) {
  installFakeDom();

  const state = {
    settings: { ...DEFAULT_SETTINGS, ...(options.settings || {}) },
    secrets: new Map(options.secrets || []),
    storage: new Map(options.storage || []),
    /** 模拟宿主能否通过 editor.getDocument() 给出当前笔记上下文。 */
    currentNoteId: options.currentNoteId ?? "",
    notes: (options.notes || DEFAULT_NOTES).map((n) => ({ ...n })),
    notebooks: options.notebooks || [{ id: "nb-1", name: "工作" }, { id: "nb-2", name: "个人" }],
    resources: new Map(
      (options.resources || [
        { noteId: "note-3", items: [{ id: "res-1", filename: "sunrise.png", mimeType: "image/png", size: 64 }] },
      ]).map((r) => [r.noteId, r.items]),
    ),
    notion: {
      pages: new Map(),
      pageSeq: 0,
      uploadSeq: 0,
      truncatedIds: new Set(options.truncatedIds || []),
      rateLimitNext: false,
      rateLimitCount: 0,
      pageSizeOverride: options.pageSizeOverride,
      dataSources: new Map([[DS_ID, { id: DS_ID, name: "Notes", properties: defaultSchema() }]]),
      databases: new Map(),
      dbSeq: 0,
      dsSeq: 0,
      createDatabaseCalls: 0,
      patchDataSourceCalls: 0,
      setupForbidden: Boolean(options.setupForbidden),
      setupNotFound: Boolean(options.setupNotFound),
      setupMissingProps: [...(options.setupMissingProps || [])],
      lastCreateBody: null,
      lastPatchBody: null,
    },
    fetchCalls: [],
    notices: [],
    commands: new Map(),
    panels: new Map(),
    events: new Map(),
    panelRoots: [],
    shellConfig: null,
    shellCallbacks: {},
    customFetch: options.fetchImpl || null,
  };

  for (const p of options.pages || []) state.notion.pages.set(p.id, { ...p });

  // 默认模拟「已一键生成过同步数据库」：Data Source ID 存在 context.storage，不需要用户手填。
  // 传 noSetupRecord: true 可模拟全新安装（此时需要点一键生成）。
  if (!options.noSetupRecord && !state.storage.has("notion-sync:setup")) {
    state.storage.set("notion-sync:setup", {
      databaseId: "db-00000001",
      dataSourceId: DS_ID,
      parentPageId: "",
      databaseTitle: "EdgeEver Sync",
      createdAt: "2026-01-01T00:00:00.000Z",
      propertyNames: ["Name", "Tags", "Notebook", "EdgeEver Updated At", "Last Synced", "EdgeEver ID"],
    });
  }

  const ctx = {
    notes: {
      async query(q = {}) {
        const limit = Number(q.limit ?? 200);
        const offset = Number(q.offset ?? 0);
        const all = state.notes.filter((n) => !q.notebookId || n.notebookId === q.notebookId);
        const slice = all.slice(offset, offset + limit);
        const next = offset + limit < all.length ? offset + limit : null;
        return { notes: slice.map((n) => ({ ...n })), totalCount: all.length, nextOffset: next };
      },
      async queryContent() { return state.notes.map((n) => ({ ...n })); },
      async get(id) {
        const n = state.notes.find((x) => x.id === id);
        return n ? { ...n } : null;
      },
      async create(input) {
        const note = {
          id: `note-new-${state.notes.length + 1}`,
          kind: "text",
          notebookId: input.notebookId,
          title: input.title,
          tags: input.tags || [],
          contentMarkdown: input.contentMarkdown || "",
          updatedAt: new Date().toISOString(),
        };
        state.notes.push(note);
        state.noteCreates = (state.noteCreates || 0) + 1;
        return { ...note };
      },
      async update(id, patch) {
        const n = state.notes.find((x) => x.id === id);
        if (!n) throw new Error(`note not found: ${id}`);
        Object.assign(n, patch, { updatedAt: new Date().toISOString() });
        (state.noteUpdates ||= []).push({ id, patch });
        return { ...n };
      },
      async delete() { state.noteDeletes = (state.noteDeletes || 0) + 1; },
      async restore() {},
    },
    notebooks: { async list() { return state.notebooks.map((n) => ({ ...n })); } },
    tags: { async list() { return ["工作", "个人"]; } },
    resources: {
      async list(noteId) { return (state.resources.get(noteId) || []).map((r) => ({ ...r })); },
      async read(resourceId) {
        return new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
      },
    },
    editor: options.noEditor ? undefined : {
      async getDocument() {
        return state.currentNoteId ? { noteId: state.currentNoteId } : null;
      },
    },
    settings: {
      async get(key) { return state.settings[key]; },
      async set(key, value) { state.settings[key] = value; },
      async remove(key) { delete state.settings[key]; },
    },
    storage: {
      async get(key) { return state.storage.get(key); },
      async set(key, value) { state.storage.set(key, value); },
      async remove(key) { state.storage.delete(key); },
    },
    secrets: {
      async get(key) { return state.secrets.get(key); },
      async set(key, value) { state.secrets.set(key, value); },
      async remove(key) { state.secrets.delete(key); },
    },
    network: {
      async fetch(url, opts = {}) {
        state.fetchCalls.push({ url, options: opts });
        if (state.customFetch) {
          const custom = await state.customFetch(url, opts, state);
          if (custom) return custom;
        }
        return handleNotion(url, opts, state);
      },
    },
    events: {
      on(event, handler) {
        if (!state.events.has(event)) state.events.set(event, new Set());
        state.events.get(event).add(handler);
        return () => state.events.get(event)?.delete(handler);
      },
    },
    commands: {
      register(cmd) {
        state.commands.set(cmd.id, cmd);
        return () => state.commands.delete(cmd.id);
      },
    },
    ui: {
      showNotice(message) { state.notices.push(message); },
      async openNote() {},
      panels: {
        register(panel) {
          state.panels.set(panel.id, panel);
          return () => state.panels.delete(panel.id);
        },
        async open(id, args = {}) {
          const panel = state.panels.get(id);
          assert.ok(panel, `panel ${id} should be registered`);
          const container = new FakeElement();
          const shell = {
            set(config) {
              state.shellConfig = config;
              state.shellCallbacks.onAction = config.onAction;
              state.shellCallbacks.onChange = config.onChange;
            },
          };
          const cleanup = panel.mount(container, {
            shell,
            requestClose() {},
            state: args.state,
          });
          state.panelRoots.push({ container, root: container.children[0], cleanup });
          // 等待 mount 内的异步初始化完成
          await Promise.resolve();
          await new Promise((r) => setTimeout(r, 0));
          return undefined;
        },
      },
    },
  };

  state.runCommand = async (id) => {
    const cmd = state.commands.get(id);
    assert.ok(cmd, `command ${id} should be registered`);
    await cmd.run();
  };
  state.emit = async (event, payload) => {
    const handlers = [...(state.events.get(event) || [])];
    await Promise.all(handlers.map((h) => Promise.resolve(h(payload))));
    await new Promise((r) => setTimeout(r, 0));
  };
  state.click = async (action, extra = {}) => {
    const root = state.panelRoots.at(-1)?.root;
    assert.ok(root, "panel root should exist");
    const handlers = root.listeners.click || [];
    for (const h of handlers) {
      await h({ target: { dataset: { action, ...extra } } });
    }
    await waitForIdle(state, root);
  };
  state.change = async (control, extra = {}) => {
    const root = state.panelRoots.at(-1)?.root;
    assert.ok(root, "panel root should exist");
    const handlers = root.listeners.change || [];
    for (const h of handlers) {
      await h({ target: { dataset: { control, ...extra }, ...extra } });
    }
    await waitForIdle(state, root);
  };
  state.notionPageList = () => [...state.notion.pages.values()];
  state.createdDatabases = () => [...state.notion.databases.values()];
  state.dataSourceSchema = (id) => state.notion.dataSources.get(id)?.properties;
  state.setupBody = () => state.notion.lastCreateBody;
  state.storageText = () => JSON.stringify([...state.storage.entries()]);
  state.allText = () =>
    [state.storageText(), JSON.stringify([...state.notices]), JSON.stringify(state.fetchCalls.map((c) => c.url))].join("\n");

  return { ctx, state };
}

/** 等待面板退出忙碌状态，且请求数保持稳定。 */
async function waitForIdle(state, root, timeoutMs = 15000) {
  const started = Date.now();
  let lastCount = -1;
  let stableFor = 0;
  while (Date.now() - started < timeoutMs) {
    const busy = root.innerHTML.includes("ens-busy");
    const count = state.fetchCalls.length;
    if (!busy && count === lastCount) {
      stableFor += 20;
      if (stableFor >= 120) return;
    } else {
      stableFor = 0;
      lastCount = count;
    }
    await new Promise((r) => realSetTimeout(r, 20));
  }
  throw new Error("同步面板在超时时间内未回到空闲状态");
}

async function settle() {
  await new Promise((r) => realSetTimeout(r, 20));
}

function bodyOf(options) {
  if (!options.body || typeof options.body !== "string") return {};
  try { return JSON.parse(options.body); } catch { return {}; }
}

function pageToApi(page) {
  return {
    object: "page",
    id: page.id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    in_trash: Boolean(page.in_trash),
    is_archived: Boolean(page.is_archived),
    is_locked: false,
    url: `https://www.notion.so/${page.id}`,
    parent: { type: "data_source_id", data_source_id: DS_ID },
    properties: page.properties || {},
  };
}

function handleNotion(url, options, state) {
  const u = new URL(url);
  const path = u.pathname;
  const method = (options.method || "GET").toUpperCase();
  const body = bodyOf(options);
  const n = state.notion;

  if (path === "/v1/users/me" && method === "GET") {
    return json({ object: "user", name: "Sync Bot", bot: { workspace_name: "测试工作区", workspace_limits: { max_file_upload_size_in_bytes: 5242880 } } });
  }
  if (path === "/v1/databases" && method === "POST") {
    if (n.setupForbidden) {
      return json({ object: "error", status: 403, code: "restricted_resource", message: "insert content capability required" }, 403);
    }
    if (n.setupNotFound) {
      return json({ object: "error", status: 404, code: "object_not_found", message: "parent page not found" }, 404);
    }
    assert.equal(body.parent?.type, "page_id", "setup must create under a page_id parent");
    assert.ok(body.parent.page_id, "setup must send parent.page_id");
    assert.ok(Array.isArray(body.title) && body.title[0]?.text?.content, "setup must send a title");
    const requested = body.initial_data_source?.properties || {};
    assert.ok(Object.keys(requested).length >= 2, "setup must send initial property schema");
    n.dbSeq++;
    n.dsSeq++;
    const dbId = `db-gen-${n.dbSeq}`;
    const dsId = `ds-gen-${n.dsSeq}`;
    const schema = {};
    for (const [name, cfg] of Object.entries(requested)) {
      const type = Object.keys(cfg)[0];
      schema[name] = { type, [type]: cfg[type] };
    }
    n.dataSources.set(dsId, { id: dsId, name: "EdgeEver Sync", properties: schema });
    n.databases.set(dbId, { id: dbId, dataSources: [dsId], url: `https://www.notion.so/${dbId}` });
    n.createDatabaseCalls++;
    n.lastCreateBody = body;
    return json({
      object: "database",
      id: dbId,
      url: `https://www.notion.so/${dbId}`,
      data_sources: [{ id: dsId, name: "EdgeEver Sync" }],
    });
  }
  if (path.startsWith("/v1/databases/") && method === "GET") {
    const id = decodeURIComponent(path.split("/")[3]);
    const db = n.databases.get(id);
    if (db) {
      return json({
        object: "database",
        id,
        data_sources: db.dataSources.map((dsId) => ({ id: dsId, name: n.dataSources.get(dsId)?.name || "EdgeEver Sync" })),
      });
    }
    return json({ object: "database", id: "db-00000001", data_sources: [{ id: DS_ID, name: "Notes" }] });
  }
  const dsMatch = /^\/v1\/data_sources\/([^/]+)$/.exec(path);
  if (dsMatch && (method === "GET" || method === "PATCH")) {
    const ds = n.dataSources.get(dsMatch[1]);
    if (!ds) return json({ object: "error", status: 404, code: "object_not_found", message: "data source not found" }, 404);
    if (method === "PATCH") {
      for (const [name, cfg] of Object.entries(body.properties || {})) {
        const type = Object.keys(cfg)[0];
        ds.properties[name] = { type, [type]: cfg[type] };
      }
      n.patchDataSourceCalls++;
      n.lastPatchBody = body;
      n.setupMissingProps = []; // 补齐后不再模拟缺失
    }
    const properties = { ...ds.properties };
    for (const name of n.setupMissingProps) delete properties[name];
    return json({ object: "data_source", id: ds.id, name: ds.name, properties });
  }
  const queryMatch = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(path);
  if (queryMatch && method === "POST") {
    if (!n.dataSources.has(queryMatch[1])) {
      return json({ object: "error", status: 404, code: "object_not_found", message: "data source not found" }, 404);
    }
    if (n.rateLimitNext) {
      n.rateLimitNext = false;
      n.rateLimitCount++;
      return json({ object: "error", status: 429, code: "rate_limited", message: "rate limited" }, 429, { "Retry-After": "0" });
    }
    let pages = [...n.pages.values()].filter((p) => !p.in_trash && !p.is_archived);
    const f = body.filter;
    if (f?.property && f?.rich_text?.equals) {
      const wanted = f.rich_text.equals;
      pages = pages.filter((p) => {
        const v = p.properties?.[f.property];
        const text = (v?.rich_text || []).map((r) => r.plain_text ?? r.text?.content ?? "").join("");
        return text === wanted;
      });
    }
    const size = n.pageSizeOverride ?? body.page_size ?? 100;
    const start = body.start_cursor ? Number.parseInt(body.start_cursor, 10) : 0;
    const slice = pages.slice(start, start + size);
    const hasMore = start + size < pages.length;
    return json({
      object: "list",
      results: slice.map(pageToApi),
      has_more: hasMore,
      next_cursor: hasMore ? String(start + size) : null,
      type: "page_or_data_source",
      page_or_data_source: {},
    });
  }
  if (path === "/v1/pages" && method === "POST") {
    n.pageSeq++;
    const id = `page-${String(n.pageSeq).padStart(3, "0")}`;
    const props = body.properties || {};
    const page = {
      id,
      properties: props,
      markdown: typeof body.markdown === "string" ? body.markdown : "",
      in_trash: false,
      is_archived: false,
      children: [],
    };
    n.pages.set(id, page);
    return json(pageToApi(page));
  }

  const mdMatch = /^\/v1\/pages\/([^/]+)\/markdown$/.exec(path);
  if (mdMatch) {
    const page = n.pages.get(mdMatch[1]);
    if (!page) return json({ object: "error", status: 404, code: "object_not_found", message: "not found" }, 404);
    if (method === "GET") {
      if (n.truncatedIds.has(page.id)) {
        return json({ object: "page_markdown", id: page.id, markdown: page.markdown, truncated: true, unknown_block_ids: ["block-unknown-1"], warnings: [] });
      }
      return json({ object: "page_markdown", id: page.id, markdown: page.markdown, truncated: false, unknown_block_ids: [], warnings: [] });
    }
    if (method === "PATCH") {
      assert.equal(body.type, "replace_content", "must use official replace_content command");
      assert.equal(body.markdown_version, "v2", "must request markdown v2");
      assert.equal(body.replace_content.allow_deleting_content, false, "must not delete child pages");
      page.markdown = body.replace_content.new_str ?? "";
      return json({ object: "page_markdown", id: page.id, markdown: page.markdown, truncated: false, unknown_block_ids: [], warnings: [] });
    }
  }

  const childrenMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
  if (childrenMatch && method === "PATCH") {
    const page = n.pages.get(childrenMatch[1]);
    if (!page) return json({ object: "error", status: 404, code: "object_not_found", message: "not found" }, 404);
    const children = body.children || [];
    const lines = children.map((c) => {
      if (c.type === "paragraph") return c.paragraph.rich_text[0].text.content;
      return `![${c.image?.caption?.[0]?.text?.content ?? c.file?.name ?? "media"}](https://files.notion.so/temporary)`;
    });
    page.markdown = `${page.markdown}\n\n${lines.join("\n")}`;
    return json({ object: "list", results: children.map((_, i) => ({ object: "block", id: `block-${n.pageSeq}-${i}`, type: "paragraph" })), has_more: false, next_cursor: null });
  }

  const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(path);
  if (pageMatch) {
    const page = n.pages.get(pageMatch[1]);
    if (!page) return json({ object: "error", status: 404, code: "object_not_found", message: "not found" }, 404);
    if (method === "PATCH") {
      page.properties = { ...(page.properties || {}), ...(body.properties || {}) };
      return json(pageToApi(page));
    }
    return json(pageToApi(page));
  }

  if (path === "/v1/file_uploads" && method === "POST") {
    n.uploadSeq++;
    const id = `fu-${n.uploadSeq}`;
    return json({ object: "file_upload", id, status: "pending", upload_url: `https://api.notion.com/v1/file_uploads/${id}/send`, filename: body.filename, content_type: body.content_type });
  }
  if (/^\/v1\/file_uploads\/([^/]+)\/send$/.test(path) && method === "POST") {
    const id = /^\/v1\/file_uploads\/([^/]+)\/send$/.exec(path)[1];
    return json({ object: "file_upload", id, status: "uploaded", filename: "sunrise.png", content_type: "image/png" });
  }

  return json({ object: "error", status: 404, code: "object_not_found", message: `mock: unhandled ${method} ${path}` }, 404);
}

export function makePage(options = {}) {
  const eeId = options.eeId;
  const properties = options.properties || {};
  if (eeId) properties["EdgeEver ID"] = richTextValue(eeId);
  properties.Name = titleValue(options.title || "远端笔记");
  return {
    id: options.id || "page-existing",
    properties,
    markdown: options.markdown ?? "",
    in_trash: options.in_trash ?? false,
    is_archived: options.is_archived ?? false,
    children: [],
  };
}

export { DS_ID, settle };
