import type {
  ConflictResolution,
  PluginContext,
  SyncAction,
  SyncPlanItem,
  SyncReport,
} from "../types";
import { loadSettings, isCustomApiBase } from "../config/settings";
import {
  loadMappings,
  loadReport,
  loadState,
  restoreMapping,
} from "../sync/mapping";
import { loadSetupRecord } from "../sync/setup-store";
import type { SyncEngine, PreviewResult } from "../sync/engine";
import { errMsg, escapeHtml, redact, truncate } from "../util";

const PANEL_ID = "notion-sync-panel";

const ACTION_LABEL: Record<SyncAction, string> = {
  "create-notion": "新建到 Notion",
  "update-notion": "推送更新",
  "create-edgeever": "新建到 EdgeEver",
  "update-edgeever": "拉取更新",
  skip: "跳过",
  conflict: "冲突",
  unsupported: "特殊笔记",
  incomplete: "内容不完整",
  deleted: "删除/归档提示",
  error: "失败",
};

type Tab = "overview" | "plan" | "report";

export function openSyncPanel(ctx: PluginContext): Promise<unknown> {
  return ctx.ui.panels.open(PANEL_ID);
}

export function registerPanel(ctx: PluginContext, engine: SyncEngine): () => void {
  return ctx.ui.panels.register({
    id: PANEL_ID,
    title: "Notion 同步",
    purpose: "workflow",
    presentation: "dialog",
    mount(container, { shell, state }) {
      const root = document.createElement("div");
      root.className = "ens-panel";
      container.append(root);

      let disposed = false;
      let busy = false;
      let tab: Tab = "overview";
      let query = "";
      let preview: PreviewResult | null = null;
      let report: SyncReport | null = null;
      let resolutions: Record<string, ConflictResolution> = {};
      let connectionText = "尚未测试";
      let notice = "";
      let progress = { done: 0, total: 0 };
      let settings = loadSettings(ctx); // Promise，init 中 await
      let settingsSnapshot = {
        notebookId: "",
        direction: "bidirectional",
        tokenConfigured: false,
        customApiBase: false,
      };
      let notebooks: Array<{ id: string; name: string }> = [];
      let mappingCount = 0;
      let deletedCount = 0;
      let firstSyncDone = false;
      let lastSyncAt = "";
      let confirmChecked = false;
      let setupText = "";
      let setupDataSourceId = "";

      shell.set({
        header: {
          title: "Notion 双向同步",
          description: "先预览、后执行；冲突默认不覆盖任一端。",
          actions: [
            { id: "test", label: "测试连接" },
            { id: "preview", label: "生成预览" },
            { id: "apply", label: "执行同步" },
            { id: "setup", label: "一键生成同步数据库" },
          ],
        },
        toolbar: [
          {
            type: "tabs",
            key: "tab",
            value: "overview",
            options: [
              { value: "overview", label: "概览" },
              { value: "plan", label: "同步计划" },
              { value: "report", label: "上次结果" },
            ],
          },
          { type: "search", key: "q", placeholder: "筛选笔记标题" },
        ],
        onAction(actionId: string) {
          if (actionId === "test") void runTest();
          if (actionId === "preview") void runPreview();
          if (actionId === "apply") void runApply();
          if (actionId === "setup") void runSetup();
        },
        onChange(key: string, value: unknown) {
          if (key === "tab") {
            tab = (value === "plan" || value === "report" ? value : "overview") as Tab;
            render();
          }
          if (key === "q") {
            query = String(value ?? "").toLowerCase();
            render();
          }
        },
      });

      async function refreshMeta(): Promise<void> {
        const s = await loadSettings(ctx);
        settings = Promise.resolve(s);
        settingsSnapshot = {
          notebookId: s.notebookId,
          direction: s.direction,
          tokenConfigured: Boolean(s.token),
          customApiBase: isCustomApiBase(s),
        };
        const st = await loadState(ctx);
        firstSyncDone = st.firstSyncDone;
        lastSyncAt = st.lastSyncAt ?? "";
        const mappings = await loadMappings(ctx);
        mappingCount = Object.keys(mappings).length;
        deletedCount = Object.values(mappings).filter((m) => m?.status === "deleted").length;
        report = (await loadReport(ctx)) ?? null;
        const setupRecord = await loadSetupRecord(ctx);
        setupDataSourceId = setupRecord?.dataSourceId ?? "";
        notebooks = (await ctx.notebooks.list())
          .filter((n) => n && typeof n.id === "string")
          .map((n) => ({ id: n.id, name: String(n.name ?? n.title ?? n.id) }));
        render();
      }

      function render(): void {
        if (disposed) return;
        const s = settingsSnapshot;
        const counts = preview?.counts;
        // 预览警告 + 上次同步报告警告统一展示，避免附件/属性错误被藏在别的 Tab 里
        const warningList = [...new Set([...(preview?.warnings ?? []), ...(report?.warnings ?? [])])];
        root.innerHTML = `
          <div class="ens-status ${busy ? "ens-busy" : ""}">
            <div class="ens-row"><strong>连接状态</strong><span>${escapeHtml(connectionText)}</span></div>
            <div class="ens-row"><strong>Token</strong><span>${s.tokenConfigured ? "已配置（加密存储，不回显）" : "未配置"}</span></div>
            <div class="ens-row"><strong>同步数据库</strong><span>${setupDataSourceId ? `已生成 · Data Source ${escapeHtml(setupDataSourceId.slice(0, 8))}…` : "尚未生成（点击「一键生成同步数据库」）"}</span></div>
            <div class="ens-row"><strong>API 地址</strong><span>${s.customApiBase ? "自建代理（Token 将发往该地址）" : "官方 api.notion.com"}</span></div>
            <div class="ens-row"><strong>已建立映射</strong><span>${mappingCount} 条${deletedCount ? `，其中 ${deletedCount} 条标记为删除` : ""}</span></div>
            <div class="ens-row"><strong>上次同步</strong><span>${escapeHtml(lastSyncAt || "尚未同步")}</span></div>
          </div>

          <div class="ens-controls">
            <label>同步笔记本
              <select data-control="notebook">
                <option value="">（未选择）</option>
                ${notebooks.map((n) => `<option value="${escapeHtml(n.id)}" ${n.id === s.notebookId ? "selected" : ""}>${escapeHtml(n.name)}</option>`).join("")}
              </select>
            </label>
            <label>同步方向
              <select data-control="direction">
                <option value="bidirectional" ${s.direction === "bidirectional" ? "selected" : ""}>双向（冲突需人工处理）</option>
                <option value="push" ${s.direction === "push" ? "selected" : ""}>仅推送到 Notion</option>
                <option value="pull" ${s.direction === "pull" ? "selected" : ""}>仅拉取到 EdgeEver</option>
              </select>
            </label>
          </div>

          <div class="ens-actions">
            <button data-action="setup">一键生成同步数据库</button>
            <button data-action="test">测试连接</button>
            <button data-action="preview">生成预览</button>
            <button data-action="apply" ${!preview || busy ? "disabled" : ""}>执行同步（${preview?.plan.length ?? 0} 项）</button>
            <button data-action="restore">恢复删除映射（${deletedCount}）</button>
            <button data-action="retry" ${!report || busy ? "disabled" : ""}>重试失败项</button>
          </div>

          <label class="ens-confirm">
            <input type="checkbox" data-control="confirm" ${confirmChecked ? "checked" : ""}/>
            我已阅读下方同步计划，确认执行上述写入（首次全量同步不会自动开始）
          </label>

          ${notice ? `<div class="ens-notice">${escapeHtml(notice)}</div>` : ""}
          ${setupText ? `<div class="ens-notice">${escapeHtml(setupText)}</div>` : ""}
          ${progress.total ? `<div class="ens-progress">执行进度：${progress.done} / ${progress.total}</div>` : ""}

          ${counts ? `
            <div class="ens-summary">
              <span>新增 ${counts.created}</span><span>更新 ${counts.updated}</span>
              <span>跳过 ${counts.skipped}</span><span class="ens-warn">冲突 ${counts.conflicts}</span>
              <span class="ens-warn">特殊笔记 ${counts.unsupported}</span>
              <span class="ens-warn">不完整 ${counts.incomplete}</span>
              <span>删除提示 ${counts.deleted}</span><span>失败 ${counts.failed}</span>
            </div>` : ""}

          ${warningList.length ? `<div class="ens-warnings"><strong>提示与警告</strong><ul>${warningList.map((w) => `<li>${escapeHtml(truncate(w, 400))}</li>`).join("")}</ul></div>` : ""}

          <div class="ens-list">
            ${tab === "overview" ? overviewHtml() : tab === "plan" ? planHtml() : reportHtml()}
          </div>
        `;
      }

      function overviewHtml(): string {
        return `
          <h3>使用说明</h3>
          <ol>
            <li>在 Notion 新建一个空页面，在该页面「··· → Connections」中添加 Integration；Token 需具备 Read / Update / Insert content 能力。</li>
            <li>插件设置里填写 Token 与「Notion 父页面 ID」（可粘贴页面链接），点击本面板的「一键生成同步数据库」：插件自动建库、建好全部属性并保存 Data Source ID，无需手动复制任何 ID。</li>
            <li>已有数据库也可在设置里直接填 Data Source ID / 数据库 ID；此时一键生成只检查并补齐缺失属性，不会重复建库。</li>
            <li>选择笔记本 → 测试连接 → 生成预览 → 勾选确认 → 执行同步。</li>
          </ol>
          <p>一键生成不会删除或改类型任何已有属性；类型不匹配只会提示，需手动在 Notion 中调整。特殊笔记与不完整的 Notion Markdown 一律跳过，不会被普通 Markdown 覆盖。</p>
          <p>特殊笔记（思维导图、表格、海报、信息图等）与不完整的 Notion Markdown 一律跳过并提示，不会被普通 Markdown 覆盖。</p>
          <p>删除采用软删除策略：只标记映射并提示，不自动永久删除任一端数据。</p>
        `;
      }

      function planHtml(): string {
        if (!preview) return `<p class="ens-empty">尚未生成预览。点击「生成预览」查看将要发生的操作。</p>`;
        const items = filtered(preview.plan);
        if (!items.length) return `<p class="ens-empty">没有符合条件的计划项。</p>`;
        return items
          .map((item) => {
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
                    <span>冲突处理：</span>
                    <button data-action="resolve" data-key="${escapeHtml(item.key)}" data-value="edgeever" class="${chosen === "edgeever" ? "ens-active" : ""}">保留 EdgeEver</button>
                    <button data-action="resolve" data-key="${escapeHtml(item.key)}" data-value="notion" class="${chosen === "notion" ? "ens-active" : ""}">保留 Notion</button>
                    <button data-action="resolve" data-key="${escapeHtml(item.key)}" data-value="later" class="${chosen === "later" ? "ens-active" : ""}">稍后处理</button>
                  </div>` : ""}
              </div>`;
          })
          .join("");
      }

      function reportHtml(): string {
        if (!report) return `<p class="ens-empty">尚无同步报告。</p>`;
        const items = (report.items ?? []).filter((i) => !query || i.title.toLowerCase().includes(query));
        return `
          <div class="ens-report-meta">开始 ${escapeHtml(report.startedAt)} · 结束 ${escapeHtml(report.finishedAt)} · 方向 ${escapeHtml(report.direction)}</div>
          ${items.length ? items.map((i) => `
            <div class="ens-item ens-${escapeHtml(i.action)}">
              <div class="ens-item-head"><span class="ens-badge">${escapeHtml(ACTION_LABEL[i.action] ?? i.action)}</span><strong>${escapeHtml(i.title)}</strong></div>
              <div class="ens-reason">${escapeHtml(truncate(i.message, 600))}</div>
            </div>`).join("") : `<p class="ens-empty">没有匹配的记录。</p>`}
        `;
      }

      function filtered(items: SyncPlanItem[]): SyncPlanItem[] {
        return items.filter((i) => !query || i.title.toLowerCase().includes(query));
      }

      function setBusy(value: boolean, message = ""): void {
        busy = value;
        notice = message;
        render();
      }

      async function currentSettings() {
        return settings;
      }

      async function runSetup(): Promise<void> {
        if (busy) return;
        setBusy(true, "正在生成/检查同步数据库…");
        try {
          const result = await engine.setupDatabase();
          setupText = result.message;
          await refreshMeta();
          setBusy(
            false,
            result.created
              ? `同步数据库已生成，Data Source ID 已自动保存（${result.record.dataSourceId.slice(0, 8)}…），现在可以测试连接。`
              : "同步数据库检查完成，未重复建库。",
          );
          ctx.ui.showNotice(result.created ? "Notion 同步数据库已生成" : "Notion 同步数据库检查完成");
        } catch (e) {
          const s = await currentSettings();
          setupText = "";
          setBusy(false, redact(errMsg(e), s.token));
        }
      }

      async function runTest(): Promise<void> {
        if (busy) return;
        setBusy(true, "正在验证 Token 与 Data Source 访问权限…");
        try {
          const info = await engine.testConnection();
          connectionText = `已连接：${info.workspaceName || info.botName || "Notion 工作区"} · Data Source ${info.dataSourceId.slice(0, 8)}…`;
          setBusy(false, "连接验证通过。Token 有效且 Integration 已获授权访问目标 Data Source。");
          ctx.ui.showNotice("Notion 连接验证通过");
        } catch (e) {
          connectionText = "连接失败";
          const s = await currentSettings();
          setBusy(false, redact(errMsg(e), s.token));
        }
      }

      async function runPreview(): Promise<void> {
        if (busy) return;
        setBusy(true, "正在生成只读预览（不写入任一端）…");
        try {
          preview = await engine.preview();
          resolutions = {};
          confirmChecked = false;
          await refreshMeta();
          setBusy(false, `预览完成：共 ${preview.plan.length} 项。请查看「同步计划」后再执行。`);
        } catch (e) {
          const s = await currentSettings();
          setBusy(false, redact(errMsg(e), s.token));
        }
      }

      async function runApply(): Promise<void> {
        if (busy || !preview) {
          notice = "请先生成预览，再执行同步。";
          render();
          return;
        }
        if (!confirmChecked) {
          notice = "请先勾选「我已阅读同步计划并确认执行」。";
          render();
          return;
        }
        setBusy(true, "正在执行同步…");
        progress = { done: 0, total: preview.plan.length };
        try {
          const plan = preview.plan;
          const res = { ...resolutions };
          report = await engine.apply(plan, res, (done, total) => {
            progress = { done, total };
            render();
          });
          const c = report.counts;
          setBusy(false, `同步完成：新增 ${c.created}、更新 ${c.updated}、跳过 ${c.skipped}、冲突 ${c.conflicts}、失败 ${c.failed}。`);
          ctx.ui.showNotice(`Notion 同步完成：新增 ${c.created}，更新 ${c.updated}`);
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

      async function runRestore(): Promise<void> {
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
          notice = `已恢复 ${n} 条映射，请重新生成预览。`;
          render();
        } catch (e) {
          const s = await currentSettings();
          notice = redact(errMsg(e), s.token);
          render();
        }
      }

      async function runRetry(): Promise<void> {
        if (!preview || !report) {
          notice = "请先生成预览，再重试失败项。";
          render();
          return;
        }
        const failed = new Set(report.items.filter((i) => i.action === "error").map((i) => i.key));
        if (!failed.size) {
          notice = "上次同步没有失败项。";
          render();
          return;
        }
        if (!confirmChecked) {
          notice = "请先勾选确认，再重试失败项。";
          render();
          return;
        }
        setBusy(true, `正在重试 ${failed.size} 个失败项…`);
        try {
          const subset = preview.plan.filter((i) => failed.has(i.key));
          report = await engine.apply(subset, resolutions);
          setBusy(false, `重试完成：失败 ${report.counts.failed} 项。`);
          await refreshMeta();
        } catch (e) {
          const s = await currentSettings();
          setBusy(false, redact(errMsg(e), s.token));
        }
      }

      function onClick(event: Event): void {
        const target = event.target as HTMLElement | null;
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
          const value = target.dataset.value as ConflictResolution | undefined;
          if (key && value) {
            resolutions[key] = value;
            render();
          }
        }
      }

      function onChange(event: Event): void {
        const target = event.target as HTMLSelectElement | HTMLInputElement | null;
        const control = target?.dataset?.control;
        if (!control) return;
        if (control === "confirm") {
          confirmChecked = (target as HTMLInputElement).checked;
          render();
          return;
        }
        const key = control === "notebook" ? "sync-notebook-id" : "sync-direction";
        const value = (target as HTMLSelectElement).value;
        void (async () => {
          try {
            await ctx.settings.set(key, value);
            settingsSnapshot =
              control === "notebook"
                ? { ...settingsSnapshot, notebookId: value }
                : { ...settingsSnapshot, direction: value };
            preview = null;
            notice = "配置已更新，请重新生成预览。";
            render();
          } catch (e) {
            const s = await currentSettings();
            notice = `保存配置失败，请在插件设置中手动修改：${redact(errMsg(e), s.token)}`;
            render();
          }
        })();
      }

      root.addEventListener("click", onClick);
      root.addEventListener("change", onChange);
      render();
      void refreshMeta();
      if ((state as Record<string, unknown> | undefined)?.autoPreview === true) void runPreview();

      return () => {
        disposed = true;
        root.removeEventListener("click", onClick);
        root.removeEventListener("change", onChange);
        root.remove();
      };
    },
    beforeClose() {
      return true;
    },
  });
}

export { PANEL_ID };
