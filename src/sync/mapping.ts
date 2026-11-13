import type { PluginContext, NoteMapping, ResourceMapping, SyncReport } from "../types";

export const STORAGE_KEYS = {
  mappings: "notion-sync:mappings",
  resources: "notion-sync:resources",
  report: "notion-sync:last-report",
  state: "notion-sync:state",
  pending: "notion-sync:pending",
  setup: "notion-sync:setup",
} as const;

export interface SyncState {
  firstSyncDone: boolean;
  lastPreviewAt?: string;
  lastSyncAt?: string;
  deletedNotionPageIds?: string[];
}

function asRecord<T>(value: unknown): Record<string, T> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, T>;
  return {};
}

export async function loadMappings(ctx: PluginContext): Promise<Record<string, NoteMapping>> {
  return asRecord<NoteMapping>(await ctx.storage.get(STORAGE_KEYS.mappings));
}

export async function saveMappings(ctx: PluginContext, mappings: Record<string, NoteMapping>): Promise<void> {
  await ctx.storage.set(STORAGE_KEYS.mappings, mappings);
}

export async function loadResourceMappings(ctx: PluginContext): Promise<Record<string, ResourceMapping>> {
  return asRecord<ResourceMapping>(await ctx.storage.get(STORAGE_KEYS.resources));
}

export async function saveResourceMappings(
  ctx: PluginContext,
  mappings: Record<string, ResourceMapping>,
): Promise<void> {
  await ctx.storage.set(STORAGE_KEYS.resources, mappings);
}

export function mappingByPage(mappings: Record<string, NoteMapping>, pageId: string): NoteMapping | undefined {
  return Object.values(mappings).find((m) => m?.notionPageId === pageId);
}

export async function loadState(ctx: PluginContext): Promise<SyncState> {
  const raw = (await ctx.storage.get(STORAGE_KEYS.state)) as Partial<SyncState> | undefined;
  return { firstSyncDone: raw?.firstSyncDone === true, ...raw };
}

export async function saveState(ctx: PluginContext, state: SyncState): Promise<void> {
  await ctx.storage.set(STORAGE_KEYS.state, state);
}

export async function saveReport(ctx: PluginContext, report: SyncReport): Promise<void> {
  await ctx.storage.set(STORAGE_KEYS.report, report);
}

export async function loadReport(ctx: PluginContext): Promise<SyncReport | undefined> {
  return (await ctx.storage.get(STORAGE_KEYS.report)) as SyncReport | undefined;
}

/** 标记删除而不永久删除任一端数据（规范 §10）。 */
export async function markDeleted(ctx: PluginContext, noteId: string, at: string): Promise<void> {
  const mappings = await loadMappings(ctx);
  if (!mappings[noteId]) return;
  mappings[noteId] = { ...mappings[noteId], status: "deleted", deletedAt: at };
  await saveMappings(ctx, mappings);
}

export async function restoreMapping(ctx: PluginContext, noteId: string): Promise<boolean> {
  const mappings = await loadMappings(ctx);
  const m = mappings[noteId];
  if (!m) return false;
  const { deletedAt: _deletedAt, ...rest } = m;
  mappings[noteId] = { ...rest, status: "synced" };
  await saveMappings(ctx, mappings);
  return true;
}

/** 事件驱动的待同步队列（去重，不立即发起 API 请求）。 */
export async function addPending(ctx: PluginContext, noteIds: string[]): Promise<string[]> {
  const raw = await ctx.storage.get(STORAGE_KEYS.pending);
  const set = new Set(Array.isArray(raw) ? raw.map(String) : []);
  for (const id of noteIds) set.add(id);
  const list = Array.from(set).slice(0, 500);
  await ctx.storage.set(STORAGE_KEYS.pending, list);
  return list;
}

export async function loadPending(ctx: PluginContext): Promise<string[]> {
  const raw = await ctx.storage.get(STORAGE_KEYS.pending);
  return Array.isArray(raw) ? raw.map(String) : [];
}

export async function clearPending(ctx: PluginContext): Promise<void> {
  await ctx.storage.set(STORAGE_KEYS.pending, []);
}
