import type { PluginContext } from "../types";
import { STORAGE_KEYS } from "./mapping";

/**
 * 一键生成的同步数据库记录。
 * 与映射表一样按插件 ID 隔离在 context.storage；换插件 ID 后记录不继承。
 */
export interface SetupRecord {
  databaseId: string;
  dataSourceId: string;
  parentPageId: string;
  databaseUrl?: string;
  databaseTitle?: string;
  createdAt: string;
  propertyNames: string[];
}

const KEY = `${STORAGE_KEYS.setup}`;

export async function loadSetupRecord(ctx: PluginContext): Promise<SetupRecord | undefined> {
  const raw = (await ctx.storage.get(KEY)) as Partial<SetupRecord> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.dataSourceId !== "string" || !raw.dataSourceId) return undefined;
  if (typeof raw.databaseId !== "string" || !raw.databaseId) return undefined;
  return {
    databaseId: raw.databaseId,
    dataSourceId: raw.dataSourceId,
    parentPageId: typeof raw.parentPageId === "string" ? raw.parentPageId : "",
    databaseUrl: typeof raw.databaseUrl === "string" ? raw.databaseUrl : undefined,
    databaseTitle: typeof raw.databaseTitle === "string" ? raw.databaseTitle : undefined,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    propertyNames: Array.isArray(raw.propertyNames) ? raw.propertyNames.filter((n) => typeof n === "string") : [],
  };
}

export async function saveSetupRecord(ctx: PluginContext, record: SetupRecord): Promise<void> {
  await ctx.storage.set(KEY, record);
}

export const SETUP_STORAGE_KEY = KEY;
