import type { PluginContext, PluginResource, PluginSettings, ResourceMapping, SyncPlanItem } from "../types";
import type { NotionClient } from "../notion/client";
import { appendChildren } from "../notion/blocks";
import { attachmentBlock, paragraphBlock, uploadSinglePart } from "../notion/files";
import { ATTACH_END, ATTACH_START, parseAttachmentPlaceholders } from "../converters/markdown";
import { readResourceBlob } from "../edgeever/notes";
import { sha256Bytes } from "./hash";
import { loadResourceMappings, saveResourceMappings } from "./mapping";
import { errMsg, redact } from "../util";

export interface AttachmentArgs {
  ctx: PluginContext;
  client: NotionClient;
  settings: PluginSettings;
  item: SyncPlanItem;
  pageId: string;
  resources: PluginResource[];
  maxFileUploadBytes?: number;
}

export interface AttachmentResult {
  attached: number;
  failed: number;
  skipped: number;
  warnings: string[];
}

function guessMime(resource: PluginResource, blob: Blob): string {
  if (resource.mimeType || resource.mime) return (resource.mimeType ?? resource.mime) as string;
  if (blob.type) return blob.type;
  const ext = (resource.filename ?? resource.fileName ?? resource.name ?? "").split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
  };
  return (ext && map[ext]) || "application/octet-stream";
}

/**
 * 附件同步（规范 §8）。
 * - 上传前计算内容指纹，复用已成功上传的 file_upload ID，避免重复上传。
 * - 只处理 single_part（≤ 20 MiB，免费工作区为 5 MiB）；大文件与视频留待后续版本并记录原因。
 * - 正文中始终保留 EE-ATTACH:<id>|<filename> 可追溯占位；Notion 侧附件区由插件用 Block API 维护。
 * - 失败可重试；不删除任一端原始资源；不把 Notion 临时 URL 当作永久 ID 保存。
 */
export async function syncAttachments(args: AttachmentArgs): Promise<AttachmentResult> {
  const { ctx, client, settings, item, pageId, resources, maxFileUploadBytes } = args;
  const result: AttachmentResult = { attached: 0, failed: 0, skipped: 0, warnings: [] };
  const body = item.markdown ?? "";
  const placeholders = parseAttachmentPlaceholders(body);

  if (placeholders.length === 0) return result;

  if (!settings.uploadAttachments) {
    result.skipped = placeholders.length;
    result.warnings.push(
      `「${item.title}」含 ${placeholders.length} 个本地附件：正文已保留可追溯占位，未上传到 Notion（上传开关默认关闭）。`,
    );
    return result;
  }

  const mappings = await loadResourceMappings(ctx);
  const maxBytes = Math.min(
    settings.maxAttachmentMB * 1024 * 1024,
    maxFileUploadBytes ?? Number.POSITIVE_INFINITY,
    20 * 1024 * 1024,
  );

  const blocks: unknown[] = [];
  const touched: string[] = [];

  for (const placeholder of placeholders) {
    const resource = resources.find((r) => r.id === placeholder.id);
    if (!resource) {
      result.failed++;
      result.warnings.push(`附件 ${placeholder.filename}（${placeholder.id}）在 EdgeEver 资源列表中找不到，已保留占位。`);
      continue;
    }

    try {
      const blob = await readResourceBlob(ctx, resource);
      const size = Math.max(
        Number(resource.size ?? 0),
        Number(blob.size ?? 0),
      );
      if (size > maxBytes) {
        result.failed++;
        mappings[resource.id] = {
          edgeeverResourceId: resource.id,
          sha256: "",
          filename: placeholder.filename,
          mimeType: guessMime(resource, blob),
          status: "failed",
          error: `超过大小上限 ${(maxBytes / 1024 / 1024).toFixed(1)} MiB`,
        };
        result.warnings.push(`附件 ${placeholder.filename} 超过大小上限，需分块上传（后续版本支持）。`);
        continue;
      }

      const arrayBuffer = await blob.arrayBuffer();
      const fingerprint = await sha256Bytes(new Uint8Array(arrayBuffer));
      const filename = resource.filename ?? resource.fileName ?? resource.name ?? placeholder.filename;
      const mimeType = guessMime(resource, blob);
      const existing = mappings[resource.id];

      let mapping: ResourceMapping;
      if (existing?.status === "attached" && existing.sha256 === fingerprint && existing.notionFileUploadId) {
        mapping = { ...existing, filename, mimeType };
        result.skipped++;
      } else {
        const upload = await uploadSinglePart(
          client,
          { ...resource, filename, mimeType },
          new Blob([arrayBuffer], { type: mimeType }),
        );
        mapping = {
          edgeeverResourceId: resource.id,
          notionFileUploadId: upload.id,
          sha256: fingerprint,
          filename,
          mimeType,
          status: "uploaded",
        };
      }

      mappings[resource.id] = mapping;
      blocks.push(attachmentBlock(mapping));
      touched.push(resource.id);
    } catch (e) {
      result.failed++;
      mappings[resource.id] = {
        edgeeverResourceId: resource.id,
        sha256: "",
        filename: placeholder.filename,
        mimeType: resource.mimeType ?? resource.mime ?? "application/octet-stream",
        status: "failed",
        error: redact(errMsg(e), settings.token),
      };
      result.warnings.push(`附件 ${placeholder.filename} 上传失败：${redact(errMsg(e), settings.token)}（可在下次同步重试）`);
    }
  }

  if (blocks.length > 0) {
    try {
      const ids = await appendChildren(client, pageId, [
        paragraphBlock(ATTACH_START),
        ...blocks,
        paragraphBlock(ATTACH_END),
      ]);
      attachedIds(mappings, touched, ids, result);
    } catch (e) {
      result.failed += blocks.length;
      result.attached = 0;
      for (const id of touched) {
        if (mappings[id]) mappings[id] = { ...mappings[id], status: "failed", error: redact(errMsg(e), settings.token) };
      }
      result.warnings.push(`附件区挂载失败：${redact(errMsg(e), settings.token)}（文件已上传，可重试）`);
    }
  }

  await saveResourceMappings(ctx, mappings);
  return result;
}

function attachedIds(
  mappings: Record<string, ResourceMapping>,
  touched: string[],
  blockIds: string[],
  result: AttachmentResult,
): void {
  // 首尾各一个 paragraph，中间是与 touched 顺序对应的媒体 block
  const mediaIds = blockIds.slice(1, 1 + touched.length);
  touched.forEach((id, index) => {
    const m = mappings[id];
    if (!m) return;
    mappings[id] = {
      ...m,
      status: "attached",
      notionBlockId: mediaIds[index] ?? m.notionBlockId,
      error: undefined,
    };
    result.attached++;
  });
}
