import type { NoteMapping } from "../types";

export type Decision = "skip" | "push" | "pull" | "both-same" | "conflict";

export interface ThreeWayInput {
  /** 当前 EdgeEver 规范化正文 Hash。 */
  edgeeverHash: string;
  /** 当前 Notion 规范化正文 Hash。 */
  notionHash: string;
  /** 上次成功同步的映射；为空表示首次建立映射。 */
  mapping?: NoteMapping;
}

/**
 * 三方比较（规范 §9.3）。
 *
 * 文档用单一基线 B，但 Notion 会把 Markdown 重新渲染（列表符号、空行、图片块等），
 * 导致「写入成功」后 E 与 N 的规范化结果仍可能不同。因此这里保存双基线：
 *   E0 = 上次成功同步时 EdgeEver 侧 Hash，N0 = 上次成功同步时 Notion 侧 Hash。
 * 判定逻辑与文档表格一致：只比较「相对各自基线是否变化」。
 *
 * E=E0, N=N0 → skip； E≠E0, N=N0 → push； E=E0, N≠N0 → pull；
 * 两边都变且 E=N → both-same；两边都变且 E≠N → conflict（默认不覆盖）。
 */
export function decide(input: ThreeWayInput): Decision {
  const { edgeeverHash: e, notionHash: n, mapping } = input;
  const baseline = mapping?.lastSyncedHash;
  const e0 = mapping?.lastEdgeEverHash ?? baseline;
  const n0 = mapping?.lastNotionHash ?? baseline;

  const eChanged = e0 == null ? true : e !== e0;
  const nChanged = n0 == null ? true : n !== n0;

  if (!eChanged && !nChanged) return "skip";
  if (eChanged && !nChanged) return "push";
  if (!eChanged && nChanged) return "pull";
  if (e === n) return "both-same";
  return "conflict";
}

export function decisionLabel(d: Decision): string {
  switch (d) {
    case "skip":
      return "无变化";
    case "push":
      return "仅 EdgeEver 修改 → 推送 Notion";
    case "pull":
      return "仅 Notion 修改 → 拉取 EdgeEver";
    case "both-same":
      return "两端最终内容一致 → 更新基线";
    case "conflict":
      return "两端同时修改 → 需人工处理";
  }
}
