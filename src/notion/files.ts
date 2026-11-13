import type { NotionClient } from "./client";
import type { NotionFileUpload, PluginResource, ResourceMapping } from "../types";
import { NotionError } from "./client";

/** 上传模式为 single_part 时无需 Complete 步骤（Complete 仅用于 multi_part）。 */
export async function uploadSinglePart(
  client: NotionClient,
  resource: PluginResource,
  blob: Blob,
): Promise<NotionFileUpload> {
  const filename = (resource.filename ?? resource.fileName ?? resource.name ?? `resource-${resource.id}`).slice(0, 200);
  const mimeType = resource.mimeType ?? resource.mime ?? blob.type ?? "application/octet-stream";

  const created = await client.request<NotionFileUpload>("POST", "/v1/file_uploads", {
    mode: "single_part",
    filename,
    content_type: mimeType,
  });
  if (!created?.id) throw new NotionError("创建 Notion File Upload 失败：响应缺少 id。");

  const form = new FormData();
  form.append("file", blob, filename);
  const uploaded = await client.requestForm<NotionFileUpload>(
    created.upload_url ?? `https://api.notion.com/v1/file_uploads/${created.id}/send`,
    form,
  );
  if (uploaded?.status && uploaded.status !== "uploaded") {
    throw new NotionError(`文件上传未成功（status=${uploaded.status}），可在同步面板重试。`);
  }
  return { ...created, ...uploaded, id: uploaded?.id ?? created.id };
}

/** file_upload ID 挂载到 image / file Block 的官方格式。 */
export function attachmentBlock(mapping: ResourceMapping): Record<string, unknown> {
  const isImage = /^image\//i.test(mapping.mimeType || "");
  const fileObject = { type: "file_upload", file_upload: { id: mapping.notionFileUploadId } };
  if (isImage) {
    return {
      type: "image",
      image: {
        ...fileObject,
        caption: [{ type: "text", text: { content: mapping.filename } }],
      },
    };
  }
  return { type: "file", file: { ...fileObject, name: mapping.filename } };
}

export function paragraphBlock(text: string): Record<string, unknown> {
  return {
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}
