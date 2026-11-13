import type {
  ConflictResolution,
  NoteMapping,
  PluginContext,
  PluginSettings,
  SyncAction,
  SyncPlanItem,
  SyncReport,
  NotionPage,
} from "../types";
import { NotionClient, NotionError } from "../notion/client";
import { RequestQueue } from "./queue";
import { loadSettings, validateSettings } from "../config/settings";
import {
  findPageByEdgeeverId,
  queryAllPages,
  resolveDataSourceId,
  verifyConnection,
  type ConnectionInfo,
} from "../notion/data-sources";
import {
  createPage,
  optionalProperties,
  patchProperties,
  plainText,
  readTags,
  readTitle,
  requiredProperties,
  retrievePage,
} from "../notion/pages";
import { getPageMarkdown, incompleteReasons, replacePageMarkdown } from "../notion/markdown";
import { ensureSyncDatabase, type SetupResult } from "../notion/setup";
import {
  canonicalContent,
  toEdgeeverMarkdown,
  toNotionMarkdown,
} from "../converters/markdown";
import { contentHash } from "./hash";
import { decide, decisionLabel } from "./conflict";
import {
  loadMappings,
  loadState,
  saveMappings,
  saveReport,
  saveState,
  clearPending,
} from "./mapping";
import { syncAttachments } from "./attachments";
import {
  createNote,
  listNotes,
  listNotebooks,
  listResources,
  noteTags,
  noteTitle,
  noteUpdatedAt,
  updateNote,
} from "../edgeever/notes";
import { errMsg, nowIso, redact } from "../util";

export type Counts = SyncReport["counts"];

export interface PreviewResult {
  plan: SyncPlanItem[];
  counts: Counts;
  warnings: string[];
  dataSourceId: string;
  notebooks: Awaited<ReturnType<typeof listNotebooks>>;
  auto: boolean;
}

export type ProgressFn = (done: number, total: number, item: SyncPlanItem) => void;

interface Setup {
  settings: PluginSettings;
  client: NotionClient;
  dataSourceId: string;
}

interface ApplyTask {
  settings: PluginSettings;
  client: NotionClient;
  dataSourceId: string;
  mappings: Record<string, NoteMapping>;
  item: SyncPlanItem;
  resolution: ConflictResolution;
  maxFileUploadBytes?: number;
}

interface ItemResult {
  action: SyncAction;
  message: string;
  warnings?: string[];
}

function emptyCounts(): Counts {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    conflicts: 0,
    unsupported: 0,
    incomplete: 0,
    failed: 0,
    deleted: 0,
  };
}

function bump(counts: Counts, action: SyncAction): void {
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

/** 双向同步引擎：先 preview（只读），再由用户在面板确认后 apply（可写）。 */
export class SyncEngine {
  private readonly queue = new RequestQueue(340);
  private connection?: ConnectionInfo;

  constructor(private readonly ctx: PluginContext) {}

  private async setup(): Promise<Setup> {
    const settings = await loadSettings(this.ctx);
    const configError = validateSettings(settings);
    if (configError) throw new Error(configError);
    const client = new NotionClient(
      settings,
      (url, options) => this.ctx.network.fetch(url, options),
      this.queue,
    );
    const dataSourceId = await resolveDataSourceId(client, settings);
    return { settings, client, dataSourceId };
  }

  async testConnection(): Promise<ConnectionInfo> {
    const { client, dataSourceId } = await this.setup();
    const info = await verifyConnection(client, dataSourceId);
    this.connection = info;
    return info;
  }

  /** 一键生成/检查同步数据库。此时可能还没有 Data Source ID，因此不走 setup() 的校验。 */
  async setupDatabase(): Promise<SetupResult> {
    const settings = await loadSettings(this.ctx);
    if (!settings.token) {
      throw new Error("请先在插件设置中填写 Notion Integration Token（secret 字段）。");
    }
    const client = new NotionClient(
      settings,
      (url, options) => this.ctx.network.fetch(url, options),
      this.queue,
    );
    return ensureSyncDatabase(this.ctx, client, settings);
  }

  /**
   * 只读预览。首次全量同步必须先经过这里（规范 §14）。
   * auto=true 时只保留「已有映射且可安全单向更新」的条目，供自动同步使用。
   */
  async preview(options: { auto?: boolean } = {}): Promise<PreviewResult> {
    const auto = options.auto === true;
    const { settings, client, dataSourceId } = await this.setup();
    const warnings: string[] = [];
    const counts = emptyCounts();
    const plan: SyncPlanItem[] = [];
    const mappings = await loadMappings(this.ctx);
    const notebooks = await listNotebooks(this.ctx);

    if (auto) {
      const state = await loadState(this.ctx);
      if (!state.firstSyncDone) {
        return { plan: [], counts, warnings: ["首次同步必须由用户手动触发，自动同步已跳过。"], dataSourceId, notebooks, auto };
      }
    }

    const scan = await listNotes(this.ctx, settings.notebookId);
    warnings.push(...scan.warnings);
    for (const note of scan.unsupported) {
      const item: SyncPlanItem = {
        key: note.id,
        action: "unsupported",
        title: noteTitle(note),
        reason: `特殊笔记类型（kind=${note.kind ?? "unknown"}），首版不以普通 Markdown 覆盖，已跳过。`,
        edgeeverNoteId: note.id,
        note,
      };
      pushItem(plan, counts, item, auto);
    }

    const query = await queryAllPages(client, dataSourceId);
    if (query.incomplete) {
      warnings.push("Data Source 查询结果达到 10,000 条上限，本次不是完整数据集，请按时间范围分批同步。");
    }

    const activePages = query.pages.filter((p) => !p.in_trash && !p.is_archived);
    const archivedPages = query.pages.filter((p) => p.in_trash || p.is_archived);
    for (const page of archivedPages) {
      warnings.push(`Notion 页面 ${page.id} 已归档或移入回收站；只提示，不自动删除 EdgeEver 笔记。`);
    }

    const pageByEeId = new Map<string, NotionPage>();
    for (const page of activePages) {
      const eeId = plainText(page.properties?.[settings.props.edgeeverId]).trim();
      if (eeId) pageByEeId.set(eeId, page);
    }
    const knownEeIds = new Set(scan.supported.map((n) => n.id));

    // ---------- EdgeEver → 计划项 ----------
    for (const note of scan.supported) {
      const resources = await listResources(this.ctx, note.id);
      const title = noteTitle(note);
      const tags = noteTags(note);
      const mapping = mappings[note.id];
      const base: SyncPlanItem = {
        key: note.id,
        action: "skip",
        title,
        reason: "",
        edgeeverNoteId: note.id,
        notionPageId: mapping?.notionPageId,
        note,
        noteTitle: title,
        tags,
        resources,
      };

      if (mapping?.status === "deleted") {
        pushItem(plan, counts, {
          ...base,
          action: "deleted",
          reason: "该映射已标记为删除，不会自动重建或永久删除任一端数据。可在面板执行「恢复同步」。",
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
            reason: "Notion 已存在相同 EdgeEver ID 的页面，将在执行时修复本地映射，不重复创建。",
          }, auto);
        } else if (settings.direction === "pull") {
          pushItem(plan, counts, { ...base, reason: "仅拉取模式下不向 Notion 推送新笔记。" }, auto);
        } else {
          pushItem(plan, counts, {
            ...base,
            action: "create-notion",
            markdown: toNotionMarkdown(note.contentMarkdown ?? "", resources),
            reason: "本地笔记尚无映射，将在确认后创建 Notion 页面。",
          }, auto);
        }
        continue;
      }

      let page = activePages.find((p) => p.id === mapping.notionPageId);
      if (!page) {
        try {
          page = await retrievePage(client, mapping.notionPageId);
        } catch {
          page = undefined;
        }
      }
      if (!page || page.in_trash || page.is_archived) {
        pushItem(plan, counts, {
          ...base,
          action: "deleted",
          reason: "映射指向的 Notion 页面不可访问或已归档/删除；不自动重建，也不删除 EdgeEver 笔记。",
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
          reason: `Notion 正文不完整：${reasons.join("；")}。已跳过，不会把不完整内容写回 EdgeEver。`,
        }, auto);
        continue;
      }

      const edgeeverHash = await contentHash(canonicalContent(note.contentMarkdown ?? "", resources));
      const notionHash = await contentHash(canonicalContent(remote.markdown ?? "", resources));
      const decision = decide({ edgeeverHash, notionHash, mapping });
      const shared: SyncPlanItem = {
        ...base,
        notionPageId: page.id,
        page,
        remoteMarkdown: remote.markdown ?? "",
        edgeeverHash,
        notionHash,
        baselineHash: mapping.lastSyncedHash,
      };

      if (decision === "conflict") {
        pushItem(plan, counts, {
          ...shared,
          action: "conflict",
          reason: `${decisionLabel(decision)}；默认不覆盖任一端，请在面板选择「保留 EdgeEver」「保留 Notion」或「稍后处理」。`,
          resolution: "later",
        }, auto);
        continue;
      }
      if (decision === "skip" || decision === "both-same") {
        pushItem(plan, counts, {
          ...shared,
          reason:
            decision === "both-same"
              ? "两端最终内容相同，仅更新同步基线。"
              : "两端相对上次同步均无变化。",
        }, auto);
        continue;
      }
      if (decision === "push") {
        if (settings.direction === "pull") {
          pushItem(plan, counts, { ...shared, reason: "仅拉取模式：忽略 EdgeEver 侧修改。" }, auto);
        } else {
          pushItem(plan, counts, {
            ...shared,
            action: "update-notion",
            markdown: toNotionMarkdown(note.contentMarkdown ?? "", resources),
            reason: "仅 EdgeEver 修改，将在确认后更新 Notion 正文与属性。",
          }, auto);
        }
        continue;
      }
      // pull
      if (settings.direction === "push") {
        pushItem(plan, counts, { ...shared, reason: "仅推送模式：忽略 Notion 侧修改。" }, auto);
      } else {
        pushItem(plan, counts, {
          ...shared,
          action: "update-edgeever",
          markdown: toEdgeeverMarkdown(remote.markdown ?? "", resources),
          noteTitle: readTitle(page, settings.props.name) || title,
          tags: readTags(page.properties?.[settings.props.tags]),
          reason: "仅 Notion 修改，将在确认后更新 EdgeEver 笔记。",
        }, auto);
      }
    }

    // ---------- Notion 侧独有页面 ----------
    for (const page of activePages) {
      const eeId = plainText(page.properties?.[settings.props.edgeeverId]).trim();
      if (eeId && knownEeIds.has(eeId)) continue; // 已在上面处理
      const title = readTitle(page, settings.props.name) || `Notion 页面 ${page.id.slice(0, 8)}`;
      const base: SyncPlanItem = {
        key: page.id,
        action: "skip",
        title,
        reason: "",
        notionPageId: page.id,
        page,
        noteTitle: title,
        tags: readTags(page.properties?.[settings.props.tags]),
        resources: [],
      };

      if (eeId) {
        const mapping = mappings[eeId];
        pushItem(plan, counts, {
          ...base,
          action: "deleted",
          edgeeverNoteId: eeId,
          reason: mapping?.status === "deleted"
            ? "映射已标记为删除，不自动恢复或删除。"
            : "远端页面带有 EdgeEver ID，但对应笔记不在所选笔记本中或已被删除；不做自动删除。",
        }, auto);
        continue;
      }

      if (settings.direction === "push") {
        warnings.push(`Notion 页面「${title}」没有 EdgeEver ID 属性；仅推送模式下已忽略。`);
        continue;
      }

      const remote = await getPageMarkdown(client, page.id, settings.markdownVersion);
      const reasons = incompleteReasons(remote, "read");
      if (reasons.length) {
        pushItem(plan, counts, {
          ...base,
          action: "incomplete",
          remoteMarkdown: remote.markdown ?? "",
          reason: `Notion 正文不完整：${reasons.join("；")}。已跳过。`,
        }, auto);
        continue;
      }
      pushItem(plan, counts, {
        ...base,
        action: "create-edgeever",
        remoteMarkdown: remote.markdown ?? "",
        markdown: toEdgeeverMarkdown(remote.markdown ?? "", []),
        reason: "Notion 页面尚无 EdgeEver ID，将在确认后创建 EdgeEver 笔记并回写映射。",
      }, auto);
    }

    if (!auto) await saveState(this.ctx, { ...(await loadState(this.ctx)), lastPreviewAt: nowIso() });
    return { plan, counts, warnings, dataSourceId, notebooks, auto };
  }

  /** 执行计划。每条独立失败不影响整批；冲突默认「稍后处理」。 */
  async apply(
    plan: SyncPlanItem[],
    resolutions: Record<string, ConflictResolution> = {},
    onProgress?: ProgressFn,
  ): Promise<SyncReport> {
    const { settings, client, dataSourceId } = await this.setup();
    const report: SyncReport = {
      startedAt: nowIso(),
      finishedAt: "",
      direction: settings.direction,
      counts: emptyCounts(),
      warnings: [],
      items: [],
    };
    const mappings = await loadMappings(this.ctx);
    const maxFileUploadBytes = this.connection?.maxFileUploadBytes;
    let done = 0;

    for (const item of plan) {
      done++;
      onProgress?.(done, plan.length, item);
      let resolution: ConflictResolution = item.resolution ?? "later";
      if (item.action === "conflict" && resolutions[item.key]) resolution = resolutions[item.key];

      try {
        const result = await this.applyItem({
          settings,
          client,
          dataSourceId,
          mappings,
          item,
          resolution,
          maxFileUploadBytes,
        });
        report.items.push({ key: item.key, title: item.title, action: result.action, message: result.message });
        bump(report.counts, result.action);
        if (result.warnings?.length) report.warnings.push(...result.warnings);
      } catch (e) {
        let message = redact(errMsg(e), settings.token);
        if (e instanceof NotionError && e.maybeCommitted) {
          message += "（该写请求可能已生效，请重新预览确认；插件不会自动重放写入）";
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
      ...(await loadState(this.ctx)),
      firstSyncDone: true,
      lastSyncAt: report.finishedAt,
    });
    await saveReport(this.ctx, report);
    await clearPending(this.ctx);
    return report;
  }

  private async applyItem(task: ApplyTask): Promise<ItemResult> {
    const { item, resolution } = task;
    if (item.action === "conflict" && (resolution === "edgeever" || resolution === "notion")) {
      const forced: SyncPlanItem = {
        ...item,
        action: resolution === "edgeever" ? "update-notion" : "update-edgeever",
        markdown:
          resolution === "edgeever"
            ? toNotionMarkdown(item.note?.contentMarkdown ?? "", item.resources ?? [])
            : toEdgeeverMarkdown(item.remoteMarkdown ?? "", item.resources ?? []),
        noteTitle: resolution === "notion" ? readTitle(item.page!, task.settings.props.name) || item.title : item.title,
        tags: resolution === "notion" ? readTags(item.page?.properties?.[task.settings.props.tags]) : item.tags,
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
        if (item.reason.includes("修复本地映射") && item.page && item.edgeeverNoteId) {
          await this.saveRecoveredMapping(task, item.edgeeverNoteId, item.page.id);
          return { action: "skip", message: "已修复本地映射，未重复创建页面。" };
        }
        return { action: "skip", message: item.reason || "无需写入。" };
      default:
        return { action: item.action, message: item.reason };
    }
  }

  private async saveRecoveredMapping(task: ApplyTask, noteId: string, pageId: string): Promise<void> {
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
      title: item.title,
    };
  }

  private async createNotion(task: ApplyTask): Promise<ItemResult> {
    const { settings, client, dataSourceId, mappings, item } = task;
    const noteId = item.edgeeverNoteId!;
    if (mappings[noteId]) return { action: "skip", message: "映射已存在，跳过创建（幂等保护）。" };

    // 写入前再次确认，避免预览之后页面已被创建
    const existing = await findPageByEdgeeverId(client, dataSourceId, settings.props.edgeeverId, noteId);
    if (existing) {
      await this.saveRecoveredMapping({ ...task, item: { ...item, page: existing } }, noteId, existing.id);
      return { action: "skip", message: "远端已存在同 ID 页面，已修复映射，未重复创建。" };
    }

    const page = await createPage(client, settings, dataSourceId, {
      title: item.title,
      edgeeverId: noteId,
      markdown: item.markdown ?? "",
    });
    const warnings = await this.writeMetadata(task, page.id, noteId, "Synced");
    const attach = await syncAttachments({
      ctx: this.ctx,
      client,
      settings,
      item,
      pageId: page.id,
      resources: item.resources ?? [],
      maxFileUploadBytes: task.maxFileUploadBytes,
    });
    warnings.push(...attach.warnings);
    warnings.push(...(await this.finalize(task, noteId, page.id, item.note?.contentMarkdown ?? "")));
    return {
      action: "create-notion",
      message: `已创建 Notion 页面 ${page.id}；附件新增 ${attach.attached}、复用/跳过 ${attach.skipped}、失败 ${attach.failed}。`,
      warnings,
    };
  }

  private async updateNotion(task: ApplyTask): Promise<ItemResult> {
    const { settings, client, mappings, item } = task;
    const pageId = item.notionPageId!;
    const noteId = item.edgeeverNoteId!;
    const resources = item.resources ?? [];

    // 远端在预览后又被改动 → 不覆盖
    const fresh = await getPageMarkdown(client, pageId, settings.markdownVersion);
    const reasons = incompleteReasons(fresh, "read");
    if (reasons.length) throw new Error(`Notion 正文在同步时变为不完整状态：${reasons.join("；")}`);
    const freshHash = await contentHash(canonicalContent(fresh.markdown ?? "", resources));
    if (item.notionHash && freshHash !== item.notionHash) {
      return { action: "skip", message: "远端正文在预览之后发生变化，已跳过本次写入，请重新预览。" };
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
      maxFileUploadBytes: task.maxFileUploadBytes,
    });
    warnings.push(...attach.warnings);
    warnings.push(...(await this.finalize(task, noteId, pageId, item.note?.contentMarkdown ?? "")));
    return {
      action: "update-notion",
      message: `已更新 Notion 页面 ${pageId}；附件新增 ${attach.attached}、复用/跳过 ${attach.skipped}、失败 ${attach.failed}。`,
      warnings,
    };
  }

  private async createEdgeever(task: ApplyTask): Promise<ItemResult> {
    const { settings, client, mappings, item } = task;
    const pageId = item.notionPageId!;

    // 幂等：再次读取属性，可能已被其它窗口写入 EdgeEver ID
    const page = await retrievePage(client, pageId);
    const existingId = plainText(page.properties?.[settings.props.edgeeverId]).trim();
    if (existingId && mappings[existingId]) {
      return { action: "skip", message: "该页面已建立映射，跳过创建 EdgeEver 笔记。" };
    }

    const created = await createNote(this.ctx, {
      notebookId: settings.notebookId,
      title: item.noteTitle ?? item.title,
      contentMarkdown: item.markdown ?? "",
      tags: item.tags ?? [],
    });
    const noteId = created.id;
    const warnings: string[] = [];
    try {
      await patchProperties(client, pageId, requiredProperties(settings, item.noteTitle ?? item.title, noteId));
    } catch (e) {
      warnings.push(`回写 EdgeEver ID 到 Notion 属性失败：${redact(errMsg(e), settings.token)}（下次同步可能重复创建，请检查属性名与类型）`);
    }
    warnings.push(...(await this.finalize(task, noteId, pageId, item.markdown ?? "")));
    return { action: "create-edgeever", message: `已创建 EdgeEver 笔记 ${noteId} 并写入映射。`, warnings };
  }

  private async updateEdgeever(task: ApplyTask): Promise<ItemResult> {
    const { settings, client, mappings, item } = task;
    const pageId = item.notionPageId!;
    const noteId = item.edgeeverNoteId!;
    const resources = item.resources ?? [];

    const fresh = await getPageMarkdown(client, pageId, settings.markdownVersion);
    const reasons = incompleteReasons(fresh, "read");
    if (reasons.length) throw new Error(`Notion 正文在同步时变为不完整状态：${reasons.join("；")}`);
    const freshHash = await contentHash(canonicalContent(fresh.markdown ?? "", resources));
    if (item.notionHash && freshHash !== item.notionHash) {
      return { action: "skip", message: "远端正文在预览之后发生变化，已跳过本次写入，请重新预览。" };
    }

    await updateNote(this.ctx, noteId, {
      title: item.noteTitle ?? item.title,
      contentMarkdown: item.markdown ?? "",
      tags: item.tags ?? [],
    });
    const warnings = await this.writeMetadata(task, pageId, noteId, "Synced");
    warnings.push(...(await this.finalize(task, noteId, pageId, item.markdown ?? "")));
    return { action: "update-edgeever", message: `已更新 EdgeEver 笔记 ${noteId}。`, warnings };
  }

  /** 属性更新分两步：必需属性、可选属性；失败只记警告，不回滚已成功的正文写入。 */
  private async writeMetadata(task: ApplyTask, pageId: string, noteId: string, status: string): Promise<string[]> {
    const { settings, client, item } = task;
    const warnings: string[] = [];
    try {
      await patchProperties(client, pageId, requiredProperties(settings, item.noteTitle ?? item.title, noteId));
    } catch (e) {
      warnings.push(`更新标题/EdgeEver ID 属性失败：${redact(errMsg(e), settings.token)}`);
    }
    try {
      const optional = optionalProperties(settings, {
        notebookId: settings.notebookId,
        tags: item.tags ?? [],
        contentHash: item.edgeeverHash,
        lastSynced: nowIso(),
        syncStatus: status,
        edgeeverUpdated: (item.note ? noteUpdatedAt(item.note) : undefined) ?? nowIso(),
      });
      await patchProperties(client, pageId, optional);
    } catch (e) {
      warnings.push(
        `更新可选属性失败（请检查数据库中 Tags/Hash/Last Synced/Sync Status 的类型）：${redact(errMsg(e), settings.token)}`,
      );
    }
    return warnings;
  }

  /** 写入后回读 Notion，保存双基线 Hash，避免下次同步出现假冲突。 */
  private async finalize(
    task: ApplyTask,
    noteId: string,
    pageId: string,
    edgeeverMarkdown: string,
  ): Promise<string[]> {
    const { settings, client, mappings, item } = task;
    const resources = item.resources ?? [];
    const remote = await getPageMarkdown(client, pageId, settings.markdownVersion);
    // 正文写入已成功，不抛错；把风险写进同步报告，让用户在 Notion 中核对
    const warnings = incompleteReasons(remote, "write").map(
      (r) => `页面 ${pageId} 写入后回读：${r}。请在 Notion 中核对后再执行下一次同步。`,
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
      title: item.noteTitle ?? item.title,
    };
    return warnings;
  }
}

/** auto 模式下只保留已有映射且可安全单向更新的条目，冲突与新建一律留给手动同步。 */
function pushItem(plan: SyncPlanItem[], counts: Counts, item: SyncPlanItem, auto: boolean): void {
  if (auto) {
    const safe = item.action === "update-notion" || item.action === "update-edgeever" || item.action === "skip";
    if (!safe) return;
    if (item.action !== "skip" && !item.edgeeverNoteId) return;
  }
  plan.push(item);
  bump(counts, item.action);
}
