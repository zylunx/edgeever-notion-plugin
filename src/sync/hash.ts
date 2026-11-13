/**
 * 内容规范化与指纹。
 *
 * 规范 §9.3 要求 Hash 基于规范化内容，且不混入同步时间、Page ID 等元数据。
 * 这里同时提供双基线：写入后会把「Notion 回读到的内容」也存为基线，
 * 因为 Notion 的 Markdown 渲染可能与 EdgeEver 原文有排版差异，单一基线会产生假冲突。
 */

/** 统一换行、行尾空白、列表符号与空行；跳过代码块内部，避免破坏代码文本。 */
export function normalizeMarkdown(input: string): string {
  let s = input ?? "";
  s = s.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");

  const lines = s.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  const normalized: string[] = [];

  for (const raw of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (!inFence) {
        inFence = true;
        fenceChar = marker[0];
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        inFence = false;
      }
      normalized.push(raw.replace(/[ \t]+$/, ""));
      continue;
    }
    if (inFence) {
      normalized.push(raw.replace(/[ \t]+$/, ""));
      continue;
    }
    let line = raw.replace(/[ \t]+$/, "");
    line = line.replace(/^(\s*)[*+](\s+)/, "$1-$2"); // 统一无序列表符号
    line = line.replace(/^(\s*)\d+\)(\s+)/, "$11.$2"); // 1) → 1.
    normalized.push(line);
  }

  return normalized.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "").trim();
}

/** 标题/标签不计入正文 Hash；这里只做展示与比较用的轻量规范化。 */
export function normalizeTitle(input: string): string {
  return asPlain(input).replace(/\s+/g, " ").trim();
}

function asPlain(input: unknown): string {
  return typeof input === "string" ? input : input == null ? "" : String(input);
}

function fnv1a64(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * prime) & mask;
  }
  return `fnv1a64-${h.toString(16).padStart(16, "0")}-${bytes.length.toString(16)}`;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 优先使用 WebCrypto SHA-256；不可用时退化为 FNV-1a 64（仍可作为内容指纹）。 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle?.digest) {
    try {
      return toHex(await subtle.digest("SHA-256", bytes as BufferSource));
    } catch {
      /* 退回同步实现 */
    }
  }
  return fnv1a64(bytes);
}

export async function sha256Bytes(data: Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const subtle = globalThis.crypto?.subtle;
  if (subtle?.digest) {
    try {
      return toHex(await subtle.digest("SHA-256", bytes as BufferSource));
    } catch {
      /* 退回同步实现 */
    }
  }
  return fnv1a64(bytes);
}

/** 规范化正文并计算 Hash。 */
export async function contentHash(markdown: string): Promise<string> {
  return sha256Hex(normalizeMarkdown(markdown));
}
