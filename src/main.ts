import type { PluginContext } from "./types";
import { SyncEngine } from "./sync/engine";
import { loadSettings } from "./config/settings";
import { addPending, loadState, loadReport, markDeleted } from "./sync/mapping";
import { openSyncPanel, PANEL_ID, registerPanel } from "./ui/panel";
import { errMsg } from "./util";

function extractNoteId(payload: unknown): string | undefined {
  const p = payload as { note?: { id?: string }; noteId?: string; id?: string } | undefined;
  const id = p?.note?.id ?? p?.noteId ?? p?.id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * EdgeEver 插件入口：默认导出含 activate(context)，停用逻辑放在返回的清理函数中。
 * 支持平台 web / desktop；不声明 Android / iOS 原生端支持。
 */
export default {
  activate(context: PluginContext): () => void {
    const ctx = context;
    const engine = new SyncEngine(ctx);
    const disposers: Array<() => void> = [];
    let autoTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    disposers.push(registerPanel(ctx, engine));

    disposers.push(
      ctx.commands.register({
        id: "notion-sync-open-panel",
        title: "Notion 同步：打开同步面板",
        run: () => openSyncPanel(ctx),
      }),
    );

    disposers.push(
      ctx.commands.register({
        id: "notion-sync-preview",
        title: "Notion 同步：生成只读预览",
        run: () => ctx.ui.panels.open(PANEL_ID, { state: { autoPreview: true } }),
      }),
    );

    disposers.push(
      ctx.commands.register({
        id: "notion-sync-status",
        title: "Notion 同步：查看上次结果",
        run: async () => {
          const [state, report, settings] = await Promise.all([
            loadState(ctx),
            loadReport(ctx),
            loadSettings(ctx),
          ]);
          const parts = [
            `Token ${settings.token ? "已配置" : "未配置"}`,
            `笔记本 ${settings.notebookId || "未选择"}`,
            `方向 ${settings.direction}`,
            `首次同步 ${state.firstSyncDone ? "已完成" : "未进行"}`,
          ];
          if (report) {
            const c = report.counts;
            parts.push(`上次：新增 ${c.created} / 更新 ${c.updated} / 冲突 ${c.conflicts} / 失败 ${c.failed}`);
          }
          ctx.ui.showNotice(`Notion 同步 · ${parts.join(" · ")}`);
        },
      }),
    );

    /**
     * 自动同步：事件只入队 + 防抖，不在每个事件里发请求。
     * 仅在完成过首次手动同步后生效；冲突、新建、特殊笔记一律留给手动同步。
     */
    const scheduleAutoSync = async (noteId?: string): Promise<void> => {
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
              ctx.ui.showNotice(`Notion 自动同步有 ${report.counts.failed} 项失败，请打开同步面板查看`);
            }
          } catch (e) {
            // 自动同步失败保持安静，避免反复打扰；错误会在面板手动同步时可见
            void e;
          }
        }, settings.autoSyncDelaySec * 1000);
      } catch {
        /* 配置尚未就绪时不安排自动同步 */
      }
    };

    disposers.push(
      ctx.events.on("note.created", (payload) => {
        void scheduleAutoSync(extractNoteId(payload));
      }),
    );
    disposers.push(
      ctx.events.on("note.updated", (payload) => {
        void scheduleAutoSync(extractNoteId(payload));
      }),
    );
    disposers.push(
      ctx.events.on("note.deleted", (payload) => {
        const id = extractNoteId(payload);
        if (!id) return;
        // 软删除：只标记映射，不动 Notion 页面，也不永久删除 EdgeEver 笔记
        void markDeleted(ctx, id, new Date().toISOString()).catch(() => undefined);
      }),
    );
    disposers.push(
      ctx.events.on("settings.changed", (payload) => {
        const key = (payload as { key?: string } | undefined)?.key;
        if (key === "auto-sync" || key === "auto-sync-delay-sec") void scheduleAutoSync();
      }),
    );
    disposers.push(
      ctx.events.on("workspace.synced", () => {
        void scheduleAutoSync();
      }),
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
  },
};
