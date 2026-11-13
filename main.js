// src/util.ts
function errMsg(e) {
  if (e == null) return "\u672A\u77E5\u9519\u8BEF";
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    const obj = e;
    if (typeof obj.message === "string") return obj.message;
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
function redact(text, token) {
  if (!text) return "";
  let out = text;
  if (token) {
    out = out.split(token).join("[REDACTED]");
    out = out.replace(/Bearer\s+[A-Za-z0-9_\-]{8,}/gi, "Bearer [REDACTED]");
  }
  return out;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function asString(v, dflt = "") {
  if (typeof v === "string") return v;
  if (v == null) return dflt;
  return String(v);
}
function asBool(v, dflt = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1" || v === "yes";
  if (typeof v === "number") return v !== 0;
  return dflt;
}
function asNumber(v, dflt) {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : dflt;
}
function escapeHtml(v) {
  return asString(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function truncate(v, max = 300) {
  const s = asString(v);
  return s.length > max ? `${s.slice(0, max)}\u2026` : s;
}
function parseJson(text) {
  if (!text) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}

// src/notion/client.ts
var NotionError = class extends Error {
  status;
  code;
  retryAfter;
  details;
  /** 写入可能已生效但响应超时，调用方不应盲目重试。 */
  maybeCommitted;
  constructor(message, meta = {}) {
    super(message);
    this.name = "NotionError";
    Object.assign(this, meta);
  }
};
var MAX_ATTEMPTS = 5;
var NotionClient = class {
  constructor(settings, fetchImpl, queue) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
    this.queue = queue;
  }
  get baseUrl() {
    return this.settings.apiBaseUrl.replace(/\/+$/, "");
  }
  /** 把 Notion 返回的绝对 URL 映射到当前配置的 baseUrl（自建代理场景）。 */
  rewriteUrl(url) {
    if (this.baseUrl === "https://api.notion.com") return url;
    try {
      const u = new URL(url);
      const base = new URL(this.baseUrl);
      return `${base.origin}${base.pathname.replace(/\/$/, "")}${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  }
  headers(json) {
    const h = {
      Authorization: `Bearer ${this.settings.token}`,
      "Notion-Version": this.settings.notionVersion,
      Accept: "application/json"
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }
  async request(method, path, body) {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const options = {
      method,
      headers: this.headers(body !== void 0)
    };
    if (body !== void 0) options.body = JSON.stringify(body);
    return this.queue.run(() => this.withRetry(url, options, method));
  }
  /** 文件上传专用：multipart/form-data。 */
  async requestForm(url, form) {
    const target = this.rewriteUrl(url);
    const options = {
      method: "POST",
      headers: this.headers(false),
      body: form
    };
    return this.queue.run(() => this.withRetry(target, options, "POST"));
  }
  async withRetry(url, options, method) {
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let response;
      try {
        response = await this.fetchImpl(url, options);
      } catch (e) {
        if (attempt + 1 < MAX_ATTEMPTS && (method === "GET" || method === "DELETE")) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new NotionError(redact(`\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25\uFF1A${errMsg(e)}`, this.settings.token));
      }
      const text = await safeText(response);
      const data = parseJson(text);
      const retryAfter = readRetryAfter(response, data);
      if (response.ok) {
        return data ?? text;
      }
      const status = response.status;
      const code = typeof data?.code === "string" ? data.code : void 0;
      const message = redact(
        typeof data?.message === "string" ? data.message : text || `Notion API error: ${status}`,
        this.settings.token
      );
      const rateLimited = status === 429 || status === 529;
      const idempotent = method === "GET" || method === "DELETE";
      const transient5xx = [500, 502, 503, 504].includes(status);
      const blocked = code === "public_api_request_blocked" || readRateLimitReason(data) === "public_api_request_blocked";
      const maybeCommitted = hasCommitGuidance(data);
      const error = new NotionError(userMessage(status, code, message), {
        status,
        code,
        retryAfter,
        details: data,
        maybeCommitted
      });
      if (status === 401 || status === 403) throw error;
      if (blocked) throw error;
      if (rateLimited && attempt + 1 < MAX_ATTEMPTS) {
        lastError = error;
        await sleep(retryAfter != null ? retryAfter * 1e3 : backoff(attempt));
        continue;
      }
      if (transient5xx && idempotent && attempt + 1 < MAX_ATTEMPTS) {
        lastError = error;
        await sleep(retryAfter != null ? retryAfter * 1e3 : backoff(attempt));
        continue;
      }
      throw error;
    }
    throw lastError ?? new NotionError("Notion \u8BF7\u6C42\u91CD\u8BD5\u6B21\u6570\u5DF2\u7528\u5C3D\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u3002");
  }
};
function backoff(attempt) {
  const base = Math.min(2 ** attempt, 30) * 1e3;
  return base + Math.random() * 250;
}
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
function readRetryAfter(response, data) {
  const header = response.headers?.get?.("Retry-After") ?? response.headers?.get?.("retry-after");
  const raw = header ?? readAdditionalString(data, "retry_after");
  if (raw == null) return void 0;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : void 0;
}
function readAdditionalString(data, key) {
  const additional = data?.additional_data;
  const v = additional?.[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : void 0;
}
function readRateLimitReason(data) {
  const additional = data?.additional_data;
  const v = additional?.rate_limit_reason;
  return typeof v === "string" ? v : void 0;
}
function hasCommitGuidance(data) {
  const additional = data?.additional_data;
  return Boolean(additional?.committed_resource_id || additional?.retry_guidance);
}
function userMessage(status, code, message) {
  const prefix = `Notion API ${status}${code ? ` (${code})` : ""}`;
  if (status === 401) return `${prefix}\uFF1AToken \u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u68C0\u67E5 Integration Token\u3002`;
  if (status === 403) {
    return `${prefix}\uFF1AIntegration \u7F3A\u5C11\u76F8\u5E94\u80FD\u529B\u6216\u672A\u83B7\u6388\u6743\u3002\u8BF7\u5728 Notion \u7684\u76EE\u6807\u6570\u636E\u5E93/\u9875\u9762\u300CConnections\u300D\u4E2D\u6DFB\u52A0\u8BE5 Integration\uFF0C\u5E76\u786E\u8BA4\u5DF2\u5F00\u542F Read / Update / Insert content \u80FD\u529B\u3002${message ? ` \u8BE6\u60C5\uFF1A${message}` : ""}`;
  }
  if (status === 404) return `${prefix}\uFF1A\u76EE\u6807\u4E0D\u5B58\u5728\u6216 Integration \u672A\u83B7\u6388\u6743\u8BBF\u95EE\u8BE5\u6570\u636E\u5E93/\u9875\u9762\u3002`;
  if (status === 429) return `${prefix}\uFF1A\u8BF7\u6C42\u88AB\u9650\u6D41\uFF0C\u5DF2\u6309 Retry-After \u7B49\u5F85\u540E\u91CD\u8BD5\u3002${message}`;
  if (status === 529) return `${prefix}\uFF1ANotion \u670D\u52A1\u8FC7\u8F7D\uFF0C\u5DF2\u5C1D\u8BD5\u9000\u907F\u91CD\u8BD5\u3002${message}`;
  if (status === 503) return `${prefix}\uFF1A\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF1B\u82E5\u4E3A\u5199\u8BF7\u6C42\uFF0C\u53D8\u66F4\u53EF\u80FD\u5DF2\u4FDD\u5B58\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u786E\u8BA4\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u81EA\u52A8\u91CD\u653E\u5199\u5165\u3002${message}`;
  return `${prefix}\uFF1A${message}`;
}

// src/sync/queue.ts
var RequestQueue = class {
  constructor(minIntervalMs = 340) {
    this.minIntervalMs = minIntervalMs;
  }
  chain = Promise.resolve();
  nextAt = 0;
  run(task) {
    const scheduled = this.chain.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.minIntervalMs;
      return task();
    });
    this.chain = scheduled.catch(() => void 0);
    return scheduled;
  }
  /** 同步任务内部等待（例如 429 退避）不应占着队列，由调用方在 run 外自行处理。 */
  get size() {
    return 0;
  }
};

// src/sync/mapping.ts
var STORAGE_KEYS = {
  mappings: "notion-sync:mappings",
  resources: "notion-sync:resources",
  report: "notion-sync:last-report",
  state: "notion-sync:state",
  pending: "notion-sync:pending",
  setup: "notion-sync:setup"
};
function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}
async function loadMappings(ctx) {
  return asRecord(await ctx.storage.get(STORAGE_KEYS.mappings));
}
async function saveMappings(ctx, mappings) {
  await ctx.storage.set(STORAGE_KEYS.mappings, mappings);
}
async function loadResourceMappings(ctx) {
  return asRecord(await ctx.storage.get(STORAGE_KEYS.resources));
}
async function saveResourceMappings(ctx, mappings) {
  await ctx.storage.set(STORAGE_KEYS.resources, mappings);
}
async function loadState(ctx) {
  const raw = await ctx.storage.get(STORAGE_KEYS.state);
  return { firstSyncDone: raw?.firstSyncDone === true, ...raw };
}
async function saveState(ctx, state) {
  await ctx.storage.set(STORAGE_KEYS.state, state);
}
async function saveReport(ctx, report) {
  await ctx.storage.set(STORAGE_KEYS.report, report);
}
async function loadReport(ctx) {
  return await ctx.storage.get(STORAGE_KEYS.report);
}
async function markDeleted(ctx, noteId, at) {
  const mappings = await loadMappings(ctx);
  if (!mappings[noteId]) return;
  mappings[noteId] = { ...mappings[noteId], status: "deleted", deletedAt: at };
  await saveMappings(ctx, mappings);
}
async function restoreMapping(ctx, noteId) {
  const mappings = await loadMappings(ctx);
  const m = mappings[noteId];
  if (!m) return false;
  const { deletedAt: _deletedAt, ...rest } = m;
  mappings[noteId] = { ...rest, status: "synced" };
  await saveMappings(ctx, mappings);
  return true;
}
async function addPending(ctx, noteIds) {
  const raw = await ctx.storage.get(STORAGE_KEYS.pending);
  const set = new Set(Array.isArray(raw) ? raw.map(String) : []);
  for (const id of noteIds) set.add(id);
  const list = Array.from(set).slice(0, 500);
  await ctx.storage.set(STORAGE_KEYS.pending, list);
  return list;
}
async function clearPending(ctx) {
  await ctx.storage.set(STORAGE_KEYS.pending, []);
}

// src/sync/setup-store.ts
var KEY = `${STORAGE_KEYS.setup}`;
async function loadSetupRecord(ctx) {
  const raw = await ctx.storage.get(KEY);
  if (!raw || typeof raw !== "object") return void 0;
  if (typeof raw.dataSourceId !== "string" || !raw.dataSourceId) return void 0;
  if (typeof raw.databaseId !== "string" || !raw.databaseId) return void 0;
  return {
    databaseId: raw.databaseId,
    dataSourceId: raw.dataSourceId,
    parentPageId: typeof raw.parentPageId === "string" ? raw.parentPageId : "",
    databaseUrl: typeof raw.databaseUrl === "string" ? raw.databaseUrl : void 0,
    databaseTitle: typeof raw.databaseTitle === "string" ? raw.databaseTitle : void 0,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    propertyNames: Array.isArray(raw.propertyNames) ? raw.propertyNames.filter((n) => typeof n === "string") : []
  };
}
async function saveSetupRecord(ctx, record) {
  await ctx.storage.set(KEY, record);
}

// src/config/settings.ts
var SETTINGS_DEFAULTS = {
  apiBaseUrl: "https://api.notion.com",
  notionVersion: "2026-03-11",
  markdownVersion: "v2",
  direction: "bidirectional",
  autoSync: false,
  autoSyncDelaySec: 60,
  uploadAttachments: false,
  maxAttachmentMB: 5
};
var DEFAULT_PROPS = {
  name: "Name",
  edgeeverId: "EdgeEver ID",
  notebookId: "EdgeEver Notebook ID",
  tags: "Tags",
  contentHash: "Content Hash",
  lastSynced: "Last Synced",
  syncStatus: "Sync Status",
  edgeeverUpdated: "EdgeEver Updated At"
};
async function loadSettings(ctx) {
  const get = async (key) => {
    try {
      return await ctx.settings.get(key);
    } catch {
      return void 0;
    }
  };
  let token = "";
  try {
    token = asString(await ctx.secrets.get("notion-token"), "").trim();
  } catch {
  }
  if (!token) token = asString(await get("notion-token"), "").trim();
  const mdRaw = asString(await get("markdown-version"), SETTINGS_DEFAULTS.markdownVersion);
  const dirRaw = asString(await get("sync-direction"), SETTINGS_DEFAULTS.direction);
  const manualDataSourceId = asString(await get("notion-data-source-id"), "").trim();
  const manualDatabaseId = asString(await get("notion-database-id"), "").trim();
  const generated = !manualDataSourceId && !manualDatabaseId ? await loadSetupRecord(ctx) : void 0;
  const props = {
    name: asString(await get("prop-name"), DEFAULT_PROPS.name).trim() || DEFAULT_PROPS.name,
    edgeeverId: asString(await get("prop-edgeever-id"), DEFAULT_PROPS.edgeeverId).trim() || DEFAULT_PROPS.edgeeverId,
    notebookId: asString(await get("prop-notebook-id"), DEFAULT_PROPS.notebookId).trim(),
    tags: asString(await get("prop-tags"), DEFAULT_PROPS.tags).trim(),
    contentHash: asString(await get("prop-content-hash"), DEFAULT_PROPS.contentHash).trim(),
    lastSynced: asString(await get("prop-last-synced"), DEFAULT_PROPS.lastSynced).trim(),
    syncStatus: asString(await get("prop-sync-status"), DEFAULT_PROPS.syncStatus).trim(),
    edgeeverUpdated: asString(await get("prop-edgeever-updated"), DEFAULT_PROPS.edgeeverUpdated).trim()
  };
  return {
    token,
    databaseId: manualDatabaseId,
    dataSourceId: manualDataSourceId || generated?.dataSourceId || "",
    dataSourceIdSource: manualDataSourceId || manualDatabaseId ? "manual" : generated ? "generated" : "none",
    parentPageId: asString(await get("notion-parent-page-id"), "").trim(),
    apiBaseUrl: asString(await get("api-base-url"), SETTINGS_DEFAULTS.apiBaseUrl).trim().replace(/\/+$/, "") || SETTINGS_DEFAULTS.apiBaseUrl,
    notionVersion: asString(await get("notion-version"), SETTINGS_DEFAULTS.notionVersion).trim() || SETTINGS_DEFAULTS.notionVersion,
    markdownVersion: mdRaw === "v1" ? "v1" : "v2",
    notebookId: asString(await get("sync-notebook-id"), "").trim(),
    direction: dirRaw === "push" || dirRaw === "pull" ? dirRaw : "bidirectional",
    props,
    autoSync: asBool(await get("auto-sync"), SETTINGS_DEFAULTS.autoSync),
    autoSyncDelaySec: Math.max(5, asNumber(await get("auto-sync-delay-sec"), SETTINGS_DEFAULTS.autoSyncDelaySec)),
    uploadAttachments: asBool(await get("upload-attachments"), SETTINGS_DEFAULTS.uploadAttachments),
    maxAttachmentMB: Math.max(0.1, asNumber(await get("max-attachment-mb"), SETTINGS_DEFAULTS.maxAttachmentMB))
  };
}
function validateSettings(s) {
  if (!s.token) return "\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199 Notion Integration Token\uFF08secret \u5B57\u6BB5\uFF09";
  if (!s.dataSourceId && !s.databaseId) {
    return "\u8BF7\u5148\u70B9\u51FB\u540C\u6B65\u9762\u677F\u7684\u300C\u4E00\u952E\u751F\u6210\u540C\u6B65\u6570\u636E\u5E93\u300D\uFF08\u9700\u5148\u5728\u8BBE\u7F6E\u4E2D\u586B\u5199 Notion \u7236\u9875\u9762 ID\uFF09\uFF0C\u6216\u624B\u52A8\u586B\u5199 Data Source ID / \u6570\u636E\u5E93 ID";
  }
  if (!/^https:\/\//i.test(s.apiBaseUrl) && !/^http:\/\/localhost/i.test(s.apiBaseUrl)) {
    return "API \u57FA\u7840\u5730\u5740\u5FC5\u987B\u4F7F\u7528 https\uFF08\u672C\u5730\u8C03\u8BD5\u53EF\u7528 http://localhost\uFF09";
  }
  if (!s.notebookId) return "\u8BF7\u5148\u5728\u540C\u6B65\u9762\u677F\u4E2D\u9009\u62E9\u8981\u540C\u6B65\u7684 EdgeEver \u7B14\u8BB0\u672C";
  return null;
}
function isCustomApiBase(s) {
  return s.apiBaseUrl.replace(/\/+$/, "") !== SETTINGS_DEFAULTS.apiBaseUrl;
}

// src/notion/data-sources.ts
async function resolveDataSourceId(client, settings) {
  if (settings.dataSourceId) return settings.dataSourceId;
  if (!settings.databaseId) {
    throw new NotionError("\u672A\u914D\u7F6E Data Source ID \u6216\u6570\u636E\u5E93 ID\u3002");
  }
  const db = await client.request(
    "GET",
    `/v1/databases/${encodeURIComponent(settings.databaseId)}`
  );
  const first = db.data_sources?.find((s) => typeof s.id === "string" && s.id.length > 0);
  if (!first?.id) {
    throw new NotionError(
      "\u5DF2\u8BFB\u53D6\u5230\u6570\u636E\u5E93\uFF0C\u4F46\u6CA1\u6709\u53EF\u7528\u7684 Data Source\u3002\u8BF7\u786E\u8BA4\u8BE5\u6570\u636E\u5E93\u5DF2\u4E0E Integration \u5EFA\u7ACB\u8FDE\u63A5\uFF0C\u6216\u76F4\u63A5\u586B\u5199 Data Source ID\u3002"
    );
  }
  return first.id;
}
async function verifyConnection(client, dataSourceId) {
  const me = await client.request("GET", "/v1/users/me");
  const sample = await client.request(
    "POST",
    `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
    { page_size: 1, result_type: "page" }
  );
  return {
    botName: me.name,
    workspaceName: me.bot?.workspace_name,
    maxFileUploadBytes: me.bot?.workspace_limits?.max_file_upload_size_in_bytes,
    dataSourceId,
    pageCountSample: Array.isArray(sample.results) ? sample.results.length : 0
  };
}
async function queryAllPages(client, dataSourceId, options = {}) {
  const pages = [];
  let cursor = null;
  let incomplete = false;
  do {
    const body = {
      page_size: options.pageSize ?? 100,
      result_type: "page"
    };
    if (cursor) body.start_cursor = cursor;
    if (options.filter) body.filter = options.filter;
    if (options.archived) body.is_archived = true;
    const res = await client.request(
      "POST",
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
      body
    );
    if (Array.isArray(res.results)) pages.push(...res.results.filter((p) => p && typeof p.id === "string"));
    if (res.request_status?.type === "incomplete") incomplete = true;
    cursor = res.has_more && typeof res.next_cursor === "string" ? res.next_cursor : null;
  } while (cursor);
  return { pages, incomplete };
}
async function findPageByEdgeeverId(client, dataSourceId, propertyName, edgeeverId) {
  const { pages } = await queryAllPages(client, dataSourceId, {
    filter: { property: propertyName, rich_text: { equals: edgeeverId } },
    pageSize: 10
  });
  return pages[0];
}

// src/notion/pages.ts
function richText(content) {
  const parts = [];
  for (let i = 0; i < content.length; i += 1900) parts.push(content.slice(i, i + 1900));
  if (parts.length === 0) parts.push("");
  return parts.map((c) => ({ text: { content: c } }));
}
function propMap(s, input) {
  const p = s.props;
  const out = {};
  if (input.title !== void 0 && p.name) out[p.name] = { title: richText(input.title) };
  if (input.edgeeverId !== void 0 && p.edgeeverId) out[p.edgeeverId] = { rich_text: richText(input.edgeeverId) };
  if (input.notebookId !== void 0 && p.notebookId) out[p.notebookId] = { rich_text: richText(input.notebookId) };
  if (input.contentHash !== void 0 && p.contentHash) out[p.contentHash] = { rich_text: richText(input.contentHash) };
  if (input.tags !== void 0 && p.tags) {
    out[p.tags] = { multi_select: input.tags.slice(0, 100).map((name) => ({ name })) };
  }
  if (input.syncStatus !== void 0 && p.syncStatus) {
    out[p.syncStatus] = { select: { name: input.syncStatus } };
  }
  if (input.lastSynced !== void 0 && p.lastSynced) out[p.lastSynced] = { date: { start: input.lastSynced } };
  if (input.edgeeverUpdated !== void 0 && p.edgeeverUpdated) {
    out[p.edgeeverUpdated] = { date: { start: input.edgeeverUpdated } };
  }
  return out;
}
function requiredProperties(s, title, edgeeverId) {
  return propMap(s, { title, edgeeverId });
}
function optionalProperties(s, input) {
  const all = propMap(s, input);
  delete all[s.props.name];
  delete all[s.props.edgeeverId];
  return all;
}
async function createPage(client, settings, dataSourceId, input) {
  const body = {
    parent: { data_source_id: dataSourceId },
    properties: requiredProperties(settings, input.title, input.edgeeverId),
    notifications: { mode: "silent" }
  };
  if (input.markdown) {
    body.markdown = input.markdown;
    body.markdown_version = settings.markdownVersion;
  }
  return client.request("POST", "/v1/pages", body);
}
async function retrievePage(client, pageId) {
  return client.request("GET", `/v1/pages/${encodeURIComponent(pageId)}`);
}
async function patchProperties(client, pageId, properties) {
  if (Object.keys(properties).length === 0) return;
  await client.request("PATCH", `/v1/pages/${encodeURIComponent(pageId)}`, {
    properties,
    notifications: { mode: "silent" }
  });
}
function plainText(prop) {
  if (!prop) return "";
  const items = prop.title ?? prop.rich_text ?? [];
  return items.map((it) => it.plain_text ?? it.text?.content ?? "").join("");
}
function readTitle(page, propertyName) {
  const props = page.properties ?? {};
  const named = props[propertyName];
  if (named) return plainText(named);
  for (const value of Object.values(props)) {
    if (value?.type === "title") return plainText(value);
  }
  return "";
}
function readTags(prop) {
  if (!prop?.multi_select) return [];
  return prop.multi_select.map((o) => o.name ?? "").filter(Boolean);
}

// src/notion/markdown.ts
async function getPageMarkdown(client, pageId, markdownVersion = "v2") {
  const res = await client.request(
    "GET",
    `/v1/pages/${encodeURIComponent(pageId)}/markdown?markdown_version=${markdownVersion}`
  );
  return { ...res, markdown: typeof res.markdown === "string" ? res.markdown : "" };
}
async function replacePageMarkdown(client, pageId, content, markdownVersion = "v2") {
  return client.request("PATCH", `/v1/pages/${encodeURIComponent(pageId)}/markdown`, {
    type: "replace_content",
    replace_content: {
      new_str: content,
      allow_deleting_content: false
    },
    markdown_version: markdownVersion
  });
}
function incompleteReasons(md, phase = "read") {
  const reasons = [];
  if (md.truncated === true) reasons.push("\u6B63\u6587\u88AB\u622A\u65AD\uFF08\u9875\u9762\u8D85\u8FC7\u8BB0\u5F55\u4E0A\u9650\uFF09");
  const unknown = Array.isArray(md.unknown_block_ids) ? md.unknown_block_ids.length : 0;
  if (unknown > 0) reasons.push(`\u5B58\u5728 ${unknown} \u4E2A\u672A\u80FD\u52A0\u8F7D/\u65E0\u6CD5\u8F6C\u6362\u7684 Block`);
  const warnings = Array.isArray(md.warnings) ? md.warnings : [];
  for (const w of warnings) {
    reasons.push(`\u5185\u5BB9\u8B66\u544A\uFF1A${w.code ?? "warning"} ${w.message ?? ""}`.trim());
  }
  if (reasons.length && phase === "write") {
    reasons.push("\u5199\u5165\u53EF\u80FD\u4E0E\u9884\u671F\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u5728 Notion \u4E2D\u6838\u5BF9\u540E\u518D\u540C\u6B65");
  }
  return reasons;
}

// src/notion/setup.ts
var DEFAULT_DATABASE_TITLE = "EdgeEver Sync";
function desiredProperties(props) {
  const out = {};
  const put = (name, config) => {
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
function expectedType(config) {
  if (config.title) return "title";
  if (config.rich_text) return "rich_text";
  if (config.multi_select) return "multi_select";
  if (config.select) return "select";
  if (config.date) return "date";
  return void 0;
}
function normalizeNotionId(raw) {
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
function formatUuid(hex) {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function firstDataSourceId(db) {
  return db?.data_sources?.find((d) => typeof d.id === "string" && d.id)?.id ?? "";
}
function setupErrorMessage(e, token) {
  const status = e instanceof NotionError ? e.status : void 0;
  const detail = redact(errMsg(e), token);
  if (status === 403) {
    return `\u5EFA\u5E93\u5931\u8D25\uFF1AIntegration \u7F3A\u5C11 Insert content \u80FD\u529B\uFF0C\u6216\u672A\u83B7\u6388\u6743\u8BBF\u95EE\u8BE5\u9875\u9762\u3002\u8BF7\u5728 Notion Integration \u8BBE\u7F6E\u4E2D\u5F00\u542F Read / Update / Insert content\uFF0C\u5E76\u5728\u7236\u9875\u9762\u300C\xB7\xB7\xB7 \u2192 Connections\u300D\u4E2D\u6DFB\u52A0\u8BE5 Integration\u3002${detail ? ` \u8BE6\u60C5\uFF1A${detail}` : ""}`;
  }
  if (status === 404) {
    return `\u5EFA\u5E93\u5931\u8D25\uFF1A\u627E\u4E0D\u5230\u7236\u9875\u9762\uFF0C\u6216 Integration \u672A\u83B7\u6388\u6743\u8BBF\u95EE\u5B83\u3002\u8BF7\u786E\u8BA4\u9875\u9762 ID \u6B63\u786E\uFF0C\u4E14\u5DF2\u5728\u8BE5\u9875\u9762\u300C\xB7\xB7\xB7 \u2192 Connections\u300D\u4E2D\u6DFB\u52A0 Integration\u3002${detail ? ` \u8BE6\u60C5\uFF1A${detail}` : ""}`;
  }
  return `\u5EFA\u5E93\u5931\u8D25\uFF1A${detail}`;
}
function titleRichText(text) {
  return [{ type: "text", text: { content: text.slice(0, 2e3) } }];
}
async function ensureSyncDatabase(ctx, client, settings) {
  if (!settings.token) throw new Error("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199 Notion Integration Token\uFF08secret \u5B57\u6BB5\uFF09\u3002");
  const desired = desiredProperties(settings.props);
  const previous = await loadSetupRecord(ctx);
  let created = false;
  let saveRecord = true;
  let usedManualTarget = false;
  let databaseId = "";
  let dataSourceId = "";
  let databaseUrl;
  let parentPageId = "";
  if (settings.dataSourceIdSource === "manual") {
    usedManualTarget = true;
    saveRecord = false;
    dataSourceId = settings.dataSourceId || await resolveDataSourceId(client, settings);
    databaseId = settings.databaseId;
  } else if (previous) {
    try {
      await client.request(
        "GET",
        `/v1/data_sources/${encodeURIComponent(previous.dataSourceId)}`
      );
    } catch (e) {
      throw new Error(
        `\u5DF2\u751F\u6210\u7684\u540C\u6B65\u6570\u636E\u5E93\u65E0\u6CD5\u8BBF\u95EE\uFF08Notion API ${e instanceof NotionError ? e.status ?? "\u9519\u8BEF" : "\u9519\u8BEF"}\uFF09\u3002\u8BF7\u786E\u8BA4 Integration \u4ECD\u6709\u8BBF\u95EE\u6743\u9650\uFF1B\u5982\u6570\u636E\u5E93\u5DF2\u88AB\u5220\u9664\u6216\u53D6\u6D88\u5171\u4EAB\uFF0C\u8BF7\u5148\u6E05\u7A7A\u63D2\u4EF6\u6570\u636E\u518D\u91CD\u65B0\u751F\u6210\u3002\u4E3A\u907F\u514D\u91CD\u590D\u5EFA\u5E93\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u81EA\u52A8\u65B0\u5EFA\u3002${redact(errMsg(e), settings.token)}`
      );
    }
    databaseId = previous.databaseId;
    dataSourceId = previous.dataSourceId;
    databaseUrl = previous.databaseUrl;
    parentPageId = previous.parentPageId;
  } else {
    parentPageId = normalizeNotionId(settings.parentPageId);
    if (!parentPageId) {
      throw new Error("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199\u300CNotion \u7236\u9875\u9762 ID\u300D\uFF08\u53EF\u7C98\u8D34\u9875\u9762\u94FE\u63A5\uFF09\uFF0C\u518D\u70B9\u51FB\u4E00\u952E\u751F\u6210\u3002");
    }
    let db;
    try {
      db = await client.request("POST", "/v1/databases", {
        parent: { type: "page_id", page_id: parentPageId },
        title: titleRichText(DEFAULT_DATABASE_TITLE),
        is_inline: false,
        initial_data_source: { properties: desired }
      });
    } catch (e) {
      throw new Error(setupErrorMessage(e, settings.token));
    }
    databaseId = typeof db.id === "string" ? db.id : "";
    databaseUrl = typeof db.url === "string" ? db.url : void 0;
    dataSourceId = firstDataSourceId(db);
    if (!dataSourceId && databaseId) {
      try {
        const full = await client.request(
          "GET",
          `/v1/databases/${encodeURIComponent(databaseId)}`
        );
        dataSourceId = firstDataSourceId(full);
      } catch (e) {
        throw new Error(`\u6570\u636E\u5E93\u5DF2\u521B\u5EFA\uFF0C\u4F46\u8BFB\u53D6\u5176 Data Source \u5931\u8D25\uFF1A${redact(errMsg(e), settings.token)}`);
      }
    }
    if (!dataSourceId || !databaseId) {
      throw new Error("\u6570\u636E\u5E93\u5DF2\u521B\u5EFA\uFF0C\u4F46 Notion \u54CD\u5E94\u4E2D\u6CA1\u6709\u53EF\u7528\u7684 Data Source ID\uFF0C\u8BF7\u5728 Notion \u4E2D\u68C0\u67E5\u8BE5\u6570\u636E\u5E93\u540E\u91CD\u8BD5\u3002");
    }
    created = true;
  }
  const schema = await client.request(
    "GET",
    `/v1/data_sources/${encodeURIComponent(dataSourceId)}`
  );
  const existing = schema.properties ?? {};
  const missing = {};
  const existingProperties = [];
  const mismatchedProperties = [];
  for (const [name, config] of Object.entries(desired)) {
    const current = existing[name];
    if (!current) {
      missing[name] = config;
      continue;
    }
    existingProperties.push(name);
    const want = expectedType(config);
    if (want && current.type && current.type !== want) {
      mismatchedProperties.push(`${name}\uFF08\u5F53\u524D ${current.type}\uFF0C\u9700\u8981 ${want}\uFF09`);
    }
  }
  const addedProperties = Object.keys(missing);
  if (addedProperties.length) {
    await client.request(
      "PATCH",
      `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
      { properties: missing }
    );
  }
  const record = {
    databaseId,
    dataSourceId,
    parentPageId,
    databaseUrl,
    databaseTitle: DEFAULT_DATABASE_TITLE,
    createdAt: previous?.createdAt || nowIso(),
    propertyNames: Object.keys(desired)
  };
  if (saveRecord) await saveSetupRecord(ctx, record);
  const parts = [];
  parts.push(
    usedManualTarget ? "\u68C0\u6D4B\u5230\u8BBE\u7F6E\u91CC\u624B\u52A8\u6307\u5B9A\u7684 Data Source\uFF0C\u672A\u65B0\u5EFA\u6570\u636E\u5E93\u3002" : created ? `\u5DF2\u5728\u7236\u9875\u9762\u4E0B\u521B\u5EFA\u540C\u6B65\u6570\u636E\u5E93\u300C${DEFAULT_DATABASE_TITLE}\u300D\uFF0CData Source ID \u5DF2\u81EA\u52A8\u4FDD\u5B58\uFF0C\u65E0\u9700\u624B\u52A8\u590D\u5236\u3002` : "\u5DF2\u68C0\u6D4B\u5230\u6B64\u524D\u751F\u6210\u7684\u540C\u6B65\u6570\u636E\u5E93\uFF0C\u672A\u91CD\u590D\u521B\u5EFA\u3002"
  );
  parts.push(addedProperties.length ? `\u65B0\u589E\u5C5E\u6027\uFF1A${addedProperties.join("\u3001")}\u3002` : "\u6240\u9700\u5C5E\u6027\u5DF2\u9F50\u5168\u3002");
  if (mismatchedProperties.length) {
    parts.push(`\u4EE5\u4E0B\u5C5E\u6027\u7C7B\u578B\u4E0D\u5339\u914D\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u81EA\u52A8\u4FEE\u6539\uFF0C\u8BF7\u624B\u52A8\u8C03\u6574\uFF1A${mismatchedProperties.join("\uFF1B")}\u3002`);
  }
  parts.push("\u73B0\u5728\u53EF\u4EE5\u300C\u6D4B\u8BD5\u8FDE\u63A5 \u2192 \u751F\u6210\u9884\u89C8 \u2192 \u6267\u884C\u540C\u6B65\u300D\u3002");
  return {
    created,
    record,
    addedProperties,
    existingProperties,
    mismatchedProperties,
    message: parts.join("")
  };
}

// src/sync/hash.ts
function normalizeMarkdown(input) {
  let s = input ?? "";
  s = s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  const lines = s.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  const normalized = [];
  for (const raw of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        inFence = false;
      }
      normalized.push(raw.replace(/[ \t]+$/, ""));
      continue;
    }
    if (inFence) {
      normalized.push(raw.replace(/[ \t]+$/, ""));
      continue;
    }
    let line = raw.replace(/[ \t]+$/, "");
    line = line.replace(/^(\s*)[*+](\s+)/, "$1-$2");
    line = line.replace(/^(\s*)\d+\)(\s+)/, "$11.$2");
    normalized.push(line);
  }
  return normalized.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "").trim();
}
function fnv1a64(bytes) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = h * prime & mask;
  }
  return `fnv1a64-${h.toString(16).padStart(16, "0")}-${bytes.length.toString(16)}`;
}
function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle?.digest) {
    try {
      return toHex(await subtle.digest("SHA-256", bytes));
    } catch {
    }
  }
  return fnv1a64(bytes);
}
async function sha256Bytes(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle?.digest) {
    try {
      return toHex(await subtle.digest("SHA-256", bytes));
    } catch {
    }
  }
  return fnv1a64(bytes);
}
async function contentHash(markdown) {
  return sha256Hex(normalizeMarkdown(markdown));
}

// src/converters/markdown.ts
var ATTACH_START = "EE-ATTACHMENTS-START";
var ATTACH_END = "EE-ATTACHMENTS-END";
var ATTACH_LINE = "EE-ATTACH:";
function findResource(resources, target) {
  const raw = target.trim().replace(/^<|>$/g, "");
  const id = raw.startsWith("edgeever://") ? raw.slice("edgeever://".length) : raw;
  return resources.find((r) => r.id === id || r.filename === id || r.fileName === id || r.name === id);
}
function isExternalTarget(target) {
  const t = target.trim();
  return /^(https?:|data:|mailto:|ftp:|#)/i.test(t);
}
function replaceLocalRefs(markdown, resources) {
  const lines = (markdown ?? "").split("\n");
  return lines.map((line) => {
    return line.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (whole, _label, target) => {
      if (isExternalTarget(target)) return whole;
      const resource = findResource(resources, target);
      if (!resource) return whole;
      const filename = resource.filename ?? resource.fileName ?? resource.name ?? resource.id;
      return `${ATTACH_LINE}${resource.id}|${filename}`;
    });
  }).join("\n");
}
function parseAttachmentPlaceholders(markdown) {
  const out = [];
  const re = new RegExp(`^\\s*${ATTACH_LINE.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}([^|\\n]+)\\|(.+?)\\s*$`, "gm");
  let m;
  while ((m = re.exec(markdown ?? "")) !== null) {
    out.push({ id: m[1].trim(), filename: m[2].trim() });
  }
  return out;
}
function restorePlaceholders(markdown, resources) {
  return (markdown ?? "").split("\n").map((line) => {
    const m = new RegExp(`^\\s*(${ATTACH_LINE})([^|\\n]+)\\|(.+?)\\s*$`).exec(line);
    if (!m) return line;
    const id = m[2].trim();
    const filename = m[3].trim();
    const known = resources.some((r) => r.id === id);
    if (!known) return line;
    return `![${filename}](edgeever://${id})`;
  }).join("\n");
}
function stripAttachmentSection(markdown) {
  const lines = (markdown ?? "").split("\n");
  const start = lines.findIndex((l) => l.includes(ATTACH_START));
  if (start < 0) return { text: markdown ?? "", found: false };
  const end = lines.findIndex((l, i) => i > start && l.includes(ATTACH_END));
  const cutTo = end >= 0 ? end + 1 : lines.length;
  const kept = [...lines.slice(0, start), ...lines.slice(cutTo)];
  return { text: kept.join("\n"), found: true };
}
function prepareImagesForV2(markdown) {
  const lines = (markdown ?? "").split("\n");
  const out = [];
  for (const line of lines) {
    const isImageLine = /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line);
    if (isImageLine && out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(line);
    if (isImageLine) out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
function preserveUnknownTags(markdown) {
  let s = markdown ?? "";
  s = s.replace(
    /<unknown\s+url="([^"]*)"[^>]*\/>/g,
    (_all, url) => url ? `[Notion \u672A\u52A0\u8F7D\u7684\u5185\u5BB9\uFF08\u539F\u5730\u5740\uFF09](${url})` : "[Notion \u672A\u80FD\u52A0\u8F7D\u7684\u5185\u5BB9]"
  );
  s = s.replace(/<link-preview\s+url="([^"]*)"[^>]*\/>/g, (_all, url) => `[Notion \u94FE\u63A5\u9884\u89C8](${url})`);
  s = s.replace(
    /<page\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/page>/g,
    (_all, url, label) => `[Notion \u5B50\u9875\u9762\uFF1A${label.trim()}](${url})`
  );
  return s;
}
function toNotionMarkdown(markdown, resources) {
  return prepareImagesForV2(replaceLocalRefs(markdown ?? "", resources));
}
function toEdgeeverMarkdown(markdown, resources) {
  const stripped = stripAttachmentSection(markdown ?? "");
  return preserveUnknownTags(restorePlaceholders(stripped.text, resources));
}
function canonicalContent(markdown, resources) {
  const stripped = stripAttachmentSection(markdown ?? "").text;
  return normalizeMarkdown(replaceLocalRefs(preserveUnknownTags(stripped), resources));
}

// src/sync/conflict.ts
function decide(input) {
  const { edgeeverHash: e, notionHash: n, mapping } = input;
  const baseline = mapping?.lastSyncedHash;
  const e0 = mapping?.lastEdgeEverHash ?? baseline;
  const n0 = mapping?.lastNotionHash ?? baseline;
  const eChanged = e0 == null ? true : e !== e0;
  const nChanged = n0 == null ? true : n !== n0;
  if (!eChanged && !nChanged) return "skip";
  if (eChanged && !nChanged) return "push";
  if (!eChanged && nChanged) return "pull";
  if (e === n) return "both-same";
  return "conflict";
}
function decisionLabel(d) {
  switch (d) {
    case "skip":
      return "\u65E0\u53D8\u5316";
    case "push":
      return "\u4EC5 EdgeEver \u4FEE\u6539 \u2192 \u63A8\u9001 Notion";
    case "pull":
      return "\u4EC5 Notion \u4FEE\u6539 \u2192 \u62C9\u53D6 EdgeEver";
    case "both-same":
      return "\u4E24\u7AEF\u6700\u7EC8\u5185\u5BB9\u4E00\u81F4 \u2192 \u66F4\u65B0\u57FA\u7EBF";
    case "conflict":
      return "\u4E24\u7AEF\u540C\u65F6\u4FEE\u6539 \u2192 \u9700\u4EBA\u5DE5\u5904\u7406";
  }
}

// src/notion/blocks.ts
async function appendChildren(client, pageId, children) {
  const ids = [];
  for (let i = 0; i < children.length; i += 100) {
    const chunk = children.slice(i, i + 100);
    const res = await client.request(
      "PATCH",
      `/v1/blocks/${encodeURIComponent(pageId)}/children`,
      { children: chunk, notifications: { mode: "silent" } }
    );
    for (const b of res.results ?? []) if (typeof b?.id === "string") ids.push(b.id);
  }
  return ids;
}

// src/notion/files.ts
async function uploadSinglePart(client, resource, blob) {
  const filename = (resource.filename ?? resource.fileName ?? resource.name ?? `resource-${resource.id}`).slice(0, 200);
  const mimeType = resource.mimeType ?? resource.mime ?? blob.type ?? "application/octet-stream";
  const created = await client.request("POST", "/v1/file_uploads", {
    mode: "single_part",
    filename,
    content_type: mimeType
  });
  if (!created?.id) throw new NotionError("\u521B\u5EFA Notion File Upload \u5931\u8D25\uFF1A\u54CD\u5E94\u7F3A\u5C11 id\u3002");
  const form = new FormData();
  form.append("file", blob, filename);
  const uploaded = await client.requestForm(
    created.upload_url ?? `https://api.notion.com/v1/file_uploads/${created.id}/send`,
    form
  );
  if (uploaded?.status && uploaded.status !== "uploaded") {
    throw new NotionError(`\u6587\u4EF6\u4E0A\u4F20\u672A\u6210\u529F\uFF08status=${uploaded.status}\uFF09\uFF0C\u53EF\u5728\u540C\u6B65\u9762\u677F\u91CD\u8BD5\u3002`);
  }
  return { ...created, ...uploaded, id: uploaded?.id ?? created.id };
}
function attachmentBlock(mapping) {
  const isImage = /^image\//i.test(mapping.mimeType || "");
  const fileObject = { type: "file_upload", file_upload: { id: mapping.notionFileUploadId } };
  if (isImage) {
    return {
      type: "image",
      image: {
        ...fileObject,
        caption: [{ type: "text", text: { content: mapping.filename } }]
      }
    };
  }
  return { type: "file", file: { ...fileObject, name: mapping.filename } };
}
function paragraphBlock(text) {
  return {
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] }
  };
}

// src/edgeever/notes.ts
var SUPPORTED_KINDS = /* @__PURE__ */ new Set(["text", "", "markdown", "note"]);
async function listNotebooks(ctx) {
  const result = await ctx.notebooks.list();
  return Array.isArray(result) ? result.filter((n) => n && typeof n.id === "string") : [];
}
async function listNotes(ctx, notebookId) {
  const summaries = [];
  let offset = 0;
  const pageSize = 200;
  for (let page = 0; page < 50; page++) {
    const res = await ctx.notes.query({
      ...notebookId ? { notebookId } : {},
      limit: pageSize,
      offset,
      sort: "updated-desc"
    });
    const list = Array.isArray(res?.notes) ? res.notes : [];
    for (const n of list) if (n?.id) summaries.push({ id: n.id, kind: n.kind });
    const next = res?.nextOffset;
    if (typeof next !== "number" || list.length === 0) break;
    offset = next;
  }
  const supported = [];
  const unsupported = [];
  const warnings = [];
  for (const summary of summaries) {
    let note;
    try {
      note = await ctx.notes.get(summary.id);
    } catch (e) {
      warnings.push(`\u7B14\u8BB0 ${summary.id} \u8BFB\u53D6\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!note) continue;
    const kind = asString(note.kind ?? summary.kind ?? "", "text").toLowerCase();
    if (!SUPPORTED_KINDS.has(kind)) {
      unsupported.push(note);
      continue;
    }
    if (note.deletedAt) continue;
    supported.push(note);
  }
  return { supported, unsupported, warnings };
}
function noteTitle(note) {
  return asString(note.title, "").trim() || "\u672A\u547D\u540D\u7B14\u8BB0";
}
function noteTags(note) {
  if (!Array.isArray(note.tags)) return [];
  return note.tags.map((t) => asString(t).trim()).filter(Boolean);
}
function noteUpdatedAt(note) {
  const raw = note.updatedAt ?? note.updated_at;
  if (!raw) return void 0;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? void 0 : d.toISOString();
}
async function listResources(ctx, noteId) {
  try {
    const res = await ctx.resources.list(noteId);
    return Array.isArray(res) ? res.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}
async function readResourceBlob(ctx, resource) {
  const value = await ctx.resources.read(resource.id);
  const mime = resource.mimeType ?? resource.mime ?? "application/octet-stream";
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return new Blob([value], { type: mime });
  if (value instanceof Uint8Array) return new Blob([value], { type: mime });
  const data = value?.data;
  if (data instanceof ArrayBuffer) return new Blob([data], { type: mime });
  if (data instanceof Uint8Array) return new Blob([data], { type: mime });
  throw new Error(`\u8D44\u6E90 ${resource.id} \u7684\u5185\u5BB9\u683C\u5F0F\u65E0\u6CD5\u8BFB\u53D6\uFF0C\u5DF2\u4FDD\u7559\u5360\u4F4D\u4FE1\u606F`);
}
async function createNote(ctx, input) {
  return ctx.notes.create(input);
}
async function updateNote(ctx, noteId, patch) {
  await ctx.notes.update(noteId, patch);
}

// src/sync/attachments.ts
function guessMime(resource, blob) {
  if (resource.mimeType || resource.mime) return resource.mimeType ?? resource.mime;
  if (blob.type) return blob.type;
  const ext = (resource.filename ?? resource.fileName ?? resource.name ?? "").split(".").pop()?.toLowerCase();
  const map = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown"
  };
  return ext && map[ext] || "application/octet-stream";
}
async function syncAttachments(args) {
  const { ctx, client, settings, item, pageId, resources, maxFileUploadBytes } = args;
  const result = { attached: 0, failed: 0, skipped: 0, warnings: [] };
  const body = item.markdown ?? "";
  const placeholders = parseAttachmentPlaceholders(body);
  if (placeholders.length === 0) return result;
  if (!settings.uploadAttachments) {
    result.skipped = placeholders.length;
    result.warnings.push(
      `\u300C${item.title}\u300D\u542B ${placeholders.length} \u4E2A\u672C\u5730\u9644\u4EF6\uFF1A\u6B63\u6587\u5DF2\u4FDD\u7559\u53EF\u8FFD\u6EAF\u5360\u4F4D\uFF0C\u672A\u4E0A\u4F20\u5230 Notion\uFF08\u4E0A\u4F20\u5F00\u5173\u9ED8\u8BA4\u5173\u95ED\uFF09\u3002`
    );
    return result;
  }
  const mappings = await loadResourceMappings(ctx);
  const maxBytes = Math.min(
    settings.maxAttachmentMB * 1024 * 1024,
    maxFileUploadBytes ?? Number.POSITIVE_INFINITY,
    20 * 1024 * 1024
  );
  const blocks = [];
  const touched = [];
  for (const placeholder of placeholders) {
    const resource = resources.find((r) => r.id === placeholder.id);
    if (!resource) {
      result.failed++;
      result.warnings.push(`\u9644\u4EF6 ${placeholder.filename}\uFF08${placeholder.id}\uFF09\u5728 EdgeEver \u8D44\u6E90\u5217\u8868\u4E2D\u627E\u4E0D\u5230\uFF0C\u5DF2\u4FDD\u7559\u5360\u4F4D\u3002`);
      continue;
    }
    try {
      const blob = await readResourceBlob(ctx, resource);
      const size = Math.max(
        Number(resource.size ?? 0),
        Number(blob.size ?? 0)
      );
      if (size > maxBytes) {
        result.failed++;
        mappings[resource.id] = {
          edgeeverResourceId: resource.id,
          sha256: "",
          filename: placeholder.filename,
          mimeType: guessMime(resource, blob),
          status: "failed",
          error: `\u8D85\u8FC7\u5927\u5C0F\u4E0A\u9650 ${(maxBytes / 1024 / 1024).toFixed(1)} MiB`
        };
        result.warnings.push(`\u9644\u4EF6 ${placeholder.filename} \u8D85\u8FC7\u5927\u5C0F\u4E0A\u9650\uFF0C\u9700\u5206\u5757\u4E0A\u4F20\uFF08\u540E\u7EED\u7248\u672C\u652F\u6301\uFF09\u3002`);
        continue;
      }
      const arrayBuffer = await blob.arrayBuffer();
      const fingerprint = await sha256Bytes(new Uint8Array(arrayBuffer));
      const filename = resource.filename ?? resource.fileName ?? resource.name ?? placeholder.filename;
      const mimeType = guessMime(resource, blob);
      const existing = mappings[resource.id];
      let mapping;
      if (existing?.status === "attached" && existing.sha256 === fingerprint && existing.notionFileUploadId) {
        mapping = { ...existing, filename, mimeType };
        result.skipped++;
      } else {
        const upload = await uploadSinglePart(
          client,
          { ...resource, filename, mimeType },
          new Blob([arrayBuffer], { type: mimeType })
        );
        mapping = {
          edgeeverResourceId: resource.id,
          notionFileUploadId: upload.id,
          sha256: fingerprint,
          filename,
          mimeType,
          status: "uploaded"
        };
      }
      mappings[resource.id] = mapping;
      blocks.push(attachmentBlock(mapping));
      touched.push(resource.id);
    } catch (e) {
      result.failed++;
      mappings[resource.id] = {
        edgeeverResourceId: resource.id,
        sha256: "",
        filename: placeholder.filename,
        mimeType: resource.mimeType ?? resource.mime ?? "application/octet-stream",
        status: "failed",
        error: redact(errMsg(e), settings.token)
      };
      result.warnings.push(`\u9644\u4EF6 ${placeholder.filename} \u4E0A\u4F20\u5931\u8D25\uFF1A${redact(errMsg(e), settings.token)}\uFF08\u53EF\u5728\u4E0B\u6B21\u540C\u6B65\u91CD\u8BD5\uFF09`);
    }
  }
  if (blocks.length > 0) {
    try {
      const ids = await appendChildren(client, pageId, [
        paragraphBlock(ATTACH_START),
        ...blocks,
        paragraphBlock(ATTACH_END)
      ]);
      attachedIds(mappings, touched, ids, result);
    } catch (e) {
      result.failed += blocks.length;
      result.attached = 0;
      for (const id of touched) {
        if (mappings[id]) mappings[id] = { ...mappings[id], status: "failed", error: redact(errMsg(e), settings.token) };
      }
      result.warnings.push(`\u9644\u4EF6\u533A\u6302\u8F7D\u5931\u8D25\uFF1A${redact(errMsg(e), settings.token)}\uFF08\u6587\u4EF6\u5DF2\u4E0A\u4F20\uFF0C\u53EF\u91CD\u8BD5\uFF09`);
    }
  }
  await saveResourceMappings(ctx, mappings);
  return result;
}
function attachedIds(mappings, touched, blockIds, result) {
  const mediaIds = blockIds.slice(1, 1 + touched.length);
  touched.forEach((id, index) => {
    const m = mappings[id];
    if (!m) return;
    mappings[id] = {
      ...m,
      status: "attached",
      notionBlockId: mediaIds[index] ?? m.notionBlockId,
      error: void 0
    };
    result.attached++;
  });
}

// src/sync/engine.ts
function emptyCounts() {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    unsupported: 0,
    incomplete: 0,
    failed: 0,
    deleted: 0
  };
}
function bump(counts, action) {
  switch (action) {
    case "create-notion":
    case "create-edgeever":
      counts.created++;
      break;
    case "update-notion":
    case "update-edgeever":
      counts.updated++;
      break;
    case "conflict":
      counts.conflicts++;
      break;
    case "unsupported":
      counts.unsupported++;
      break;
    case "incomplete":
      counts.incomplete++;
      break;
    case "deleted":
      counts.deleted++;
      break;
    case "error":
      counts.failed++;
      break;
    default:
      counts.skipped++;
  }
}
var SyncEngine = class {
  constructor(ctx) {
    this.ctx = ctx;
  }
  queue = new RequestQueue(340);
  connection;
  async setup() {
    const settings = await loadSettings(this.ctx);
    const configError = validateSettings(settings);
    if (configError) throw new Error(configError);
    const client = new NotionClient(
      settings,
      (url, options) => this.ctx.network.fetch(url, options),
      this.queue
    );
    const dataSourceId = await resolveDataSourceId(client, settings);
    return { settings, client, dataSourceId };
  }
  async testConnection() {
    const { client, dataSourceId } = await this.setup();
    const info = await verifyConnection(client, dataSourceId);
    this.connection = info;
    return info;
  }
  /** 一键生成/检查同步数据库。此时可能还没有 Data Source ID，因此不走 setup() 的校验。 */
  async setupDatabase() {
    const settings = await loadSettings(this.ctx);
    if (!settings.token) {
      throw new Error("\u8BF7\u5148\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u586B\u5199 Notion Integration Token\uFF08secret \u5B57\u6BB5\uFF09\u3002");
    }
    const client = new NotionClient(
      settings,
      (url, options) => this.ctx.network.fetch(url, options),
      this.queue
    );
    return ensureSyncDatabase(this.ctx, client, settings);
  }
  /**
   * 只读预览。首次全量同步必须先经过这里（规范 §14）。
   * auto=true 时只保留「已有映射且可安全单向更新」的条目，供自动同步使用。
   */
  async preview(options = {}) {
    const auto = options.auto === true;
    const { settings, client, dataSourceId } = await this.setup();
    const warnings = [];
    const counts = emptyCounts();
    const plan = [];
    const mappings = await loadMappings(this.ctx);
    const notebooks = await listNotebooks(this.ctx);
    if (auto) {
      const state = await loadState(this.ctx);
      if (!state.firstSyncDone) {
        return { plan: [], counts, warnings: ["\u9996\u6B21\u540C\u6B65\u5FC5\u987B\u7531\u7528\u6237\u624B\u52A8\u89E6\u53D1\uFF0C\u81EA\u52A8\u540C\u6B65\u5DF2\u8DF3\u8FC7\u3002"], dataSourceId, notebooks, auto };
      }
    }
    const scan = await listNotes(this.ctx, settings.notebookId);
    warnings.push(...scan.warnings);
    for (const note of scan.unsupported) {
      const item = {
        key: note.id,
        action: "unsupported",
        title: noteTitle(note),
        reason: `\u7279\u6B8A\u7B14\u8BB0\u7C7B\u578B\uFF08kind=${note.kind ?? "unknown"}\uFF09\uFF0C\u9996\u7248\u4E0D\u4EE5\u666E\u901A Markdown \u8986\u76D6\uFF0C\u5DF2\u8DF3\u8FC7\u3002`,
        edgeeverNoteId: note.id,
        note
      };
      pushItem(plan, counts, item, auto);
    }
    const query = await queryAllPages(client, dataSourceId);
    if (query.incomplete) {
      warnings.push("Data Source \u67E5\u8BE2\u7ED3\u679C\u8FBE\u5230 10,000 \u6761\u4E0A\u9650\uFF0C\u672C\u6B21\u4E0D\u662F\u5B8C\u6574\u6570\u636E\u96C6\uFF0C\u8BF7\u6309\u65F6\u95F4\u8303\u56F4\u5206\u6279\u540C\u6B65\u3002");
    }
    const activePages = query.pages.filter((p) => !p.in_trash && !p.is_archived);
    const archivedPages = query.pages.filter((p) => p.in_trash || p.is_archived);
    for (const page of archivedPages) {
      warnings.push(`Notion \u9875\u9762 ${page.id} \u5DF2\u5F52\u6863\u6216\u79FB\u5165\u56DE\u6536\u7AD9\uFF1B\u53EA\u63D0\u793A\uFF0C\u4E0D\u81EA\u52A8\u5220\u9664 EdgeEver \u7B14\u8BB0\u3002`);
    }
    const pageByEeId = /* @__PURE__ */ new Map();
    for (const page of activePages) {
      const eeId = plainText(page.properties?.[settings.props.edgeeverId]).trim();
      if (eeId) pageByEeId.set(eeId, page);
    }
    const knownEeIds = new Set(scan.supported.map((n) => n.id));
    for (const note of scan.supported) {
      const resources = await listResources(this.ctx, note.id);
      const title = noteTitle(note);
      const tags = noteTags(note);
      const mapping = mappings[note.id];
      const base = {
        key: note.id,
        action: "skip",
        title,
        reason: "",
        edgeeverNoteId: note.id,
        notionPageId: mapping?.notionPageId,
        note,
        noteTitle: title,
        tags,
        resources
      };
      if (mapping?.status === "deleted") {
        pushItem(plan, counts, {
          ...base,
          action: "deleted",
          reason: "\u8BE5\u6620\u5C04\u5DF2\u6807\u8BB0\u4E3A\u5220\u9664\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u91CD\u5EFA\u6216\u6C38\u4E45\u5220\u9664\u4EFB\u4E00\u7AEF\u6570\u636E\u3002\u53EF\u5728\u9762\u677F\u6267\u884C\u300C\u6062\u590D\u540C\u6B65\u300D\u3002"
        }, auto);
        continue;
      }
      if (!mapping) {
        const existing = pageByEeId.get(note.id);
        if (existing) {
          pushItem(plan, counts, {
            ...base,
            action: "skip",
            notionPageId: existing.id,
            page: existing,
            reason: "Notion \u5DF2\u5B58\u5728\u76F8\u540C EdgeEver ID \u7684\u9875\u9762\uFF0C\u5C06\u5728\u6267\u884C\u65F6\u4FEE\u590D\u672C\u5730\u6620\u5C04\uFF0C\u4E0D\u91CD\u590D\u521B\u5EFA\u3002"
          }, auto);
        } else if (settings.direction === "pull") {
          pushItem(plan, counts, { ...base, reason: "\u4EC5\u62C9\u53D6\u6A21\u5F0F\u4E0B\u4E0D\u5411 Notion \u63A8\u9001\u65B0\u7B14\u8BB0\u3002" }, auto);
        } else {
          pushItem(plan, counts, {
            ...base,
            action: "create-notion",
            markdown: toNotionMarkdown(note.contentMarkdown ?? "", resources),
            reason: "\u672C\u5730\u7B14\u8BB0\u5C1A\u65E0\u6620\u5C04\uFF0C\u5C06\u5728\u786E\u8BA4\u540E\u521B\u5EFA Notion \u9875\u9762\u3002"
          }, auto);
        }
        continue;
      }
      let page = activePages.find((p) => p.id === mapping.notionPageId);
      if (!page) {
        try {
          page = await retrievePage(client, mapping.notionPageId);
        } catch {
          page = void 0;
        }
      }
      if (!page || page.in_trash || page.is_archived) {
        pushItem(plan, counts, {
          ...base,
          action: "deleted",
          reason: "\u6620\u5C04\u6307\u5411\u7684 Notion \u9875\u9762\u4E0D\u53EF\u8BBF\u95EE\u6216\u5DF2\u5F52\u6863/\u5220\u9664\uFF1B\u4E0D\u81EA\u52A8\u91CD\u5EFA\uFF0C\u4E5F\u4E0D\u5220\u9664 EdgeEver \u7B14\u8BB0\u3002"
        }, auto);
        continue;
      }
      const remote = await getPageMarkdown(client, page.id, settings.markdownVersion);
      const reasons = incompleteReasons(remote, "read");
      if (reasons.length) {
        pushItem(plan, counts, {
          ...base,
          action: "incomplete",
          notionPageId: page.id,
          page,
          remoteMarkdown: remote.markdown ?? "",
          reason: `Notion \u6B63\u6587\u4E0D\u5B8C\u6574\uFF1A${reasons.join("\uFF1B")}\u3002\u5DF2\u8DF3\u8FC7\uFF0C\u4E0D\u4F1A\u628A\u4E0D\u5B8C\u6574\u5185\u5BB9\u5199\u56DE EdgeEver\u3002`
        }, auto);
        continue;
      }
      const edgeeverHash = await contentHash(canonicalContent(note.contentMarkdown ?? "", resources));
      const notionHash = await contentHash(canonicalContent(remote.markdown ?? "", resources));
      const decision = decide({ edgeeverHash, notionHash, mapping });
      const shared = {
        ...base,
        notionPageId: page.id,
        page,
        remoteMarkdown: remote.markdown ?? "",
        edgeeverHash,
        notionHash,
        baselineHash: mapping.lastSyncedHash
      };
      if (decision === "conflict") {
        pushItem(plan, counts, {
          ...shared,
          action: "conflict",
          reason: `${decisionLabel(decision)}\uFF1B\u9ED8\u8BA4\u4E0D\u8986\u76D6\u4EFB\u4E00\u7AEF\uFF0C\u8BF7\u5728\u9762\u677F\u9009\u62E9\u300C\u4FDD\u7559 EdgeEver\u300D\u300C\u4FDD\u7559 Notion\u300D\u6216\u300C\u7A0D\u540E\u5904\u7406\u300D\u3002`,
          resolution: "later"
        }, auto);
        continue;
      }
      if (decision === "skip" || decision === "both-same") {
        pushItem(plan, counts, {
          ...shared,
          reason: decision === "both-same" ? "\u4E24\u7AEF\u6700\u7EC8\u5185\u5BB9\u76F8\u540C\uFF0C\u4EC5\u66F4\u65B0\u540C\u6B65\u57FA\u7EBF\u3002" : "\u4E24\u7AEF\u76F8\u5BF9\u4E0A\u6B21\u540C\u6B65\u5747\u65E0\u53D8\u5316\u3002"
        }, auto);
        continue;
      }
      if (decision === "push") {
        if (settings.direction === "pull") {
          pushItem(plan, counts, { ...shared, reason: "\u4EC5\u62C9\u53D6\u6A21\u5F0F\uFF1A\u5FFD\u7565 EdgeEver \u4FA7\u4FEE\u6539\u3002" }, auto);
        } else {
          pushItem(plan, counts, {
            ...shared,
            action: "update-notion",
            markdown: toNotionMarkdown(note.contentMarkdown ?? "", resources),
            reason: "\u4EC5 EdgeEver \u4FEE\u6539\uFF0C\u5C06\u5728\u786E\u8BA4\u540E\u66F4\u65B0 Notion \u6B63\u6587\u4E0E\u5C5E\u6027\u3002"
          }, auto);
        }
        continue;
      }
      if (settings.direction === "push") {
        pushItem(plan, counts, { ...shared, reason: "\u4EC5\u63A8\u9001\u6A21\u5F0F\uFF1A\u5FFD\u7565 Notion \u4FA7\u4FEE\u6539\u3002" }, auto);
      } else {
        pushItem(plan, counts, {
          ...shared,
          action: "update-edgeever",
          markdown: toEdgeeverMarkdown(remote.markdown ?? "", resources),
          noteTitle: readTitle(page, settings.props.name) || title,
          tags: readTags(page.properties?.[settings.props.tags]),
          reason: "\u4EC5 Notion \u4FEE\u6539\uFF0C\u5C06\u5728\u786E\u8BA4\u540E\u66F4\u65B0 EdgeEver \u7B14\u8BB0\u3002"
        }, auto);
      }
    }
    for (const page of activePages) {
      const eeId = plainText(page.properties?.[settings.props.edgeeverId]).trim();
      if (eeId && knownEeIds.has(eeId)) continue;
      const title = readTitle(page, settings.props.name) || `Notion \u9875\u9762 ${page.id.slice(0, 8)}`;
      const base = {
        key: page.id,
        action: "skip",
        title,
        reason: "",
        notionPageId: page.id,
        page,
        noteTitle: title,
        tags: readTags(page.properties?.[settings.props.tags]),
        resources: []
      };
      if (eeId) {
        const mapping = mappings[eeId];
        pushItem(plan, counts, {
          ...base,
          action: "deleted",
          edgeeverNoteId: eeId,
          reason: mapping?.status === "deleted" ? "\u6620\u5C04\u5DF2\u6807\u8BB0\u4E3A\u5220\u9664\uFF0C\u4E0D\u81EA\u52A8\u6062\u590D\u6216\u5220\u9664\u3002" : "\u8FDC\u7AEF\u9875\u9762\u5E26\u6709 EdgeEver ID\uFF0C\u4F46\u5BF9\u5E94\u7B14\u8BB0\u4E0D\u5728\u6240\u9009\u7B14\u8BB0\u672C\u4E2D\u6216\u5DF2\u88AB\u5220\u9664\uFF1B\u4E0D\u505A\u81EA\u52A8\u5220\u9664\u3002"
        }, auto);
        continue;
      }
      if (settings.direction === "push") {
        warnings.push(`Notion \u9875\u9762\u300C${title}\u300D\u6CA1\u6709 EdgeEver ID \u5C5E\u6027\uFF1B\u4EC5\u63A8\u9001\u6A21\u5F0F\u4E0B\u5DF2\u5FFD\u7565\u3002`);
        continue;
      }
      const remote = await getPageMarkdown(client, page.id, settings.markdownVersion);
      const reasons = incompleteReasons(remote, "read");
      if (reasons.length) {
        pushItem(plan, counts, {
          ...base,
          action: "incomplete",
          remoteMarkdown: remote.markdown ?? "",
          reason: `Notion \u6B63\u6587\u4E0D\u5B8C\u6574\uFF1A${reasons.join("\uFF1B")}\u3002\u5DF2\u8DF3\u8FC7\u3002`
        }, auto);
        continue;
      }
      pushItem(plan, counts, {
        ...base,
        action: "create-edgeever",
        remoteMarkdown: remote.markdown ?? "",
        markdown: toEdgeeverMarkdown(remote.markdown ?? "", []),
        reason: "Notion \u9875\u9762\u5C1A\u65E0 EdgeEver ID\uFF0C\u5C06\u5728\u786E\u8BA4\u540E\u521B\u5EFA EdgeEver \u7B14\u8BB0\u5E76\u56DE\u5199\u6620\u5C04\u3002"
      }, auto);
    }
    if (!auto) await saveState(this.ctx, { ...await loadState(this.ctx), lastPreviewAt: nowIso() });
    return { plan, counts, warnings, dataSourceId, notebooks, auto };
  }
  /** 执行计划。每条独立失败不影响整批；冲突默认「稍后处理」。 */
  async apply(plan, resolutions = {}, onProgress) {
    const { settings, client, dataSourceId } = await this.setup();
    const report = {
      startedAt: nowIso(),
      finishedAt: "",
      direction: settings.direction,
      counts: emptyCounts(),
      warnings: [],
      items: []
    };
    const mappings = await loadMappings(this.ctx);
    const maxFileUploadBytes = this.connection?.maxFileUploadBytes;
    let done = 0;
    for (const item of plan) {
      done++;
      onProgress?.(done, plan.length, item);
      let resolution = item.resolution ?? "later";
      if (item.action === "conflict" && resolutions[item.key]) resolution = resolutions[item.key];
      try {
        const result = await this.applyItem({
          settings,
          client,
          dataSourceId,
          mappings,
          item,
          resolution,
          maxFileUploadBytes
        });
        report.items.push({ key: item.key, title: item.title, action: result.action, message: result.message });
        bump(report.counts, result.action);
        if (result.warnings?.length) report.warnings.push(...result.warnings);
      } catch (e) {
        let message = redact(errMsg(e), settings.token);
        if (e instanceof NotionError && e.maybeCommitted) {
          message += "\uFF08\u8BE5\u5199\u8BF7\u6C42\u53EF\u80FD\u5DF2\u751F\u6548\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u786E\u8BA4\uFF1B\u63D2\u4EF6\u4E0D\u4F1A\u81EA\u52A8\u91CD\u653E\u5199\u5165\uFF09";
        }
        report.items.push({ key: item.key, title: item.title, action: "error", message });
        bump(report.counts, "error");
        const id = item.edgeeverNoteId;
        if (id && mappings[id]) {
          mappings[id] = { ...mappings[id], status: "error", lastError: message };
        }
      }
    }
    await saveMappings(this.ctx, mappings);
    report.finishedAt = nowIso();
    await saveState(this.ctx, {
      ...await loadState(this.ctx),
      firstSyncDone: true,
      lastSyncAt: report.finishedAt
    });
    await saveReport(this.ctx, report);
    await clearPending(this.ctx);
    return report;
  }
  async applyItem(task) {
    const { item, resolution } = task;
    if (item.action === "conflict" && (resolution === "edgeever" || resolution === "notion")) {
      const forced = {
        ...item,
        action: resolution === "edgeever" ? "update-notion" : "update-edgeever",
        markdown: resolution === "edgeever" ? toNotionMarkdown(item.note?.contentMarkdown ?? "", item.resources ?? []) : toEdgeeverMarkdown(item.remoteMarkdown ?? "", item.resources ?? []),
        noteTitle: resolution === "notion" ? readTitle(item.page, task.settings.props.name) || item.title : item.title,
        tags: resolution === "notion" ? readTags(item.page?.properties?.[task.settings.props.tags]) : item.tags
      };
      return this.applyItem({ ...task, item: forced, resolution: "later" });
    }
    switch (item.action) {
      case "create-notion":
        return this.createNotion(task);
      case "update-notion":
        return this.updateNotion(task);
      case "create-edgeever":
        return this.createEdgeever(task);
      case "update-edgeever":
        return this.updateEdgeever(task);
      case "skip":
        if (item.reason.includes("\u4FEE\u590D\u672C\u5730\u6620\u5C04") && item.page && item.edgeeverNoteId) {
          await this.saveRecoveredMapping(task, item.edgeeverNoteId, item.page.id);
          return { action: "skip", message: "\u5DF2\u4FEE\u590D\u672C\u5730\u6620\u5C04\uFF0C\u672A\u91CD\u590D\u521B\u5EFA\u9875\u9762\u3002" };
        }
        return { action: "skip", message: item.reason || "\u65E0\u9700\u5199\u5165\u3002" };
      default:
        return { action: item.action, message: item.reason };
    }
  }
  async saveRecoveredMapping(task, noteId, pageId) {
    const { client, settings, mappings, item } = task;
    const remote = await getPageMarkdown(client, pageId, settings.markdownVersion);
    const eHash = await contentHash(canonicalContent(item.note?.contentMarkdown ?? "", item.resources ?? []));
    const nHash = await contentHash(canonicalContent(remote.markdown ?? "", item.resources ?? []));
    mappings[noteId] = {
      edgeeverNoteId: noteId,
      notionPageId: pageId,
      edgeeverNotebookId: settings.notebookId,
      lastSyncedHash: eHash,
      lastEdgeEverHash: eHash,
      lastNotionHash: nHash,
      lastSyncedAt: nowIso(),
      status: "synced",
      title: item.title
    };
  }
  async createNotion(task) {
    const { settings, client, dataSourceId, mappings, item } = task;
    const noteId = item.edgeeverNoteId;
    if (mappings[noteId]) return { action: "skip", message: "\u6620\u5C04\u5DF2\u5B58\u5728\uFF0C\u8DF3\u8FC7\u521B\u5EFA\uFF08\u5E42\u7B49\u4FDD\u62A4\uFF09\u3002" };
    const existing = await findPageByEdgeeverId(client, dataSourceId, settings.props.edgeeverId, noteId);
    if (existing) {
      await this.saveRecoveredMapping({ ...task, item: { ...item, page: existing } }, noteId, existing.id);
      return { action: "skip", message: "\u8FDC\u7AEF\u5DF2\u5B58\u5728\u540C ID \u9875\u9762\uFF0C\u5DF2\u4FEE\u590D\u6620\u5C04\uFF0C\u672A\u91CD\u590D\u521B\u5EFA\u3002" };
    }
    const page = await createPage(client, settings, dataSourceId, {
      title: item.title,
      edgeeverId: noteId,
      markdown: item.markdown ?? ""
    });
    const warnings = await this.writeMetadata(task, page.id, noteId, "Synced");
    const attach = await syncAttachments({
      ctx: this.ctx,
      client,
      settings,
      item,
      pageId: page.id,
      resources: item.resources ?? [],
      maxFileUploadBytes: task.maxFileUploadBytes
    });
    warnings.push(...attach.warnings);
    warnings.push(...await this.finalize(task, noteId, page.id, item.note?.contentMarkdown ?? ""));
    return {
      action: "create-notion",
      message: `\u5DF2\u521B\u5EFA Notion \u9875\u9762 ${page.id}\uFF1B\u9644\u4EF6\u65B0\u589E ${attach.attached}\u3001\u590D\u7528/\u8DF3\u8FC7 ${attach.skipped}\u3001\u5931\u8D25 ${attach.failed}\u3002`,
      warnings
    };
  }
  async updateNotion(task) {
    const { settings, client, mappings, item } = task;
    const pageId = item.notionPageId;
    const noteId = item.edgeeverNoteId;
    const resources = item.resources ?? [];
    const fresh = await getPageMarkdown(client, pageId, settings.markdownVersion);
    const reasons = incompleteReasons(fresh, "read");
    if (reasons.length) throw new Error(`Notion \u6B63\u6587\u5728\u540C\u6B65\u65F6\u53D8\u4E3A\u4E0D\u5B8C\u6574\u72B6\u6001\uFF1A${reasons.join("\uFF1B")}`);
    const freshHash = await contentHash(canonicalContent(fresh.markdown ?? "", resources));
    if (item.notionHash && freshHash !== item.notionHash) {
      return { action: "skip", message: "\u8FDC\u7AEF\u6B63\u6587\u5728\u9884\u89C8\u4E4B\u540E\u53D1\u751F\u53D8\u5316\uFF0C\u5DF2\u8DF3\u8FC7\u672C\u6B21\u5199\u5165\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u3002" };
    }
    await replacePageMarkdown(client, pageId, item.markdown ?? "", settings.markdownVersion);
    const warnings = await this.writeMetadata(task, pageId, noteId, "Synced");
    const attach = await syncAttachments({
      ctx: this.ctx,
      client,
      settings,
      item,
      pageId,
      resources,
      maxFileUploadBytes: task.maxFileUploadBytes
    });
    warnings.push(...attach.warnings);
    warnings.push(...await this.finalize(task, noteId, pageId, item.note?.contentMarkdown ?? ""));
    return {
      action: "update-notion",
      message: `\u5DF2\u66F4\u65B0 Notion \u9875\u9762 ${pageId}\uFF1B\u9644\u4EF6\u65B0\u589E ${attach.attached}\u3001\u590D\u7528/\u8DF3\u8FC7 ${attach.skipped}\u3001\u5931\u8D25 ${attach.failed}\u3002`,
      warnings
    };
  }
  async createEdgeever(task) {
    const { settings, client, mappings, item } = task;
    const pageId = item.notionPageId;
    const page = await retrievePage(client, pageId);
    const existingId = plainText(page.properties?.[settings.props.edgeeverId]).trim();
    if (existingId && mappings[existingId]) {
      return { action: "skip", message: "\u8BE5\u9875\u9762\u5DF2\u5EFA\u7ACB\u6620\u5C04\uFF0C\u8DF3\u8FC7\u521B\u5EFA EdgeEver \u7B14\u8BB0\u3002" };
    }
    const created = await createNote(this.ctx, {
      notebookId: settings.notebookId,
      title: item.noteTitle ?? item.title,
      contentMarkdown: item.markdown ?? "",
      tags: item.tags ?? []
    });
    const noteId = created.id;
    const warnings = [];
    try {
      await patchProperties(client, pageId, requiredProperties(settings, item.noteTitle ?? item.title, noteId));
    } catch (e) {
      warnings.push(`\u56DE\u5199 EdgeEver ID \u5230 Notion \u5C5E\u6027\u5931\u8D25\uFF1A${redact(errMsg(e), settings.token)}\uFF08\u4E0B\u6B21\u540C\u6B65\u53EF\u80FD\u91CD\u590D\u521B\u5EFA\uFF0C\u8BF7\u68C0\u67E5\u5C5E\u6027\u540D\u4E0E\u7C7B\u578B\uFF09`);
    }
    warnings.push(...await this.finalize(task, noteId, pageId, item.markdown ?? ""));
    return { action: "create-edgeever", message: `\u5DF2\u521B\u5EFA EdgeEver \u7B14\u8BB0 ${noteId} \u5E76\u5199\u5165\u6620\u5C04\u3002`, warnings };
  }
  async updateEdgeever(task) {
    const { settings, client, mappings, item } = task;
    const pageId = item.notionPageId;
    const noteId = item.edgeeverNoteId;
    const resources = item.resources ?? [];
    const fresh = await getPageMarkdown(client, pageId, settings.markdownVersion);
    const reasons = incompleteReasons(fresh, "read");
    if (reasons.length) throw new Error(`Notion \u6B63\u6587\u5728\u540C\u6B65\u65F6\u53D8\u4E3A\u4E0D\u5B8C\u6574\u72B6\u6001\uFF1A${reasons.join("\uFF1B")}`);
    const freshHash = await contentHash(canonicalContent(fresh.markdown ?? "", resources));
    if (item.notionHash && freshHash !== item.notionHash) {
      return { action: "skip", message: "\u8FDC\u7AEF\u6B63\u6587\u5728\u9884\u89C8\u4E4B\u540E\u53D1\u751F\u53D8\u5316\uFF0C\u5DF2\u8DF3\u8FC7\u672C\u6B21\u5199\u5165\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u3002" };
    }
    await updateNote(this.ctx, noteId, {
      title: item.noteTitle ?? item.title,
      contentMarkdown: item.markdown ?? "",
      tags: item.tags ?? []
    });
    const warnings = await this.writeMetadata(task, pageId, noteId, "Synced");
    warnings.push(...await this.finalize(task, noteId, pageId, item.markdown ?? ""));
    return { action: "update-edgeever", message: `\u5DF2\u66F4\u65B0 EdgeEver \u7B14\u8BB0 ${noteId}\u3002`, warnings };
  }
  /** 属性更新分两步：必需属性、可选属性；失败只记警告，不回滚已成功的正文写入。 */
  async writeMetadata(task, pageId, noteId, status) {
    const { settings, client, item } = task;
    const warnings = [];
    try {
      await patchProperties(client, pageId, requiredProperties(settings, item.noteTitle ?? item.title, noteId));
    } catch (e) {
      warnings.push(`\u66F4\u65B0\u6807\u9898/EdgeEver ID \u5C5E\u6027\u5931\u8D25\uFF1A${redact(errMsg(e), settings.token)}`);
    }
    try {
      const optional = optionalProperties(settings, {
        notebookId: settings.notebookId,
        tags: item.tags ?? [],
        contentHash: item.edgeeverHash,
        lastSynced: nowIso(),
        syncStatus: status,
        edgeeverUpdated: (item.note ? noteUpdatedAt(item.note) : void 0) ?? nowIso()
      });
      await patchProperties(client, pageId, optional);
    } catch (e) {
      warnings.push(
        `\u66F4\u65B0\u53EF\u9009\u5C5E\u6027\u5931\u8D25\uFF08\u8BF7\u68C0\u67E5\u6570\u636E\u5E93\u4E2D Tags/Hash/Last Synced/Sync Status \u7684\u7C7B\u578B\uFF09\uFF1A${redact(errMsg(e), settings.token)}`
      );
    }
    return warnings;
  }
  /** 写入后回读 Notion，保存双基线 Hash，避免下次同步出现假冲突。 */
  async finalize(task, noteId, pageId, edgeeverMarkdown) {
    const { settings, client, mappings, item } = task;
    const resources = item.resources ?? [];
    const remote = await getPageMarkdown(client, pageId, settings.markdownVersion);
    const warnings = incompleteReasons(remote, "write").map(
      (r) => `\u9875\u9762 ${pageId} \u5199\u5165\u540E\u56DE\u8BFB\uFF1A${r}\u3002\u8BF7\u5728 Notion \u4E2D\u6838\u5BF9\u540E\u518D\u6267\u884C\u4E0B\u4E00\u6B21\u540C\u6B65\u3002`
    );
    const eHash = await contentHash(canonicalContent(edgeeverMarkdown, resources));
    const nHash = await contentHash(canonicalContent(remote.markdown ?? "", resources));
    mappings[noteId] = {
      edgeeverNoteId: noteId,
      notionPageId: pageId,
      edgeeverNotebookId: settings.notebookId,
      lastSyncedHash: eHash,
      lastEdgeEverHash: eHash,
      lastNotionHash: nHash,
      lastSyncedAt: nowIso(),
      status: "synced",
      title: item.noteTitle ?? item.title
    };
    return warnings;
  }
};
function pushItem(plan, counts, item, auto) {
  if (auto) {
    const safe = item.action === "update-notion" || item.action === "update-edgeever" || item.action === "skip";
    if (!safe) return;
    if (item.action !== "skip" && !item.edgeeverNoteId) return;
  }
  plan.push(item);
  bump(counts, item.action);
}

// src/ui/panel.ts
var PANEL_ID = "notion-sync-panel";
var ACTION_LABEL = {
  "create-notion": "\u65B0\u5EFA\u5230 Notion",
  "update-notion": "\u63A8\u9001\u66F4\u65B0",
  "create-edgeever": "\u65B0\u5EFA\u5230 EdgeEver",
  "update-edgeever": "\u62C9\u53D6\u66F4\u65B0",
  skip: "\u8DF3\u8FC7",
  conflict: "\u51B2\u7A81",
  unsupported: "\u7279\u6B8A\u7B14\u8BB0",
  incomplete: "\u5185\u5BB9\u4E0D\u5B8C\u6574",
  deleted: "\u5220\u9664/\u5F52\u6863\u63D0\u793A",
  error: "\u5931\u8D25"
};
function openSyncPanel(ctx) {
  return ctx.ui.panels.open(PANEL_ID);
}
function registerPanel(ctx, engine) {
  return ctx.ui.panels.register({
    id: PANEL_ID,
    title: "Notion \u540C\u6B65",
    purpose: "workflow",
    presentation: "dialog",
    mount(container, { shell, state }) {
      const root = document.createElement("div");
      root.className = "ens-panel";
      container.append(root);
      let disposed = false;
      let busy = false;
      let tab = "overview";
      let query = "";
      let preview = null;
      let report = null;
      let resolutions = {};
      let connectionText = "\u5C1A\u672A\u6D4B\u8BD5";
      let notice = "";
      let progress = { done: 0, total: 0 };
      let settings = loadSettings(ctx);
      let settingsSnapshot = {
        notebookId: "",
        direction: "bidirectional",
        tokenConfigured: false,
        customApiBase: false
      };
      let notebooks = [];
      let mappingCount = 0;
      let deletedCount = 0;
      let firstSyncDone = false;
      let lastSyncAt = "";
      let confirmChecked = false;
      let setupText = "";
      let setupDataSourceId = "";
      shell.set({
        header: {
          title: "Notion \u53CC\u5411\u540C\u6B65",
          description: "\u5148\u9884\u89C8\u3001\u540E\u6267\u884C\uFF1B\u51B2\u7A81\u9ED8\u8BA4\u4E0D\u8986\u76D6\u4EFB\u4E00\u7AEF\u3002",
          actions: [
            { id: "test", label: "\u6D4B\u8BD5\u8FDE\u63A5" },
            { id: "preview", label: "\u751F\u6210\u9884\u89C8" },
            { id: "apply", label: "\u6267\u884C\u540C\u6B65" },
            { id: "setup", label: "\u4E00\u952E\u751F\u6210\u540C\u6B65\u6570\u636E\u5E93" }
          ]
        },
        toolbar: [
          {
            type: "tabs",
            key: "tab",
            value: "overview",
            options: [
              { value: "overview", label: "\u6982\u89C8" },
              { value: "plan", label: "\u540C\u6B65\u8BA1\u5212" },
              { value: "report", label: "\u4E0A\u6B21\u7ED3\u679C" }
            ]
          },
          { type: "search", key: "q", placeholder: "\u7B5B\u9009\u7B14\u8BB0\u6807\u9898" }
        ],
        onAction(actionId) {
          if (actionId === "test") void runTest();
          if (actionId === "preview") void runPreview();
          if (actionId === "apply") void runApply();
          if (actionId === "setup") void runSetup();
        },
        onChange(key, value) {
          if (key === "tab") {
            tab = value === "plan" || value === "report" ? value : "overview";
            render();
          }
          if (key === "q") {
            query = String(value ?? "").toLowerCase();
            render();
          }
        }
      });
      async function refreshMeta() {
        const s = await loadSettings(ctx);
        settings = Promise.resolve(s);
        settingsSnapshot = {
          notebookId: s.notebookId,
          direction: s.direction,
          tokenConfigured: Boolean(s.token),
          customApiBase: isCustomApiBase(s)
        };
        const st = await loadState(ctx);
        firstSyncDone = st.firstSyncDone;
        lastSyncAt = st.lastSyncAt ?? "";
        const mappings = await loadMappings(ctx);
        mappingCount = Object.keys(mappings).length;
        deletedCount = Object.values(mappings).filter((m) => m?.status === "deleted").length;
        report = await loadReport(ctx) ?? null;
        const setupRecord = await loadSetupRecord(ctx);
        setupDataSourceId = setupRecord?.dataSourceId ?? "";
        notebooks = (await ctx.notebooks.list()).filter((n) => n && typeof n.id === "string").map((n) => ({ id: n.id, name: String(n.name ?? n.title ?? n.id) }));
        render();
      }
      function render() {
        if (disposed) return;
        const s = settingsSnapshot;
        const counts = preview?.counts;
        const warningList = [.../* @__PURE__ */ new Set([...preview?.warnings ?? [], ...report?.warnings ?? []])];
        root.innerHTML = `
          <div class="ens-status ${busy ? "ens-busy" : ""}">
            <div class="ens-row"><strong>\u8FDE\u63A5\u72B6\u6001</strong><span>${escapeHtml(connectionText)}</span></div>
            <div class="ens-row"><strong>Token</strong><span>${s.tokenConfigured ? "\u5DF2\u914D\u7F6E\uFF08\u52A0\u5BC6\u5B58\u50A8\uFF0C\u4E0D\u56DE\u663E\uFF09" : "\u672A\u914D\u7F6E"}</span></div>
            <div class="ens-row"><strong>\u540C\u6B65\u6570\u636E\u5E93</strong><span>${setupDataSourceId ? `\u5DF2\u751F\u6210 \xB7 Data Source ${escapeHtml(setupDataSourceId.slice(0, 8))}\u2026` : "\u5C1A\u672A\u751F\u6210\uFF08\u70B9\u51FB\u300C\u4E00\u952E\u751F\u6210\u540C\u6B65\u6570\u636E\u5E93\u300D\uFF09"}</span></div>
            <div class="ens-row"><strong>API \u5730\u5740</strong><span>${s.customApiBase ? "\u81EA\u5EFA\u4EE3\u7406\uFF08Token \u5C06\u53D1\u5F80\u8BE5\u5730\u5740\uFF09" : "\u5B98\u65B9 api.notion.com"}</span></div>
            <div class="ens-row"><strong>\u5DF2\u5EFA\u7ACB\u6620\u5C04</strong><span>${mappingCount} \u6761${deletedCount ? `\uFF0C\u5176\u4E2D ${deletedCount} \u6761\u6807\u8BB0\u4E3A\u5220\u9664` : ""}</span></div>
            <div class="ens-row"><strong>\u4E0A\u6B21\u540C\u6B65</strong><span>${escapeHtml(lastSyncAt || "\u5C1A\u672A\u540C\u6B65")}</span></div>
          </div>

          <div class="ens-controls">
            <label>\u540C\u6B65\u7B14\u8BB0\u672C
              <select data-control="notebook">
                <option value="">\uFF08\u672A\u9009\u62E9\uFF09</option>
                ${notebooks.map((n) => `<option value="${escapeHtml(n.id)}" ${n.id === s.notebookId ? "selected" : ""}>${escapeHtml(n.name)}</option>`).join("")}
              </select>
            </label>
            <label>\u540C\u6B65\u65B9\u5411
              <select data-control="direction">
                <option value="bidirectional" ${s.direction === "bidirectional" ? "selected" : ""}>\u53CC\u5411\uFF08\u51B2\u7A81\u9700\u4EBA\u5DE5\u5904\u7406\uFF09</option>
                <option value="push" ${s.direction === "push" ? "selected" : ""}>\u4EC5\u63A8\u9001\u5230 Notion</option>
                <option value="pull" ${s.direction === "pull" ? "selected" : ""}>\u4EC5\u62C9\u53D6\u5230 EdgeEver</option>
              </select>
            </label>
          </div>

          <div class="ens-actions">
            <button data-action="setup">\u4E00\u952E\u751F\u6210\u540C\u6B65\u6570\u636E\u5E93</button>
            <button data-action="test">\u6D4B\u8BD5\u8FDE\u63A5</button>
            <button data-action="preview">\u751F\u6210\u9884\u89C8</button>
            <button data-action="apply" ${!preview || busy ? "disabled" : ""}>\u6267\u884C\u540C\u6B65\uFF08${preview?.plan.length ?? 0} \u9879\uFF09</button>
            <button data-action="restore">\u6062\u590D\u5220\u9664\u6620\u5C04\uFF08${deletedCount}\uFF09</button>
            <button data-action="retry" ${!report || busy ? "disabled" : ""}>\u91CD\u8BD5\u5931\u8D25\u9879</button>
          </div>

          <label class="ens-confirm">
            <input type="checkbox" data-control="confirm" ${confirmChecked ? "checked" : ""}/>
            \u6211\u5DF2\u9605\u8BFB\u4E0B\u65B9\u540C\u6B65\u8BA1\u5212\uFF0C\u786E\u8BA4\u6267\u884C\u4E0A\u8FF0\u5199\u5165\uFF08\u9996\u6B21\u5168\u91CF\u540C\u6B65\u4E0D\u4F1A\u81EA\u52A8\u5F00\u59CB\uFF09
          </label>

          ${notice ? `<div class="ens-notice">${escapeHtml(notice)}</div>` : ""}
          ${setupText ? `<div class="ens-notice">${escapeHtml(setupText)}</div>` : ""}
          ${progress.total ? `<div class="ens-progress">\u6267\u884C\u8FDB\u5EA6\uFF1A${progress.done} / ${progress.total}</div>` : ""}

          ${counts ? `
            <div class="ens-summary">
              <span>\u65B0\u589E ${counts.created}</span><span>\u66F4\u65B0 ${counts.updated}</span>
              <span>\u8DF3\u8FC7 ${counts.skipped}</span><span class="ens-warn">\u51B2\u7A81 ${counts.conflicts}</span>
              <span class="ens-warn">\u7279\u6B8A\u7B14\u8BB0 ${counts.unsupported}</span>
              <span class="ens-warn">\u4E0D\u5B8C\u6574 ${counts.incomplete}</span>
              <span>\u5220\u9664\u63D0\u793A ${counts.deleted}</span><span>\u5931\u8D25 ${counts.failed}</span>
            </div>` : ""}

          ${warningList.length ? `<div class="ens-warnings"><strong>\u63D0\u793A\u4E0E\u8B66\u544A</strong><ul>${warningList.map((w) => `<li>${escapeHtml(truncate(w, 400))}</li>`).join("")}</ul></div>` : ""}

          <div class="ens-list">
            ${tab === "overview" ? overviewHtml() : tab === "plan" ? planHtml() : reportHtml()}
          </div>
        `;
      }
      function overviewHtml() {
        return `
          <h3>\u4F7F\u7528\u8BF4\u660E</h3>
          <ol>
            <li>\u5728 Notion \u65B0\u5EFA\u4E00\u4E2A\u7A7A\u9875\u9762\uFF0C\u5728\u8BE5\u9875\u9762\u300C\xB7\xB7\xB7 \u2192 Connections\u300D\u4E2D\u6DFB\u52A0 Integration\uFF1BToken \u9700\u5177\u5907 Read / Update / Insert content \u80FD\u529B\u3002</li>
            <li>\u63D2\u4EF6\u8BBE\u7F6E\u91CC\u586B\u5199 Token \u4E0E\u300CNotion \u7236\u9875\u9762 ID\u300D\uFF08\u53EF\u7C98\u8D34\u9875\u9762\u94FE\u63A5\uFF09\uFF0C\u70B9\u51FB\u672C\u9762\u677F\u7684\u300C\u4E00\u952E\u751F\u6210\u540C\u6B65\u6570\u636E\u5E93\u300D\uFF1A\u63D2\u4EF6\u81EA\u52A8\u5EFA\u5E93\u3001\u5EFA\u597D\u5168\u90E8\u5C5E\u6027\u5E76\u4FDD\u5B58 Data Source ID\uFF0C\u65E0\u9700\u624B\u52A8\u590D\u5236\u4EFB\u4F55 ID\u3002</li>
            <li>\u5DF2\u6709\u6570\u636E\u5E93\u4E5F\u53EF\u5728\u8BBE\u7F6E\u91CC\u76F4\u63A5\u586B Data Source ID / \u6570\u636E\u5E93 ID\uFF1B\u6B64\u65F6\u4E00\u952E\u751F\u6210\u53EA\u68C0\u67E5\u5E76\u8865\u9F50\u7F3A\u5931\u5C5E\u6027\uFF0C\u4E0D\u4F1A\u91CD\u590D\u5EFA\u5E93\u3002</li>
            <li>\u9009\u62E9\u7B14\u8BB0\u672C \u2192 \u6D4B\u8BD5\u8FDE\u63A5 \u2192 \u751F\u6210\u9884\u89C8 \u2192 \u52FE\u9009\u786E\u8BA4 \u2192 \u6267\u884C\u540C\u6B65\u3002</li>
          </ol>
          <p>\u4E00\u952E\u751F\u6210\u4E0D\u4F1A\u5220\u9664\u6216\u6539\u7C7B\u578B\u4EFB\u4F55\u5DF2\u6709\u5C5E\u6027\uFF1B\u7C7B\u578B\u4E0D\u5339\u914D\u53EA\u4F1A\u63D0\u793A\uFF0C\u9700\u624B\u52A8\u5728 Notion \u4E2D\u8C03\u6574\u3002\u7279\u6B8A\u7B14\u8BB0\u4E0E\u4E0D\u5B8C\u6574\u7684 Notion Markdown \u4E00\u5F8B\u8DF3\u8FC7\uFF0C\u4E0D\u4F1A\u88AB\u666E\u901A Markdown \u8986\u76D6\u3002</p>
          <p>\u7279\u6B8A\u7B14\u8BB0\uFF08\u601D\u7EF4\u5BFC\u56FE\u3001\u8868\u683C\u3001\u6D77\u62A5\u3001\u4FE1\u606F\u56FE\u7B49\uFF09\u4E0E\u4E0D\u5B8C\u6574\u7684 Notion Markdown \u4E00\u5F8B\u8DF3\u8FC7\u5E76\u63D0\u793A\uFF0C\u4E0D\u4F1A\u88AB\u666E\u901A Markdown \u8986\u76D6\u3002</p>
          <p>\u5220\u9664\u91C7\u7528\u8F6F\u5220\u9664\u7B56\u7565\uFF1A\u53EA\u6807\u8BB0\u6620\u5C04\u5E76\u63D0\u793A\uFF0C\u4E0D\u81EA\u52A8\u6C38\u4E45\u5220\u9664\u4EFB\u4E00\u7AEF\u6570\u636E\u3002</p>
        `;
      }
      function planHtml() {
        if (!preview) return `<p class="ens-empty">\u5C1A\u672A\u751F\u6210\u9884\u89C8\u3002\u70B9\u51FB\u300C\u751F\u6210\u9884\u89C8\u300D\u67E5\u770B\u5C06\u8981\u53D1\u751F\u7684\u64CD\u4F5C\u3002</p>`;
        const items = filtered(preview.plan);
        if (!items.length) return `<p class="ens-empty">\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u8BA1\u5212\u9879\u3002</p>`;
        return items.map((item) => {
          const isConflict = item.action === "conflict";
          const chosen = resolutions[item.key] ?? item.resolution ?? "later";
          return `
              <div class="ens-item ens-${escapeHtml(item.action)}">
                <div class="ens-item-head">
                  <span class="ens-badge">${escapeHtml(ACTION_LABEL[item.action])}</span>
                  <strong>${escapeHtml(item.title)}</strong>
                </div>
                <div class="ens-reason">${escapeHtml(item.reason)}</div>
                ${isConflict ? `
                  <div class="ens-conflict">
                    <span>\u51B2\u7A81\u5904\u7406\uFF1A</span>
                    <button data-action="resolve" data-key="${escapeHtml(item.key)}" data-value="edgeever" class="${chosen === "edgeever" ? "ens-active" : ""}">\u4FDD\u7559 EdgeEver</button>
                    <button data-action="resolve" data-key="${escapeHtml(item.key)}" data-value="notion" class="${chosen === "notion" ? "ens-active" : ""}">\u4FDD\u7559 Notion</button>
                    <button data-action="resolve" data-key="${escapeHtml(item.key)}" data-value="later" class="${chosen === "later" ? "ens-active" : ""}">\u7A0D\u540E\u5904\u7406</button>
                  </div>` : ""}
              </div>`;
        }).join("");
      }
      function reportHtml() {
        if (!report) return `<p class="ens-empty">\u5C1A\u65E0\u540C\u6B65\u62A5\u544A\u3002</p>`;
        const items = (report.items ?? []).filter((i) => !query || i.title.toLowerCase().includes(query));
        return `
          <div class="ens-report-meta">\u5F00\u59CB ${escapeHtml(report.startedAt)} \xB7 \u7ED3\u675F ${escapeHtml(report.finishedAt)} \xB7 \u65B9\u5411 ${escapeHtml(report.direction)}</div>
          ${items.length ? items.map((i) => `
            <div class="ens-item ens-${escapeHtml(i.action)}">
              <div class="ens-item-head"><span class="ens-badge">${escapeHtml(ACTION_LABEL[i.action] ?? i.action)}</span><strong>${escapeHtml(i.title)}</strong></div>
              <div class="ens-reason">${escapeHtml(truncate(i.message, 600))}</div>
            </div>`).join("") : `<p class="ens-empty">\u6CA1\u6709\u5339\u914D\u7684\u8BB0\u5F55\u3002</p>`}
        `;
      }
      function filtered(items) {
        return items.filter((i) => !query || i.title.toLowerCase().includes(query));
      }
      function setBusy(value, message = "") {
        busy = value;
        notice = message;
        render();
      }
      async function currentSettings() {
        return settings;
      }
      async function runSetup() {
        if (busy) return;
        setBusy(true, "\u6B63\u5728\u751F\u6210/\u68C0\u67E5\u540C\u6B65\u6570\u636E\u5E93\u2026");
        try {
          const result = await engine.setupDatabase();
          setupText = result.message;
          await refreshMeta();
          setBusy(
            false,
            result.created ? `\u540C\u6B65\u6570\u636E\u5E93\u5DF2\u751F\u6210\uFF0CData Source ID \u5DF2\u81EA\u52A8\u4FDD\u5B58\uFF08${result.record.dataSourceId.slice(0, 8)}\u2026\uFF09\uFF0C\u73B0\u5728\u53EF\u4EE5\u6D4B\u8BD5\u8FDE\u63A5\u3002` : "\u540C\u6B65\u6570\u636E\u5E93\u68C0\u67E5\u5B8C\u6210\uFF0C\u672A\u91CD\u590D\u5EFA\u5E93\u3002"
          );
          ctx.ui.showNotice(result.created ? "Notion \u540C\u6B65\u6570\u636E\u5E93\u5DF2\u751F\u6210" : "Notion \u540C\u6B65\u6570\u636E\u5E93\u68C0\u67E5\u5B8C\u6210");
        } catch (e) {
          const s = await currentSettings();
          setupText = "";
          setBusy(false, redact(errMsg(e), s.token));
        }
      }
      async function runTest() {
        if (busy) return;
        setBusy(true, "\u6B63\u5728\u9A8C\u8BC1 Token \u4E0E Data Source \u8BBF\u95EE\u6743\u9650\u2026");
        try {
          const info = await engine.testConnection();
          connectionText = `\u5DF2\u8FDE\u63A5\uFF1A${info.workspaceName || info.botName || "Notion \u5DE5\u4F5C\u533A"} \xB7 Data Source ${info.dataSourceId.slice(0, 8)}\u2026`;
          setBusy(false, "\u8FDE\u63A5\u9A8C\u8BC1\u901A\u8FC7\u3002Token \u6709\u6548\u4E14 Integration \u5DF2\u83B7\u6388\u6743\u8BBF\u95EE\u76EE\u6807 Data Source\u3002");
          ctx.ui.showNotice("Notion \u8FDE\u63A5\u9A8C\u8BC1\u901A\u8FC7");
        } catch (e) {
          connectionText = "\u8FDE\u63A5\u5931\u8D25";
          const s = await currentSettings();
          setBusy(false, redact(errMsg(e), s.token));
        }
      }
      async function runPreview() {
        if (busy) return;
        setBusy(true, "\u6B63\u5728\u751F\u6210\u53EA\u8BFB\u9884\u89C8\uFF08\u4E0D\u5199\u5165\u4EFB\u4E00\u7AEF\uFF09\u2026");
        try {
          preview = await engine.preview();
          resolutions = {};
          confirmChecked = false;
          await refreshMeta();
          setBusy(false, `\u9884\u89C8\u5B8C\u6210\uFF1A\u5171 ${preview.plan.length} \u9879\u3002\u8BF7\u67E5\u770B\u300C\u540C\u6B65\u8BA1\u5212\u300D\u540E\u518D\u6267\u884C\u3002`);
        } catch (e) {
          const s = await currentSettings();
          setBusy(false, redact(errMsg(e), s.token));
        }
      }
      async function runApply() {
        if (busy || !preview) {
          notice = "\u8BF7\u5148\u751F\u6210\u9884\u89C8\uFF0C\u518D\u6267\u884C\u540C\u6B65\u3002";
          render();
          return;
        }
        if (!confirmChecked) {
          notice = "\u8BF7\u5148\u52FE\u9009\u300C\u6211\u5DF2\u9605\u8BFB\u540C\u6B65\u8BA1\u5212\u5E76\u786E\u8BA4\u6267\u884C\u300D\u3002";
          render();
          return;
        }
        setBusy(true, "\u6B63\u5728\u6267\u884C\u540C\u6B65\u2026");
        progress = { done: 0, total: preview.plan.length };
        try {
          const plan = preview.plan;
          const res = { ...resolutions };
          report = await engine.apply(plan, res, (done, total) => {
            progress = { done, total };
            render();
          });
          const c = report.counts;
          setBusy(false, `\u540C\u6B65\u5B8C\u6210\uFF1A\u65B0\u589E ${c.created}\u3001\u66F4\u65B0 ${c.updated}\u3001\u8DF3\u8FC7 ${c.skipped}\u3001\u51B2\u7A81 ${c.conflicts}\u3001\u5931\u8D25 ${c.failed}\u3002`);
          ctx.ui.showNotice(`Notion \u540C\u6B65\u5B8C\u6210\uFF1A\u65B0\u589E ${c.created}\uFF0C\u66F4\u65B0 ${c.updated}`);
          await refreshMeta();
          preview = null;
          confirmChecked = false;
          render();
        } catch (e) {
          const s = await currentSettings();
          setBusy(false, redact(errMsg(e), s.token));
        } finally {
          progress = { done: 0, total: 0 };
        }
      }
      async function runRestore() {
        if (busy) return;
        try {
          const mappings = await loadMappings(ctx);
          let n = 0;
          for (const [id, m] of Object.entries(mappings)) {
            if (m?.status === "deleted") {
              if (await restoreMapping(ctx, id)) n++;
            }
          }
          await refreshMeta();
          notice = `\u5DF2\u6062\u590D ${n} \u6761\u6620\u5C04\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u9884\u89C8\u3002`;
          render();
        } catch (e) {
          const s = await currentSettings();
          notice = redact(errMsg(e), s.token);
          render();
        }
      }
      async function runRetry() {
        if (!preview || !report) {
          notice = "\u8BF7\u5148\u751F\u6210\u9884\u89C8\uFF0C\u518D\u91CD\u8BD5\u5931\u8D25\u9879\u3002";
          render();
          return;
        }
        const failed = new Set(report.items.filter((i) => i.action === "error").map((i) => i.key));
        if (!failed.size) {
          notice = "\u4E0A\u6B21\u540C\u6B65\u6CA1\u6709\u5931\u8D25\u9879\u3002";
          render();
          return;
        }
        if (!confirmChecked) {
          notice = "\u8BF7\u5148\u52FE\u9009\u786E\u8BA4\uFF0C\u518D\u91CD\u8BD5\u5931\u8D25\u9879\u3002";
          render();
          return;
        }
        setBusy(true, `\u6B63\u5728\u91CD\u8BD5 ${failed.size} \u4E2A\u5931\u8D25\u9879\u2026`);
        try {
          const subset = preview.plan.filter((i) => failed.has(i.key));
          report = await engine.apply(subset, resolutions);
          setBusy(false, `\u91CD\u8BD5\u5B8C\u6210\uFF1A\u5931\u8D25 ${report.counts.failed} \u9879\u3002`);
          await refreshMeta();
        } catch (e) {
          const s = await currentSettings();
          setBusy(false, redact(errMsg(e), s.token));
        }
      }
      function onClick(event) {
        const target = event.target;
        if (!target) return;
        const action = target.dataset?.action;
        if (!action) return;
        if (action === "test") void runTest();
        else if (action === "setup") void runSetup();
        else if (action === "preview") void runPreview();
        else if (action === "apply") void runApply();
        else if (action === "restore") void runRestore();
        else if (action === "retry") void runRetry();
        else if (action === "resolve") {
          const key = target.dataset.key;
          const value = target.dataset.value;
          if (key && value) {
            resolutions[key] = value;
            render();
          }
        }
      }
      function onChange(event) {
        const target = event.target;
        const control = target?.dataset?.control;
        if (!control) return;
        if (control === "confirm") {
          confirmChecked = target.checked;
          render();
          return;
        }
        const key = control === "notebook" ? "sync-notebook-id" : "sync-direction";
        const value = target.value;
        void (async () => {
          try {
            await ctx.settings.set(key, value);
            settingsSnapshot = control === "notebook" ? { ...settingsSnapshot, notebookId: value } : { ...settingsSnapshot, direction: value };
            preview = null;
            notice = "\u914D\u7F6E\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u91CD\u65B0\u751F\u6210\u9884\u89C8\u3002";
            render();
          } catch (e) {
            const s = await currentSettings();
            notice = `\u4FDD\u5B58\u914D\u7F6E\u5931\u8D25\uFF0C\u8BF7\u5728\u63D2\u4EF6\u8BBE\u7F6E\u4E2D\u624B\u52A8\u4FEE\u6539\uFF1A${redact(errMsg(e), s.token)}`;
            render();
          }
        })();
      }
      root.addEventListener("click", onClick);
      root.addEventListener("change", onChange);
      render();
      void refreshMeta();
      if (state?.autoPreview === true) void runPreview();
      return () => {
        disposed = true;
        root.removeEventListener("click", onClick);
        root.removeEventListener("change", onChange);
        root.remove();
      };
    },
    beforeClose() {
      return true;
    }
  });
}

// src/main.ts
function extractNoteId(payload) {
  const p = payload;
  const id = p?.note?.id ?? p?.noteId ?? p?.id;
  return typeof id === "string" && id ? id : void 0;
}
var main_default = {
  activate(context) {
    const ctx = context;
    const engine = new SyncEngine(ctx);
    const disposers = [];
    let autoTimer = null;
    let disposed = false;
    disposers.push(registerPanel(ctx, engine));
    disposers.push(
      ctx.commands.register({
        id: "notion-sync-open-panel",
        title: "Notion \u540C\u6B65\uFF1A\u6253\u5F00\u540C\u6B65\u9762\u677F",
        run: () => openSyncPanel(ctx)
      })
    );
    disposers.push(
      ctx.commands.register({
        id: "notion-sync-preview",
        title: "Notion \u540C\u6B65\uFF1A\u751F\u6210\u53EA\u8BFB\u9884\u89C8",
        run: () => ctx.ui.panels.open(PANEL_ID, { state: { autoPreview: true } })
      })
    );
    disposers.push(
      ctx.commands.register({
        id: "notion-sync-status",
        title: "Notion \u540C\u6B65\uFF1A\u67E5\u770B\u4E0A\u6B21\u7ED3\u679C",
        run: async () => {
          const [state, report, settings] = await Promise.all([
            loadState(ctx),
            loadReport(ctx),
            loadSettings(ctx)
          ]);
          const parts = [
            `Token ${settings.token ? "\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E"}`,
            `\u7B14\u8BB0\u672C ${settings.notebookId || "\u672A\u9009\u62E9"}`,
            `\u65B9\u5411 ${settings.direction}`,
            `\u9996\u6B21\u540C\u6B65 ${state.firstSyncDone ? "\u5DF2\u5B8C\u6210" : "\u672A\u8FDB\u884C"}`
          ];
          if (report) {
            const c = report.counts;
            parts.push(`\u4E0A\u6B21\uFF1A\u65B0\u589E ${c.created} / \u66F4\u65B0 ${c.updated} / \u51B2\u7A81 ${c.conflicts} / \u5931\u8D25 ${c.failed}`);
          }
          ctx.ui.showNotice(`Notion \u540C\u6B65 \xB7 ${parts.join(" \xB7 ")}`);
        }
      })
    );
    const scheduleAutoSync = async (noteId) => {
      try {
        const settings = await loadSettings(ctx);
        if (!settings.autoSync) return;
        const state = await loadState(ctx);
        if (!state.firstSyncDone) return;
        if (noteId) await addPending(ctx, [noteId]);
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(async () => {
          if (disposed) return;
          try {
            const result = await engine.preview({ auto: true });
            if (!result.plan.length) return;
            const report = await engine.apply(result.plan, {});
            if (report.counts.failed > 0) {
              ctx.ui.showNotice(`Notion \u81EA\u52A8\u540C\u6B65\u6709 ${report.counts.failed} \u9879\u5931\u8D25\uFF0C\u8BF7\u6253\u5F00\u540C\u6B65\u9762\u677F\u67E5\u770B`);
            }
          } catch (e) {
          }
        }, settings.autoSyncDelaySec * 1e3);
      } catch {
      }
    };
    disposers.push(
      ctx.events.on("note.created", (payload) => {
        void scheduleAutoSync(extractNoteId(payload));
      })
    );
    disposers.push(
      ctx.events.on("note.updated", (payload) => {
        void scheduleAutoSync(extractNoteId(payload));
      })
    );
    disposers.push(
      ctx.events.on("note.deleted", (payload) => {
        const id = extractNoteId(payload);
        if (!id) return;
        void markDeleted(ctx, id, (/* @__PURE__ */ new Date()).toISOString()).catch(() => void 0);
      })
    );
    disposers.push(
      ctx.events.on("settings.changed", (payload) => {
        const key = payload?.key;
        if (key === "auto-sync" || key === "auto-sync-delay-sec") void scheduleAutoSync();
      })
    );
    disposers.push(
      ctx.events.on("workspace.synced", () => {
        void scheduleAutoSync();
      })
    );
    return () => {
      disposed = true;
      if (autoTimer) clearTimeout(autoTimer);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (e) {
          void errMsg(e);
        }
      }
    };
  }
};
export {
  main_default as default
};
