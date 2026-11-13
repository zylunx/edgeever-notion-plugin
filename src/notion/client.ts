import type { FetchLikeResponse, PluginSettings } from "../types";
import type { RequestQueue } from "../sync/queue";
import { errMsg, parseJson, redact, sleep } from "../util";

export class NotionError extends Error {
  status?: number;
  code?: string;
  retryAfter?: number;
  details?: unknown;
  /** 写入可能已生效但响应超时，调用方不应盲目重试。 */
  maybeCommitted?: boolean;

  constructor(message: string, meta: Partial<NotionError> = {}) {
    super(message);
    this.name = "NotionError";
    Object.assign(this, meta);
  }
}

export type FetchImpl = (url: string, options?: Record<string, unknown>) => Promise<FetchLikeResponse>;

const MAX_ATTEMPTS = 5;

/** 统一请求封装：队列、重试、限流、非 JSON 响应、错误脱敏。 */
export class NotionClient {
  constructor(
    private readonly settings: PluginSettings,
    private readonly fetchImpl: FetchImpl,
    private readonly queue: RequestQueue,
  ) {}

  get baseUrl(): string {
    return this.settings.apiBaseUrl.replace(/\/+$/, "");
  }

  /** 把 Notion 返回的绝对 URL 映射到当前配置的 baseUrl（自建代理场景）。 */
  rewriteUrl(url: string): string {
    if (this.baseUrl === "https://api.notion.com") return url;
    try {
      const u = new URL(url);
      const base = new URL(this.baseUrl);
      return `${base.origin}${base.pathname.replace(/\/$/, "")}${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.settings.token}`,
      "Notion-Version": this.settings.notionVersion,
      Accept: "application/json",
    };
    if (json) h["Content-Type"] = "application/json";
    // multipart/form-data 不手动设置 Content-Type，让宿主 fetch 自动带 boundary
    return h;
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const options: Record<string, unknown> = {
      method,
      headers: this.headers(body !== undefined),
    };
    if (body !== undefined) options.body = JSON.stringify(body);

    return this.queue.run(() => this.withRetry<T>(url, options, method));
  }

  /** 文件上传专用：multipart/form-data。 */
  async requestForm<T>(url: string, form: FormData): Promise<T> {
    const target = this.rewriteUrl(url);
    const options: Record<string, unknown> = {
      method: "POST",
      headers: this.headers(false),
      body: form,
    };
    return this.queue.run(() => this.withRetry<T>(target, options, "POST"));
  }

  private async withRetry<T>(url: string, options: Record<string, unknown>, method: string): Promise<T> {
    let lastError: NotionError | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let response: FetchLikeResponse;
      try {
        response = await this.fetchImpl(url, options);
      } catch (e) {
        // 网络层错误：仅对幂等请求做退避重试
        if (attempt + 1 < MAX_ATTEMPTS && (method === "GET" || method === "DELETE")) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new NotionError(redact(`网络请求失败：${errMsg(e)}`, this.settings.token));
      }

      const text = await safeText(response);
      const data = parseJson(text) as Record<string, unknown> | undefined;
      const retryAfter = readRetryAfter(response, data);

      if (response.ok) {
        return (data ?? (text as unknown)) as T;
      }

      const status = response.status;
      const code = typeof data?.code === "string" ? data.code : undefined;
      const message = redact(
        typeof data?.message === "string" ? data.message : text || `Notion API error: ${status}`,
        this.settings.token,
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
        maybeCommitted,
      });

      if (status === 401 || status === 403) throw error; // 不重试
      if (blocked) throw error; // 重试无意义
      if (rateLimited && attempt + 1 < MAX_ATTEMPTS) {
        lastError = error;
        await sleep(retryAfter != null ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (transient5xx && idempotent && attempt + 1 < MAX_ATTEMPTS) {
        lastError = error;
        await sleep(retryAfter != null ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      // 写请求 5xx：可能已提交（官方 guidance），绝不自动重放
      throw error;
    }

    throw lastError ?? new NotionError("Notion 请求重试次数已用尽，请稍后再试。");
  }
}

function backoff(attempt: number): number {
  const base = Math.min(2 ** attempt, 30) * 1000;
  return base + Math.random() * 250;
}

async function safeText(response: FetchLikeResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function readRetryAfter(response: FetchLikeResponse, data?: Record<string, unknown>): number | undefined {
  const header = response.headers?.get?.("Retry-After") ?? response.headers?.get?.("retry-after");
  const raw = header ?? readAdditionalString(data, "retry_after");
  if (raw == null) return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readAdditionalString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const additional = data?.additional_data as Record<string, unknown> | undefined;
  const v = additional?.[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

function readRateLimitReason(data: Record<string, unknown> | undefined): string | undefined {
  const additional = data?.additional_data as Record<string, unknown> | undefined;
  const v = additional?.rate_limit_reason;
  return typeof v === "string" ? v : undefined;
}

function hasCommitGuidance(data: Record<string, unknown> | undefined): boolean {
  const additional = data?.additional_data as Record<string, unknown> | undefined;
  return Boolean(additional?.committed_resource_id || additional?.retry_guidance);
}

function userMessage(status: number, code: string | undefined, message: string): string {
  const prefix = `Notion API ${status}${code ? ` (${code})` : ""}`;
  if (status === 401) return `${prefix}：Token 无效或已过期，请检查 Integration Token。`;
  if (status === 403) {
    return `${prefix}：Integration 缺少相应能力或未获授权。请在 Notion 的目标数据库/页面「Connections」中添加该 Integration，并确认已开启 Read / Update / Insert content 能力。${message ? ` 详情：${message}` : ""}`;
  }
  if (status === 404) return `${prefix}：目标不存在或 Integration 未获授权访问该数据库/页面。`;
  if (status === 429) return `${prefix}：请求被限流，已按 Retry-After 等待后重试。${message}`;
  if (status === 529) return `${prefix}：Notion 服务过载，已尝试退避重试。${message}`;
  if (status === 503) return `${prefix}：服务暂时不可用；若为写请求，变更可能已保存，请重新预览确认，插件不会自动重放写入。${message}`;
  return `${prefix}：${message}`;
}
