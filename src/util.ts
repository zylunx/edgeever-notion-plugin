export function errMsg(e: unknown): string {
  if (e == null) return "未知错误";
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** 从任何将展示给用户的文本中移除凭据，避免 Token 出现在提示、报告或日志里。 */
export function redact(text: string, token: string): string {
  if (!text) return "";
  let out = text;
  if (token) {
    out = out.split(token).join("[REDACTED]");
    // Bearer 头/查询串中出现的情况
    out = out.replace(/Bearer\s+[A-Za-z0-9_\-]{8,}/gi, "Bearer [REDACTED]");
  }
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function asString(v: unknown, dflt = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return dflt;
  return String(v);
}

export function asBool(v: unknown, dflt = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1" || v === "yes";
  if (typeof v === "number") return v !== 0;
  return dflt;
}

export function asNumber(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : dflt;
}

export function escapeHtml(v: unknown): string {
  return asString(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function truncate(v: unknown, max = 300): string {
  const s = asString(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
