import type { PluginContext, PluginNote, PluginNotebook, PluginResource } from "../types";
import { asString } from "../util";

const SUPPORTED_KINDS = new Set(["text", "", "markdown", "note"]);

export function notebookLabel(nb: PluginNotebook): string {
  return asString(nb.name ?? nb.title ?? nb.id);
}

export async function listNotebooks(ctx: PluginContext): Promise<PluginNotebook[]> {
  const result = await ctx.notebooks.list();
  return Array.isArray(result) ? result.filter((n) => n && typeof n.id === "string") : [];
}

export function notebookNameMap(notebooks: PluginNotebook[]): Map<string, string> {
  return new Map(notebooks.map((nb) => [nb.id, notebookLabel(nb)]));
}

/** 从 Notion 侧独有页面新建 EdgeEver 笔记时，选择一个存在且可写的目标笔记本。 */
export function pickTargetNotebookId(
  notebookIds: string[],
  notebooks: PluginNotebook[],
  preferred?: string,
): string {
  if (preferred && notebooks.some((n) => n.id === preferred)) return preferred;
  const selected = notebookIds.find((id) => notebooks.some((n) => n.id === id));
  return selected ?? notebooks[0]?.id ?? "";
}

export interface NoteScanResult {
  supported: PluginNote[];
  unsupported: PluginNote[];
  warnings: string[];
}

/**
 * 先用 notes.query() 分页取摘要（官方明确支持 notebookId / limit / offset / nextOffset），
 * 再逐篇 notes.get() 取完整正文。避免假设 queryContent() 支持哪些筛选参数。
 * notebookIds 为空表示全部笔记本；多个时分别查询并按 ID 去重。
 */
export async function listNotes(ctx: PluginContext, notebookIds: string[]): Promise<NoteScanResult> {
  const ids = Array.from(new Set((notebookIds ?? []).filter(Boolean)));
  const targets = ids.length ? ids : [""];
  const summaries: Array<{ id: string; kind?: string }> = [];
  const seen = new Set<string>();

  for (const notebookId of targets) {
    let offset = 0;
    const pageSize = 200;
    for (let page = 0; page < 50; page++) {
      const res = await ctx.notes.query({
        ...(notebookId ? { notebookId } : {}),
        limit: pageSize,
        offset,
        sort: "updated-desc",
      });
      const list = Array.isArray(res?.notes) ? res.notes : [];
      for (const n of list) {
        if (n?.id && !seen.has(n.id)) {
          seen.add(n.id);
          summaries.push({ id: n.id, kind: n.kind });
        }
      }
      const next = res?.nextOffset;
      if (typeof next !== "number" || list.length === 0) break;
      offset = next;
    }
  }

  const supported: PluginNote[] = [];
  const unsupported: PluginNote[] = [];
  const warnings: string[] = [];

  for (const summary of summaries) {
    let note: PluginNote | null;
    try {
      note = await ctx.notes.get(summary.id);
    } catch (e) {
      warnings.push(`笔记 ${summary.id} 读取失败：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!note) continue;
    const kind = asString(note.kind ?? summary.kind ?? "", "text").toLowerCase();
    if (!SUPPORTED_KINDS.has(kind)) {
      unsupported.push(note);
      continue;
    }
    if (note.deletedAt) continue; // 回收站中的笔记不参与同步
    supported.push(note);
  }

  return { supported, unsupported, warnings };
}

export interface NoteOption {
  id: string;
  title: string;
  notebookName: string;
  kind?: string;
}

/** 面板「同步单篇笔记」下拉用的轻量摘要列表；按选中的笔记本过滤。 */
export async function listNoteOptions(ctx: PluginContext, notebookIds: string[]): Promise<NoteOption[]> {
  const notebooks = await listNotebooks(ctx);
  const names = notebookNameMap(notebooks);
  const filter = new Set((notebookIds ?? []).filter(Boolean));
  const out: NoteOption[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const res = await ctx.notes.query({ limit: 200, offset, sort: "updated-desc" });
    const list = Array.isArray(res?.notes) ? res.notes : [];
    for (const n of list) {
      if (!n?.id || seen.has(n.id)) continue;
      seen.add(n.id);
      const nbId = noteNotebookId(n);
      if (filter.size && !filter.has(nbId)) continue;
      out.push({
        id: n.id,
        title: asString(n.title, "").trim() || "未命名笔记",
        notebookName: names.get(nbId) ?? "",
        kind: n.kind,
      });
    }
    const next = res?.nextOffset;
    if (typeof next !== "number" || list.length === 0) break;
    offset = next;
  }
  return out;
}

export function noteTitle(note: PluginNote): string {
  return asString(note.title, "").trim() || "未命名笔记";
}

export function noteTags(note: PluginNote): string[] {
  if (!Array.isArray(note.tags)) return [];
  return note.tags.map((t) => asString(t).trim()).filter(Boolean);
}

export function noteNotebookId(note: PluginNote): string {
  return asString(note.notebookId ?? note.notebook_id ?? "", "");
}

export function noteUpdatedAt(note: PluginNote): string | undefined {
  const raw = note.updatedAt ?? note.updated_at;
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function listResources(ctx: PluginContext, noteId: string): Promise<PluginResource[]> {
  try {
    const res = await ctx.resources.list(noteId);
    return Array.isArray(res) ? res.filter((r) => r && typeof r.id === "string") : [];
  } catch {
    return [];
  }
}

/** 把 resources.read() 的多种返回形态统一为 Blob，便于 multipart 上传。 */
export async function readResourceBlob(ctx: PluginContext, resource: PluginResource): Promise<Blob> {
  const value = await ctx.resources.read(resource.id);
  const mime = resource.mimeType ?? resource.mime ?? "application/octet-stream";
  if (value instanceof Blob) return value;
  if (value instanceof ArrayBuffer) return new Blob([value], { type: mime });
  if (value instanceof Uint8Array) return new Blob([value as BlobPart], { type: mime });
  const data = (value as { data?: ArrayBuffer | Uint8Array } | undefined)?.data;
  if (data instanceof ArrayBuffer) return new Blob([data], { type: mime });
  if (data instanceof Uint8Array) return new Blob([data as BlobPart], { type: mime });
  throw new Error(`资源 ${resource.id} 的内容格式无法读取，已保留占位信息`);
}

export async function createNote(
  ctx: PluginContext,
  input: { notebookId: string; title: string; contentMarkdown: string; tags: string[] },
): Promise<PluginNote> {
  return ctx.notes.create(input);
}

export async function updateNote(
  ctx: PluginContext,
  noteId: string,
  patch: { title?: string; contentMarkdown?: string; tags?: string[] },
): Promise<void> {
  await ctx.notes.update(noteId, patch);
}
