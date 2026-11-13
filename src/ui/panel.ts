import type {
  ConflictResolution,
  PluginContext,
  SyncAction,
  SyncPlanItem,
  SyncReport,
} from "../types";
import { loadSettings } from "../config/settings";
import {
  loadMappings,
  loadReport,
  loadState,
  restoreMapping,
  saveNotebookSelection,
} from "../sync/mapping";
import { loadSetupRecord } from "../sync/setup-store";
import { listNoteOptions, notebookNameMap, type NoteOption } from "../edgeever/notes";
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
  deleted: "删除提示",
  error: "失败",
};

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
      let query = "";
      let preview: PreviewResult | null = null;
      let report: SyncReport | null = null;
      let resolutions: Record<string, ConflictResolution> = {};
      let connectionText = "尚未测试";
      let notice = "";
      let setupText = "";
      let progress = { done: 0, total: 0 };
      let settings = loadSettings(ctx);
      let settingsSnapshot = {
        notebookIds: [] as string[],
        direction: "bidirectional",
        tokenConfigured: false,
        setupReady: false,
      };
      let notebooks: Array<{ id: string; name: string }> = [];
      let noteOptions: NoteOption[] = [];
      let singleNoteId = "";
      let mappingCount = 0;
      let deletedCount = 0;
      let lastSyncAt = "";
      let confirmChecked = false;
      const pickNoteMode = (state as Record<string, unknown> | undefined)?.pickNote === true;

      shell.set({
        header: {
          title: "Notion 同步",
          description: "选好范围 → 生成预览 → 确认执行",
          actions: [
            { id: "preview", label: "生成预览" },
            { id: "apply", label: "执行同步" },
          ],
        },
        toolbar: [{ type: "search", key: "q", placeholder: "筛选同步计划" }],
        onAction(actionId: string) {
          if (actionId === "preview") void runPreview();
          if (actionId === "apply") void runApply();
        },
        onChange(key: string, value: unknown) {
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
          notebookIds: s.notebookIds,
          direction: s.direction,
          tokenConfigured: Boolean(s.token),
          setupReady: Boolean(s.dataSourceId),
        };
        const st = await loadState(ctx);
        lastSyncAt = st.lastSyncAt ?? "";
        const mappings = await loadMappings(ctx);
        mappingCount = Object.keys(mappings).length;
        deletedCount = Object.values(mappings).filter((m) => m?.status === "deleted").length;
        report = (await loadReport(ctx)) ?? null;
        const list = await ctx.notebooks.list();
        const names = notebookNameMap(list);
        notebooks = list
          .filter((n) => n && typeof n.id === "string")
          .map((n) => ({ id: n.id, name: names.get(n.id) ?? n.id }));
        noteOptions = await listNoteOptions(ctx, s.notebookIds);
        if (singleNoteId && !noteOptions.some((o) => o.id === singleNoteId)) singleNoteId = "";
        render();
      }

      function render(): void {
        if (disposed) return;
        const s = settingsSnapshot;
        const counts = preview?.counts;
        const warningList = [...new Set([...(preview?.warnings ?? []), ...(report?.warnings ?? [])])];
        const selected = new Set(s.notebookIds);
        const scopeLabel = selected.size ? `已选 ${selected.size} 个笔记本` : "全部笔记本";

        root.innerHTML = `
          <div class="ens-status ${busy ? "ens-busy" : ""}">
            <span>Token ${s.tokenConfigured ? "已配置" : "未配置"}</span>
            <span>同步数据库 ${s.setupReady ? "已生成" : "未生成"}</span>
            <span>范围 ${escapeHtml(scopeLabel)}</span>
            <span>上次同步 ${escapeHtml(lastSyncAt || "尚未同步")}</span>
            <span>映射 ${mappingCount} 条</span>
          </div>

          <div class="ens-section">
            <div class="ens-label">同步范围 <small>不勾选 = 全部笔记本；可勾选单个或多个</small></div>
            <div class="ens-checks">
              ${notebooks.length
                ? notebooks.map((n) => `<label><input type="checkbox" data-control="notebook" data-id="${escapeHtml(n.id)}" ${selected.has(n.id) ? "checked" : ""}/>${escapeHtml(n.name)}</label>`).join("")
                : `<span class="ens-empty">没有可用笔记本</span>`}
              ${selected.size ? `<button data-action="clear-notebooks">清空选择</button>` : ""}
            </div>
          </div>

          <div class="ens-inline">
            <label>方向
              <select data-control="direction">
                <option value="bidirectional" ${s.direction === "bidirectional" ? "selected" : ""}>双向</option>
                <option value="push" ${s.direction === "push" ? "selected" : ""}>仅推送到 Notion</option>
                <option value="pull" ${s.direction === "pull" ? "selected" : ""}>仅拉取到 EdgeEver</option>
              </select>
            </label>
            <label>单篇笔记
              <select data-control="single-note">
                <option value="">选择笔记…</option>
                ${noteOptions.map((o) => `<option value="${escapeHtml(o.id)}" ${o.id === singleNoteId ? "selected" : ""}>${escapeHtml(o.title)}${o.notebookName ? ` · ${escapeHtml(o.notebookName)}` : ""}</option>`).join("")}
              </select>
            </label>
            <button data-action="sync-one" ${!singleNoteId || busy ? "disabled" : ""}>同步此篇</button>
          </div>
          ${pickNoteMode ? `<div class="ens-hint">宿主未提供「当前笔记」上下文，请在这里选择要同步的那一篇笔记。</div>` : ""}

          <div class="ens-actions">
            <button data-action="preview">生成预览</button>
            <button data-action="apply" ${!preview || busy ? "disabled" : ""}>执行同步（${preview?.plan.length ?? 0} 项）</button>
          </div>
          <label class="ens-confirm">
            <input type="checkbox" data-control="confirm" ${confirmChecked ? "checked" : ""}/>
            我已阅读下方同步计划，确认执行写入
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

          ${warningList.length ? `<div class="ens-warnings"><strong>提示</strong><ul>${warningList.map((w) => `<li>${escapeHtml(truncate(w, 400))}</li>`).join("")}</ul></div>` : ""}

          <div class="ens-list">${planHtml()}</div>

          <details class="ens-advanced">
            <summary>高级选项与说明</summary>
            <div class="ens-actions">
              <button data-action="setup">一键生成同步数据库</button>
              <button data-action="test">测试连接</button>
              <button data-action="restore">恢复删除映射（${deletedCount}）</button>
              <button data-action="retry" ${!report || busy ? "disabled" : ""}>重试失败项</button>
            </div>
            <p class="ens-report-meta">连接：${escapeHtml(connectionText)}</p>
            ${reportHtml()}
            <ol class="ens-help">
              <li>Notion 里建一个空页面，在该页面「··· → Connections」中加入 Integration；插件设置只填 Token 与父页面 ID。</li>
              <li>点「一键生成同步数据库」自动建库并保存 Data Source ID，无需手写任何 ID。</li>
              <li>默认只展示标题、标签、笔记本、时间与同步时间；Hash 等技术值只保存在本地。</li>
              <li>冲突默认不覆盖任一端；删除只标记映射，不永久删除任一端数据。</li>
            </ol>
          </details>
        `;
      }

      function filtered(items: SyncPlanItem[]): SyncPlanItem[] {
        return items.filter((i) => !query || i.title.toLowerCase().includes(query));
      }

      function planHtml(): string {
        if (!preview) return `<p class="ens-empty">点击「生成预览」查看将要发生的操作（此阶段只读）。</p>`;
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
        const items = report.items ?? [];
        return `
          <div class="ens-report-meta">开始 ${escapeHtml(report.startedAt)} · 结束 ${escapeHtml(report.finishedAt)} · 方向 ${escapeHtml(report.direction)}</div>
          ${items.length ? items.map((i) => `
            <div class="ens-item ens-${escapeHtml(i.action)}">
              <div class="ens-item-head"><span class="ens-badge">${escapeHtml(ACTION_LABEL[i.action] ?? i.action)}</span><strong>${escapeHtml(i.title)}</strong></div>
              <div class="ens-reason">${escapeHtml(truncate(i.message, 600))}</div>
            </div>`).join("") : `<p class="ens-empty">没有记录。</p>`}
        `;
      }

      function setBusy(value: boolean, message = ""): void {
        busy = value;
        notice = message;
        render();
      }

      async function currentSettings() {
        return settings;
      }

      async function showError(e: unknown): Promise<void> {
        const s = await currentSettings();
        setBusy(false, redact(errMsg(e), s.token));
      }

      async function runSetup(): Promise<void> {
        if (busy) return;
        setBusy(true, "正在生成/检查同步数据库…");
        try {
          const result = await engine.setupDatabase();
          setupText = result.message;
          await refreshMeta();
          setBusy(false, result.created ? "同步数据库已生成，Data Source ID 已自动保存。" : "同步数据库检查完成，未重复建库。");
          ctx.ui.showNotice(result.created ? "Notion 同步数据库已生成" : "Notion 同步数据库检查完成");
        } catch (e) {
          setupText = "";
          await showError(e);
        }
      }

      async function runTest(): Promise<void> {
        if (busy) return;
        setBusy(true, "正在验证 Token 与 Data Source 访问权限…");
        try {
          const info = await engine.testConnection();
          connectionText = `已连接：${info.workspaceName || info.botName || "Notion 工作区"}`;
          setBusy(false, "连接验证通过。");
          ctx.ui.showNotice("Notion 连接验证通过");
        } catch (e) {
          connectionText = "连接失败";
          await showError(e);
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
          setBusy(false, `预览完成：共 ${preview.plan.length} 项，请确认后执行。`);
        } catch (e) {
          await showError(e);
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
          await showError(e);
        } finally {
          progress = { done: 0, total: 0 };
        }
      }

      async function runSyncOne(): Promise<void> {
        if (busy || !singleNoteId) {
          notice = "请先选择要同步的笔记。";
          render();
          return;
        }
        setBusy(true, "正在同步单篇笔记…");
        try {
          const result = await engine.syncOneNote(singleNoteId);
          report = result.report;
          notice = result.message;
          ctx.ui.showNotice(result.message);
          await refreshMeta();
          setBusy(false, result.message);
        } catch (e) {
          await showError(e);
        }
      }

      async function runRestore(): Promise<void> {
        if (busy) return;
        try {
          const mappings = await loadMappings(ctx);
          let n = 0;
          for (const [id, m] of Object.entries(mappings)) {
            if (m?.status === "deleted" && (await restoreMapping(ctx, id))) n++;
          }
          await refreshMeta();
          notice = `已恢复 ${n} 条映射，请重新生成预览。`;
          render();
        } catch (e) {
          await showError(e);
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
          await showError(e);
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
        else if (action === "sync-one") void runSyncOne();
        else if (action === "restore") void runRestore();
        else if (action === "retry") void runRetry();
        else if (action === "clear-notebooks") void clearNotebooks();
        else if (action === "resolve") {
          const key = target.dataset.key;
          const value = target.dataset.value as ConflictResolution | undefined;
          if (key && value) {
            resolutions[key] = value;
            render();
          }
        }
      }

      async function clearNotebooks(): Promise<void> {
        await saveNotebookSelection(ctx, []);
        settingsSnapshot = { ...settingsSnapshot, notebookIds: [] };
        preview = null;
        notice = "已清空笔记本选择，将同步全部笔记本。";
        await refreshMeta();
        render();
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
        if (control === "single-note") {
          singleNoteId = (target as HTMLSelectElement).value;
          render();
          return;
        }
        if (control === "notebook") {
          const id = target?.dataset?.id ?? "";
          const checked = (target as HTMLInputElement).checked;
          const next = new Set(settingsSnapshot.notebookIds);
          if (checked) next.add(id);
          else next.delete(id);
          const ids = Array.from(next).filter(Boolean);
          settingsSnapshot = { ...settingsSnapshot, notebookIds: ids };
          preview = null;
          notice = ids.length ? `已选择 ${ids.length} 个笔记本，请重新生成预览。` : "未勾选任何笔记本，将同步全部笔记本。";
          void saveNotebookSelection(ctx, ids).then(() => refreshMeta());
          render();
          return;
        }
        if (control === "direction") {
          const value = (target as HTMLSelectElement).value;
          void (async () => {
            try {
              await ctx.settings.set("sync-direction", value);
              settingsSnapshot = { ...settingsSnapshot, direction: value };
              preview = null;
              notice = "同步方向已更新，请重新生成预览。";
              render();
            } catch (e) {
              await showError(e);
            }
          })();
        }
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
