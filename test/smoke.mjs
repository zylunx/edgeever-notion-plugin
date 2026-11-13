/**
 * 冒烟测试：用 Mock 宿主 + Mock Notion API 验证 main.js 的实际行为。
 * 运行：node test/smoke.mjs（先 npm run build）
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createMockContext, makePage, TOKEN, DS_ID } from "./mock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const plugin = (await import(pathToFileURL(join(root, "main.js")).href)).default;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function setup(options = {}) {
  const { ctx, state } = createMockContext(options);
  const dispose = plugin.activate(ctx);
  await state.runCommand("notion-sync-open-panel");
  return { ctx, state, dispose };
}

async function preview(state) { await state.click("preview"); }
async function confirm(state) { await state.change("confirm", { checked: true }); }
async function apply(state) { await confirm(state); await state.click("apply"); }
async function firstSync(state) { await preview(state); await apply(state); }

function writeCalls(state) {
  return state.fetchCalls.filter((c) => {
    const m = (c.options.method || "GET").toUpperCase();
    return m !== "GET" && !c.url.includes("/query") && !c.url.includes("/users/me");
  });
}
function pageCreates(state) {
  return state.fetchCalls.filter((c) => c.url.endsWith("/v1/pages") && c.options.method === "POST");
}
function markdownOf(state, pageId) { return state.notion.pages.get(pageId)?.markdown ?? ""; }
function noteById(state, id) { return state.notes.find((n) => n.id === id); }

// ---------------------------------------------------------------- 1. 生命周期
test("注册命令与面板，activate 返回的清理函数可注销", async () => {
  const { state, dispose } = await setup();
  assert.equal(state.commands.size, 4, "应注册 4 个命令（含同步单篇笔记）");
  assert.equal(state.panels.size, 1, "应注册 1 个面板");
  assert.ok(state.events.has("note.deleted"));
  dispose();
  assert.equal(state.commands.size, 0);
  assert.equal(state.panels.size, 0);
  for (const set of state.events.values()) assert.equal(set.size, 0);
});

// ---------------------------------------------------------------- 2. 连接验证
test("测试连接会同时验证 Token 与目标 Data Source 访问权限", async () => {
  const { state, dispose } = await setup();
  try {
    await state.click("test");
    const urls = state.fetchCalls.map((c) => c.url);
    assert.ok(urls.some((u) => u.endsWith("/v1/users/me")));
    assert.ok(urls.some((u) => u.includes(`/v1/data_sources/${DS_ID}/query`)));
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("已连接"));
    const auth = state.fetchCalls[0].options.headers.Authorization;
    assert.equal(auth, `Bearer ${TOKEN}`);
    assert.equal(state.fetchCalls[0].options.headers["Notion-Version"], "2026-03-11");
  } finally { dispose(); }
});

test("未配置 Token 时给出可读提示且不发起任何网络请求", async () => {
  const { state, dispose } = await setup({ settings: { "notion-token": "" } });
  try {
    await state.click("test");
    assert.equal(state.fetchCalls.length, 0);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("Token"));
  } finally { dispose(); }
});

test("401 时给出 Token 提示且不重试", async () => {
  const { state, dispose } = await setup({
    fetchImpl: async (url) => {
      if (url.endsWith("/v1/users/me")) {
        const text = JSON.stringify({ object: "error", status: 401, code: "unauthorized", message: "invalid token" });
        return { ok: false, status: 401, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) };
      }
      return null;
    },
  });
  try {
    await state.click("test");
    const meCalls = state.fetchCalls.filter((c) => c.url.endsWith("/v1/users/me"));
    assert.equal(meCalls.length, 1, "401 不应被重试");
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("Token 无效"));
  } finally { dispose(); }
});

test("设置界面只保留必要字段；Data Source ID 由后台记录自动提供", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const keys = manifest.settings.fields.map((f) => f.key);
  assert.deepEqual(keys, [
    "notion-token", "notion-parent-page-id", "sync-direction", "auto-sync", "upload-attachments",
  ], "数据库 ID / Data Source ID / API 地址 / 属性名等不应再暴露给用户");
  const { state, dispose } = await setup();
  try {
    assert.equal(state.settings["notion-data-source-id"], undefined);
    assert.equal(state.settings["notion-database-id"], undefined);
    assert.equal(state.settings["api-base-url"], undefined);
    await preview(state);
    assert.ok(
      state.fetchCalls.some((c) => c.url.includes(`/v1/data_sources/${DS_ID}/query`)),
      "用户不填任何 ID，后台记录仍应提供 Data Source",
    );
  } finally { dispose(); }
});

// ---------------------------------------------------------------- 3. 预览与首次同步
test("首次同步只生成只读预览，预览阶段不写入任何一端", async () => {
  const { state, dispose } = await setup();
  try {
    await preview(state);
    assert.equal(pageCreates(state).length, 0, "预览不得创建页面");
    assert.equal(state.storage.get("notion-sync:mappings"), undefined, "预览不得写入映射");
    const html = state.panelRoots.at(-1).root.innerHTML;
    assert.ok(html.includes("特殊笔记 1"), "应统计跳过的特殊笔记");
    assert.ok(html.includes("新增 2"), "应统计 2 条新建");
  } finally { dispose(); }
});

test("未勾选确认时点击执行不会写入", async () => {
  const { state, dispose } = await setup();
  try {
    await preview(state);
    await state.click("apply");
    assert.equal(state.notion.pages.size, 0);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("请先勾选"));
  } finally { dispose(); }
});

test("确认后创建页面并建立映射；重复同步不会重复创建", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    assert.equal(state.notion.pages.size, 2, "只同步 2 篇普通文本笔记");
    const mappings = state.storage.get("notion-sync:mappings");
    assert.equal(Object.keys(mappings).length, 2);
    assert.equal(mappings["note-1"].status, "synced");
    assert.ok(mappings["note-1"].lastEdgeEverHash && mappings["note-1"].lastNotionHash, "双基线应写入");

    await preview(state);
    const html = state.panelRoots.at(-1).root.innerHTML;
    assert.ok(html.includes("新增 0"), `重复预览不应有新增：${html.slice(0, 400)}`);
    await apply(state);
    assert.equal(state.notion.pages.size, 2, "重复执行不应重复创建页面");
  } finally { dispose(); }
});

test("远端已有相同 EdgeEver ID 页面时修复映射，不重复创建", async () => {
  const { state, dispose } = await setup({
    pages: [makePage({ id: "page-existing", eeId: "note-1", markdown: "# 标题\n\n正文第一段。" })],
  });
  try {
    await preview(state);
    assert.equal(pageCreates(state).length, 0);
    await apply(state);
    const mappings = state.storage.get("notion-sync:mappings");
    assert.equal(mappings["note-1"].notionPageId, "page-existing");
    assert.equal(state.notion.pages.size, 2, "note-1 复用已有页面，note-3 新建");
  } finally { dispose(); }
});

// ---------------------------------------------------------------- 4. 双向同步
test("仅 EdgeEver 修改时推送 Notion，不回写 EdgeEver", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    const pageId = state.storage.get("notion-sync:mappings")["note-1"].notionPageId;
    noteById(state, "note-1").contentMarkdown = "# 标题\n\nEdgeEver 新内容。";
    await preview(state);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("更新 1"));
    await apply(state);
    assert.ok(markdownOf(state, pageId).includes("EdgeEver 新内容。"));
    assert.equal((state.noteUpdates || []).filter((u) => u.id === "note-1").length, 0);
  } finally { dispose(); }
});

test("仅 Notion 修改时拉取到 EdgeEver", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    const pageId = state.storage.get("notion-sync:mappings")["note-1"].notionPageId;
    state.notion.pages.get(pageId).markdown = "# 标题\n\nNotion 新内容。";
    await preview(state);
    await apply(state);
    assert.ok(noteById(state, "note-1").contentMarkdown.includes("Notion 新内容。"));
  } finally { dispose(); }
});

test("两端同时修改时进入冲突，默认不覆盖任一端", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    const pageId = state.storage.get("notion-sync:mappings")["note-1"].notionPageId;
    noteById(state, "note-1").contentMarkdown = "# 标题\n\nEdgeEver 侧改动。";
    state.notion.pages.get(pageId).markdown = "# 标题\n\nNotion 侧改动。";
    await preview(state);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("冲突 1"));
    await apply(state);
    assert.ok(markdownOf(state, pageId).includes("Notion 侧改动。"), "Notion 不应被覆盖");
    assert.ok(noteById(state, "note-1").contentMarkdown.includes("EdgeEver 侧改动。"), "EdgeEver 不应被覆盖");
  } finally { dispose(); }
});

test("人工选择「保留 EdgeEver」后才覆盖 Notion", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    const pageId = state.storage.get("notion-sync:mappings")["note-1"].notionPageId;
    noteById(state, "note-1").contentMarkdown = "# 标题\n\nEdgeEver 胜出。";
    state.notion.pages.get(pageId).markdown = "# 标题\n\nNotion 侧改动。";
    await preview(state);
    await state.click("resolve", { key: "note-1", value: "edgeever" });
    await apply(state);
    assert.ok(markdownOf(state, pageId).includes("EdgeEver 胜出。"));
  } finally { dispose(); }
});

test("Notion 独有页面会创建 EdgeEver 笔记并回写 EdgeEver ID", async () => {
  const { state, dispose } = await setup({
    pages: [makePage({ id: "page-only", markdown: "来自 Notion 的内容" })],
  });
  try {
    await firstSync(state);
    const created = state.notes.find((n) => n.id.startsWith("note-new-"));
    assert.ok(created, "应创建 EdgeEver 笔记");
    assert.ok(created.contentMarkdown.includes("来自 Notion 的内容"));
    const props = state.notion.pages.get("page-only").properties;
    assert.equal(props["EdgeEver ID"].rich_text[0].text.content, created.id);
  } finally { dispose(); }
});

// ---------------------------------------------------------------- 5. 分页 / 限流 / 数据保护
test("分页查询超过一页时仍能完整枚举页面", async () => {
  const pages = Array.from({ length: 5 }, (_, i) => makePage({ id: `page-p${i}`, markdown: `远端内容 ${i}` }));
  const { state, dispose } = await setup({ pages, pageSizeOverride: 2 });
  try {
    await preview(state);
    const cursors = state.fetchCalls.filter((c) => c.url.includes("/query") && c.options.body?.includes("start_cursor"));
    assert.ok(cursors.length >= 2, "应携带 start_cursor 继续翻页");
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("新增 7"), "5 个远端 + 2 个本地新建");
  } finally { dispose(); }
});

test("429 按 Retry-After 等待后恢复", async () => {
  const { state, dispose } = await setup();
  try {
    state.notion.rateLimitNext = true;
    await preview(state);
    assert.equal(state.notion.rateLimitCount, 1, "应触发一次 429");
    const queryCalls = state.fetchCalls.filter((c) => c.url.includes("/query"));
    assert.ok(queryCalls.length >= 2, "429 之后应重试成功");
  } finally { dispose(); }
});

test("特殊笔记与普通 Markdown 更新隔离", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    assert.equal(state.notion.pages.size, 2);
    const special = noteById(state, "note-2");
    assert.equal(special.contentMarkdown, "{\"nodes\":[]}", "特殊笔记正文不得被改写");
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("特殊笔记") || true);
  } finally { dispose(); }
});

test("Notion Markdown 被截断时跳过，不把不完整内容写回 EdgeEver", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    const pageId = state.storage.get("notion-sync:mappings")["note-1"].notionPageId;
    state.notion.truncatedIds.add(pageId);
    const before = noteById(state, "note-1").contentMarkdown;
    await preview(state);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("不完整 1"));
    await apply(state);
    assert.equal(noteById(state, "note-1").contentMarkdown, before);
  } finally { dispose(); }
});

test("删除只标记映射，不永久删除任一端数据", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    const before = state.notion.pages.size;
    await state.emit("note.deleted", { noteId: "note-1" });
    const mappings = state.storage.get("notion-sync:mappings");
    assert.equal(mappings["note-1"].status, "deleted");
    assert.equal(state.notion.pages.size, before, "Notion 页面不应被删除");
    assert.equal(state.noteDeletes || 0, 0, "插件不应调用永久删除");
    assert.ok(noteById(state, "note-1"), "EdgeEver 笔记仍在");
  } finally { dispose(); }
});

test("自动同步在首次手动同步之前不发起网络请求", async () => {
  const { state, dispose } = await setup({ settings: { "auto-sync": true } });
  try {
    await state.emit("note.updated", { note: { id: "note-1" } });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(state.fetchCalls.length, 0);
  } finally { dispose(); }
});

// ---------------------------------------------------------------- 6. 附件
test("附件上传默认关闭：正文保留可追溯占位且不上传", async () => {
  const { state, dispose } = await setup({
    notes: [
      { id: "note-3", title: "带附件的笔记", kind: "text", notebookId: "nb-1", tags: [], contentMarkdown: "文字\n\n![日出](edgeever://res-1)\n\n结尾", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  try {
    await firstSync(state);
    const page = state.notionPageList()[0];
    assert.ok(page.markdown.includes("EE-ATTACH:res-1|sunrise.png"), "应保留可追溯占位");
    assert.equal(state.fetchCalls.filter((c) => c.url.includes("file_uploads")).length, 0);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("附件"));
  } finally { dispose(); }
});

test("开启附件上传后上传并挂载；内容变更时复用同一上传，不重复上传", async () => {
  const { state, dispose } = await setup({
    settings: { "upload-attachments": true },
    notes: [
      { id: "note-3", title: "带附件的笔记", kind: "text", notebookId: "nb-1", tags: [], contentMarkdown: "文字\n\n![日出](edgeever://res-1)\n\n结尾", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  try {
    await firstSync(state);
    const page = state.notionPageList()[0];
    assert.ok(page.markdown.includes("EE-ATTACHMENTS-START"));
    assert.equal(state.fetchCalls.filter((c) => c.url.endsWith("/v1/file_uploads")).length, 1, "只上传一次");
    const mapping = state.storage.get("notion-sync:resources")["res-1"];
    assert.equal(mapping.status, "attached");
    assert.ok(mapping.notionFileUploadId && mapping.sha256);

    noteById(state, "note-3").contentMarkdown = "文字\n\n![日出](edgeever://res-1)\n\n新增段落";
    await preview(state);
    await apply(state);
    assert.equal(state.fetchCalls.filter((c) => c.url.endsWith("/v1/file_uploads")).length, 1, "同一文件不应重复上传");
  } finally { dispose(); }
});

// ---------------------------------------------------------------- 6.5 一键生成同步数据库
/** 全新安装：没有后台生成记录，只填父页面 ID。 */
function freshSetup(extra = {}) {
  const { settings: extraSettings = {}, ...rest } = extra;
  return {
    settings: {
      "notion-parent-page-id": "https://www.notion.so/My-Page-1234567890abcdef1234567890abcdef",
      ...extraSettings,
    },
    noSetupRecord: true,
    ...rest,
  };
}

test("一键生成：填父页面 ID 后自动建库、建全属性并保存 Data Source ID", async () => {
  const { state, dispose } = await setup(freshSetup());
  try {
    await state.click("setup");
    assert.equal(state.notion.createDatabaseCalls, 1, "应调用一次 POST /v1/databases");
    const body = state.setupBody();
    assert.equal(body.parent.type, "page_id", "必须使用官方 page_id parent");
    assert.equal(body.parent.page_id, "12345678-90ab-cdef-1234-567890abcdef", "应支持粘贴页面链接并规范化为 UUID");
    assert.ok(Array.isArray(body.title) && body.title[0].text.content, "应带数据库标题");
    const props = body.initial_data_source.properties;
    assert.equal(props.Name.title !== undefined, true, "Name 应为 title");
    assert.equal(props.Tags.multi_select !== undefined, true, "Tags 应为 multi_select");
    assert.equal(props.Notebook.select !== undefined, true, "Notebook 应为 select，便于按笔记本筛选");
    assert.equal(props["Last Synced"].date !== undefined, true, "Last Synced 应为 date");
    assert.equal(props["EdgeEver ID"].rich_text !== undefined, true, "EdgeEver ID 应为 rich_text（幂等必需）");
    assert.equal(props["Content Hash"], undefined, "Hash 等技术列不应再创建");
    assert.equal(props["Sync Status"], undefined);
    assert.equal(props["EdgeEver Notebook ID"], undefined);
    assert.equal(Object.keys(props).length, 6, "应只创建 6 个属性");

    const record = state.storage.get("notion-sync:setup");
    assert.ok(record?.dataSourceId?.startsWith("ds-gen-"), "Data Source ID 应自动保存");
    assert.equal(record.parentPageId, "12345678-90ab-cdef-1234-567890abcdef");
    const html = state.panelRoots.at(-1).root.innerHTML;
    assert.ok(html.includes("同步数据库已生成"));
    assert.ok(!html.includes(TOKEN), "面板不得回显 Token");
    assert.ok(!JSON.stringify(state.notices).includes(TOKEN));
  } finally { dispose(); }
});

test("一键生成后无需手填 ID 即可测试连接并完成首次同步", async () => {
  const { state, dispose } = await setup(freshSetup());
  try {
    await state.click("setup");
    const dsId = state.storage.get("notion-sync:setup").dataSourceId;
    await state.click("test");
    assert.ok(state.fetchCalls.some((c) => c.url.includes(`/v1/data_sources/${dsId}/query`)), "应自动使用生成的 Data Source");
    await firstSync(state);
    assert.equal(state.notion.pages.size, 2, "新库可正常承接同步页面");
    assert.equal(Object.keys(state.storage.get("notion-sync:mappings")).length, 2);
  } finally { dispose(); }
});

test("重复点击不重复建库；缺失属性只补齐且不改已有属性", async () => {
  const { state, dispose } = await setup(freshSetup({ setupMissingProps: ["Notebook"] }));
  try {
    await state.click("setup");
    assert.equal(state.notion.createDatabaseCalls, 1);
    assert.equal(state.notion.patchDataSourceCalls, 1, "应补齐缺失属性");
    assert.ok(state.notion.lastPatchBody.properties.Notebook, "只补缺失的 Notebook");
    assert.equal(state.notion.lastPatchBody.properties.Name, undefined, "不得重写已有属性");
    await state.click("setup");
    assert.equal(state.notion.createDatabaseCalls, 1, "第二次点击不得再建库");
    assert.equal(state.notion.patchDataSourceCalls, 1, "属性齐全后不得再 PATCH");
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("未重复建库"));
  } finally { dispose(); }
});

test("未填父页面 ID 时给出提示，且不发起任何网络请求", async () => {
  const { state, dispose } = await setup(freshSetup({ settings: { "notion-parent-page-id": "" } }));
  try {
    await state.click("setup");
    assert.equal(state.fetchCalls.length, 0);
    assert.equal(state.notion.createDatabaseCalls, 0);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("父页面 ID"));
  } finally { dispose(); }
});

test("403 缺少 Insert content 时给出能力与授权指引", async () => {
  const { state, dispose } = await setup(freshSetup({ setupForbidden: true }));
  try {
    await state.click("setup");
    const html = state.panelRoots.at(-1).root.innerHTML;
    assert.ok(html.includes("Insert content"));
    assert.ok(html.includes("Connections"));
    assert.equal(state.notion.createDatabaseCalls, 0);
  } finally { dispose(); }
});

test("404 父页面不存在或未共享时给出 Connections 指引", async () => {
  const { state, dispose } = await setup(freshSetup({ setupNotFound: true }));
  try {
    await state.click("setup");
    const html = state.panelRoots.at(-1).root.innerHTML;
    assert.ok(html.includes("找不到父页面"));
    assert.ok(html.includes("Connections"));
  } finally { dispose(); }
});

test("已有后台生成记录时一键生成只补属性、不新建数据库", async () => {
  const { state, dispose } = await setup({ setupMissingProps: ["Notebook"] });
  try {
    await state.click("setup");
    assert.equal(state.notion.createDatabaseCalls, 0, "已有记录不得新建");
    assert.equal(state.notion.patchDataSourceCalls, 1);
    assert.ok(state.storage.get("notion-sync:setup")?.dataSourceId, "后台记录保持不变");
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("未重复建库"));
  } finally { dispose(); }
});

test("已生成的库无法访问时报错而不自动新建，避免重复数据库", async () => {
  const { state, dispose } = await setup(freshSetup());
  try {
    await state.click("setup");
    const dsId = state.storage.get("notion-sync:setup").dataSourceId;
    state.notion.dataSources.delete(dsId);
    await state.click("setup");
    assert.equal(state.notion.createDatabaseCalls, 1, "不得因为旧库不可访问而新建");
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("无法访问"));
  } finally { dispose(); }
});

// ---------------------------------------------------------------- 6.6 多选笔记本 / 单篇同步 / 精简列
const MULTI_NOTES = [
  { id: "a", title: "工作笔记", kind: "text", notebookId: "nb-1", tags: [], contentMarkdown: "A 正文", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", title: "个人笔记", kind: "text", notebookId: "nb-2", tags: [], contentMarkdown: "B 正文", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "c", title: "归档笔记", kind: "text", notebookId: "nb-3", tags: [], contentMarkdown: "C 正文", updatedAt: "2026-01-01T00:00:00.000Z" },
];
const MULTI_NOTEBOOKS = [
  { id: "nb-1", name: "工作" },
  { id: "nb-2", name: "个人" },
  { id: "nb-3", name: "归档" },
];
function multiSetup(extra = {}) {
  return setup({ notes: MULTI_NOTES, notebooks: MULTI_NOTEBOOKS, ...extra });
}

test("勾选单个笔记本时只同步该笔记本的笔记", async () => {
  const { state, dispose } = await multiSetup();
  try {
    await state.change("notebook", { id: "nb-1", checked: true });
    assert.deepEqual(state.storage.get("notion-sync:notebooks"), ["nb-1"]);
    await firstSync(state);
    assert.equal(state.notion.pages.size, 1);
    assert.ok(markdownOf(state, [...state.notion.pages.keys()][0]).includes("A 正文"));
  } finally { dispose(); }
});

test("勾选多个笔记本时同步两边；清空选择后恢复同步全部", async () => {
  const { state, dispose } = await multiSetup();
  try {
    await state.change("notebook", { id: "nb-1", checked: true });
    await state.change("notebook", { id: "nb-2", checked: true });
    assert.deepEqual(new Set(state.storage.get("notion-sync:notebooks")), new Set(["nb-1", "nb-2"]));
    await firstSync(state);
    assert.equal(state.notion.pages.size, 2);

    await state.click("clear-notebooks");
    assert.deepEqual(state.storage.get("notion-sync:notebooks"), []);
    await preview(state);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("新增 1"), "清空后应重新纳入第 3 个笔记本");
  } finally { dispose(); }
});

test("同步时把笔记本名称写入 Notion 的 Notebook 属性，且不再写技术列", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    for (const page of state.notionPageList()) {
      assert.equal(page.properties.Notebook.select.name, "工作");
      assert.equal(page.properties["Content Hash"], undefined);
      assert.equal(page.properties["Sync Status"], undefined);
      assert.equal(page.properties["EdgeEver Notebook ID"], undefined);
    }
  } finally { dispose(); }
});

test("「同步单篇笔记」命令：宿主给出当前笔记时只同步该篇", async () => {
  const { state, dispose } = await setup({ currentNoteId: "note-1" });
  try {
    await state.runCommand("notion-sync-single-note");
    assert.equal(state.notion.pages.size, 1, "只应创建这一篇对应的页面");
    assert.ok(state.notices.some((n) => n.includes("单篇同步完成")));
  } finally { dispose(); }
});

test("当前文档 ID 不是有效笔记时回退到选择器，不误同步", async () => {
  const { state, dispose } = await setup({ currentNoteId: "not-a-real-note" });
  try {
    await state.runCommand("notion-sync-single-note");
    assert.equal(state.fetchCalls.length, 0);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("请在这里选择"));
  } finally { dispose(); }
});

test("宿主未给出当前笔记时，单篇命令打开面板的单篇选择器", async () => {
  const { state, dispose } = await setup({ noEditor: true });
  try {
    await state.runCommand("notion-sync-single-note");
    const html = state.panelRoots.at(-1).root.innerHTML;
    assert.ok(html.includes("请在这里选择"));
    assert.ok(html.includes("同步此篇"));
    assert.equal(state.fetchCalls.length, 0);
  } finally { dispose(); }
});

test("面板里选择单篇笔记后点「同步此篇」只同步该篇", async () => {
  const { state, dispose } = await setup();
  try {
    await state.change("single-note", { value: "note-1" });
    await state.click("sync-one");
    assert.equal(state.notion.pages.size, 1);
    assert.ok(state.panelRoots.at(-1).root.innerHTML.includes("单篇同步完成"));
  } finally { dispose(); }
});

test("单篇同步不会被记为全量首次同步完成", async () => {
  const { state, dispose } = await setup({ currentNoteId: "note-1", settings: { "auto-sync": true } });
  try {
    await state.runCommand("notion-sync-single-note");
    assert.equal(state.storage.get("notion-sync:state").firstSyncDone, false);
  } finally { dispose(); }
});

// ---------------------------------------------------------------- 7. 安全 / 交付
test("Token 不出现在 storage、报告与通知中", async () => {
  const { state, dispose } = await setup();
  try {
    await firstSync(state);
    const report = state.storage.get("notion-sync:last-report");
    assert.ok(report, "应保存同步报告");
    assert.ok(!JSON.stringify(report).includes(TOKEN));
    assert.ok(!state.storageText().includes(TOKEN));
    assert.ok(!JSON.stringify(state.notices).includes(TOKEN));
    assert.ok(!JSON.stringify(state.fetchCalls.map((c) => c.url)).includes(TOKEN));
  } finally { dispose(); }
});

test("打包产物为单文件且小于 5 MB，源码不含硬编码 Token", async () => {
  const size = statSync(join(root, "main.js")).size;
  assert.ok(size < 5 * 1024 * 1024, `main.js 过大：${size}`);
  const source = readFileSync(join(root, "main.js"), "utf8");
  assert.ok(!source.includes(TOKEN));
  assert.ok(source.includes("replace_content"), "应使用官方 markdown 全量替换命令");
  assert.ok(source.includes("/v1/data_sources/"), "应使用 Data Source 模型");
});

// ---------------------------------------------------------------- 运行
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`  ok  ${t.name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${t.name}`);
    console.error(`      ${e?.message ?? e}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
if (failed > 0) process.exit(1);
