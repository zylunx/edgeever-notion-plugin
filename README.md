<div align="center">

# 🔁 EdgeEver ↔ Notion Sync

**在 EdgeEver 与 Notion 之间双向同步文本笔记** · 一键生成数据库 · 只读预览 · 双基线冲突保护

[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://github.com/zylunx/edgeever-notion-plugin/releases)
[![Release](https://img.shields.io/github/v/release/zylunx/edgeever-notion-plugin?color=brightgreen)](https://github.com/zylunx/edgeever-notion-plugin/releases)
[![Notion API](https://img.shields.io/badge/Notion%20API-2026--03--11-191919?logo=notion&logoColor=white)](https://developers.notion.com/reference/versioning)
[![Platform](https://img.shields.io/badge/platform-web%20%7C%20desktop-2ea44f)](#)
[![Bundle](https://img.shields.io/badge/bundle-~100%20KB%20%2F%20single%20file-informational)](#)
[![Mock tests](https://img.shields.io/badge/mock%20tests-32%2F32-brightgreen)](#开发)

</div>

> [!NOTE]
> 所有 Notion 请求与响应字段均按官方 **API 版本 `2026-03-11`** 逐项核对，EdgeEver 侧按[官方插件开发文档](https://github.com/tianma-if/edgeever/blob/main/docs/plugin-development.zh-CN.md)实现，**未凭记忆猜测任何 endpoint、请求体或字段名**。

---

## 目录

- [✨ 特性](#-特性)
- [📦 安装](#-安装)
- [🚀 快速开始](#-快速开始)
- [⚙️ 配置项](#️-配置项)
- [🧭 同步与冲突策略](#-同步与冲突策略)
- [🔐 Token 与安全](#-token-与安全)
- [🧩 已核对的 API 契约](#-已核对的-api-契约)
- [🛠 开发](#-开发)
- [🚧 已知限制与后续计划](#-已知限制与后续计划)

---

## ✨ 特性

| | |
| :--- | :--- |
| 🗄 **一键建库** | 填一个父页面 ID，点一次按钮即可创建 database + Data Source + 表格视图与全部 8 个属性，**无需手动建表、手写属性或复制任何 ID** |
| 👁 **只读预览** | 首次同步不会自动开始；生成同步计划后必须由用户勾选确认才写入 |
| 🧬 **双基线冲突检测** | 分别记录两端上次成功同步的 Hash，避免 Notion 重渲染 Markdown 造成假冲突；**默认不覆盖任一端** |
| 🔑 **稳定映射** | 以 `EdgeEver ID` 属性建立映射，绝不以标题匹配，重复同步不会重复创建页面 |
| 🛡 **内容完整性保护** | 读取 Markdown 时检查 `truncated` / `unknown_block_ids` / `warnings`，不完整就跳过，绝不回写 |
| 🗑 **软删除** | 只标记映射 / 提示归档，**不自动永久删除任一端数据** |
| 📎 **可选附件上传** | 单段上传 + 指纹去重 + 失败重试；默认关闭，正文保留可追溯占位 |
| 🚦 **限流与退避** | 串行队列（最小间隔 340 ms）、429/529 按 `Retry-After` 退避、写请求 5xx 不自动重放 |
| 🔒 **Token 不落地** | 仅存加密凭据区，不进 storage、日志、通知或同步报告，展示前脱敏 |

---

## 📦 安装

> [!IMPORTANT]
> 插件 ID 为 `com.zylunx.edgeever-notion`，`apiVersion: "2"`，仅支持 **Web / Desktop**（Android、iOS 原生端不运行插件）。

### 方式一：EdgeEver 插件市场（推荐）

在 EdgeEver「插件市场」中直接输入仓库地址安装：

```text
https://github.com/zylunx/edgeever-notion-plugin
```

宿主会读取最新 Release 的资产完成安装与更新。

### 方式二：手动安装 Release 资产

从 [Releases](https://github.com/zylunx/edgeever-notion-plugin/releases) 下载以下三个文件并保持同一目录：

| 文件 | 说明 |
| :--- | :--- |
| `manifest.json` | 插件清单（根目录） |
| `main.js` | esbuild 打包的单文件脚本（约 100 KB，上限 5 MB） |
| `styles.css` | 同步面板样式（可选） |

> [!TIP]
> 分发规范要求 Release Tag 匹配 Manifest 版本（`0.1.0` 或 `v0.1.0`）。本仓库首个 Release 为 **`v0.1.0`**。

---

## 🚀 快速开始

1. **创建 Integration** — 在 Notion 创建 Internal Integration，开启 `Read content` / `Update content` / `Insert content` 三项能力。
2. **建一个空页面** — 不需要手动建数据库，也不需要手写属性。在该页面 `··· → Connections` 中把 Integration 加为连接。
3. **填写插件设置**（只需两项）
   - `Notion Integration Token` — `secret` 类型，本地加密保存、不明文回显
   - `Notion 父页面 ID` — 第 2 步页面的 ID，可直接粘贴完整页面链接
4. **点击「一键生成同步数据库」** — 插件调用 `POST /v1/databases` 一次性创建 database + Data Source + 首个表格视图及全部属性，默认库名 `EdgeEver Sync`，位于该父页面下。**Data Source ID 自动保存进插件存储，无需手动复制。**
5. **开始同步** — 选择笔记本 → `测试连接` → `生成预览` → 查看同步计划 → 勾选确认 → `执行同步`。

<details>
<summary><strong>自动创建的 8 个属性</strong>（名称均可在插件设置中修改）</summary>

| 属性名 | 类型 | 用途 |
| :--- | :--- | :--- |
| `Name` | Title | 笔记标题 |
| `EdgeEver ID` | Rich text | **唯一映射键**，避免重复创建 |
| `EdgeEver Notebook ID` | Rich text | 来源笔记本 |
| `Tags` | Multi-select | 标签 |
| `Content Hash` | Rich text | 规范化正文 Hash |
| `Last Synced` | Date | 最近同步时间 |
| `Sync Status` | Select | 同步状态 |
| `EdgeEver Updated At` | Date | EdgeEver 侧更新时间 |

</details>

> [!WARNING]
> **仍需用户手动完成的只有授权**：创建 Integration、建空页面、在该页面的 Connections 中添加 Integration。API 无法代授权 —— 父页面未共享时建库返回 `404`，缺少 Insert content 能力返回 `403`，面板会给出对应的操作提示。

### 一键建库的行为边界

- 官方 OpenAPI 的 `parent` 也列了 `workspace` 选项，但正文仍要求 "parent must be a Notion page or a wiki database"，因此插件只实现 `{"type":"page_id","page_id":...}`，不尝试工作区根建库。
- **重复点击不会重复建库**：已有生成记录时只读取 schema 并补齐缺失属性（`PATCH` 只补缺失列、不改已有列）；属性类型不匹配只警告、不自动改类型；已生成的库无法访问时报错而不自动新建。
- 已有数据库仍可在设置里直接填 `Notion Data Source ID` 或 `Notion 数据库 ID`（填库 ID 会自动 `GET /v1/databases/{id}` 解析 `data_sources[0].id`）。**手写配置始终优先**，此时按钮只检查并补齐该库缺失属性，不新建、不覆盖手写配置。
- 生成的 Data Source ID 与映射表存于 `context.storage`，按插件 ID 隔离；**更换插件 ID 后记录不继承**，需重新生成或手动填写。
- 已有生成记录后，即使修改父页面 ID，点击按钮也只复用原数据库（不迁移、不另建）。需要换库请先清空插件数据，或直接手写新的 Data Source ID。

---

## ⚙️ 配置项

在 EdgeEver 插件设置中由宿主统一渲染，完整字段见 [`manifest.json`](./manifest.json)。常用项：

| Key | 默认值 | 说明 |
| :--- | :--- | :--- |
| `notion-token` | — | Integration Token（`secret`，必填） |
| `notion-parent-page-id` | — | 一键建库的父页面 ID / 完整链接 |
| `notion-data-source-id` | — | 可选；一键生成后由插件自动写入内部存储 |
| `notion-database-id` | — | 可选；连接已有数据库时填写 |
| `api-base-url` | `https://api.notion.com` | 自建反向代理时填写 |
| `notion-version` | `2026-03-11` | Notion API 版本 |
| `markdown-version` | `v2` | Notion-flavored Markdown（`v1` 已弃用） |
| `sync-direction` | `bidirectional` | 双向 / 仅推送 / 仅拉取 |
| `auto-sync` | `false` | 事件防抖自动同步，仅在首次手动同步后对已有映射生效 |
| `upload-attachments` | `false` | 上传图片与普通附件 |
| `max-attachment-mb` | `5` | 单个附件大小上限 |
| `prop-*` | 见清单 | 8 个 Notion 属性名，可自由改名 |

---

## 🧭 同步与冲突策略

- **稳定映射**：以 `EdgeEver ID` 建立映射，存于 `context.storage`（按插件与工作区隔离），绝不以标题匹配。
- **规范化 Hash**：统一换行 / 行尾空白 / 列表符号、剥离插件维护的附件区，不混入同步时间、Page ID 等元数据。
- **双基线三方比较**：分别保存上次成功同步时 EdgeEver 侧与 Notion 侧的 Hash，判定为「无变化 / 仅推送 / 仅拉取 / 两端一致更新基线 / 冲突」，规避 Notion 重渲染 Markdown 造成的假冲突。
- **冲突默认不覆盖任一端**：面板展示两端与基线差异，提供「保留 EdgeEver」「保留 Notion」「稍后处理」。
- **写入前二次校验**：预览之后远端又被改动则跳过，不覆盖。
- **写入后回读校准基线**：回读出现截断或警告时写入同步报告，提示用户核对。
- **软删除**：`note.deleted` 只把映射标记为 `deleted`；Notion 页面归档 / 回收站只提示；提供「恢复同步」。不设置 `allow_deleting_content: true`。
- **特殊笔记跳过**：`mind-map` / `flowchart` / `table` / `poster` / `infographic` / `video` 等一律跳过并提示，不会用普通 Markdown 覆盖。
- **限流**：串行队列（最小间隔 340 ms），429/529 按 `Retry-After` 重试、指数退避 + 抖动、最多 5 次；401/403 不重试并给出可读提示。

---

## 🔐 Token 与安全

- Token 只从 `context.secrets` 或 manifest 中 `type: "secret"` 的设置字段读取；**不写入 `context.storage`、普通设置、日志、通知或同步报告**。
- 所有对外展示的错误文本都经过脱敏；`Authorization` 头只在请求中构造，不落盘。
- `permissions` 按实际使用最小化声明，未声明 `notes:delete`、`resources:write`、`schedules` 等未使用权限。
- **自建代理**：`api-base-url` 默认 `https://api.notion.com`。EdgeEver 文档明确标准请求受宿主环境 CORS 策略约束；若 Web 端直连被拦截，可显式填写自建反向代理地址。注意此时 **Token 会发往该代理**，请自行确认部署架构与信任边界后再启用。设置项本身不默认指向任何第三方。

> [!CAUTION]
> 客户端插件采用受信任代码模型：启用即代表信任其在客户端 JavaScript 环境中运行。清单中的 `permissions` 用于向用户披露能力范围，不构成强制安全沙箱。

---

## 🧩 已核对的 API 契约

<details>
<summary><strong>展开：Notion API `2026-03-11` 完整契约表</strong>（核对于 2026-11-13）</summary>

| 用途 | Endpoint / 请求体 | 依据 |
| :--- | :--- | :--- |
| 版本头 | `Notion-Version: 2026-03-11` | Versioning 页明确 latest |
| 验证 Token | `GET /v1/users/me`（仅证明 Token 有效） | 官方参考 |
| 验证授权 | `POST /v1/data_sources/{id}/query` `{"page_size":1,"result_type":"page"}` | 数据库未共享返回 404 |
| 数据库 → Data Source | `GET /v1/databases/{id}` → `data_sources[].id` | 新版 Retrieve a database |
| 一键建库 | `POST /v1/databases`，`parent:{"type":"page_id","page_id":"..."}` + `title` + `initial_data_source.properties`；响应 `data_sources[].id` | Create a database（一次调用创建 database + data source + 首个 table view）；需 Insert content |
| 读取 schema | `GET /v1/data_sources/{id}` → `properties[name].type` | Retrieve a data source |
| 补齐属性 | `PATCH /v1/data_sources/{id}` `{"properties":{"<缺失名>":{...}}}`；省略的已有属性保持不变 | Update data source properties；需 Update content |
| 分页查询 | `POST /v1/data_sources/{id}/query`，`start_cursor` 原样回传，检查 `has_more` 与 `request_status.type === "incomplete"` | Query a data source；10,000 条上限警告 |
| 创建页面 | `POST /v1/pages`，`parent: {"data_source_id": ...}`，可直接带 `markdown` + `markdown_version: "v2"` | Create a page |
| 更新属性 | `PATCH /v1/pages/{id}`，`properties` 用 `title` / `rich_text` / `multi_select` / `select` / `date` | Update page |
| 读取正文 | `GET /v1/pages/{id}/markdown?markdown_version=v2`，必须检查 `truncated` / `unknown_block_ids` / `warnings` | Retrieve a page as markdown |
| 替换正文 | `PATCH /v1/pages/{id}/markdown`，`{"type":"replace_content","replace_content":{"new_str":"...","allow_deleting_content":false},"markdown_version":"v2"}` | Update a page's content as markdown（**不是** `{"markdown":"..."}`） |
| 文件上传 | `POST /v1/file_uploads` → `POST /v1/file_uploads/{id}/send`（multipart，字段 `file`）→ `PATCH /v1/blocks/{page_id}/children` 挂载 `{"type":"file_upload","file_upload":{"id":"..."}}` | Create / Send file upload；single_part **不需要** Complete 步骤 |
| 限流 | 429 / 529 读 `Retry-After`（或 `additional_data.retry_after`）等待后重试；写请求 5xx 不自动重放 | Request limits |
| Markdown 语法 | `markdown_version: "v2"` = Notion-flavored Markdown（CommonMark + GFM + Notion XML 标签） | Notion-flavored Markdown format |

EdgeEver 侧按官方插件开发文档实现：`activate(context)` 默认导出并返回清理函数、`settingsUi: "host"` + `settings.fields` Schema、`context.settings / secrets / storage / network / notes / notebooks / resources / events / commands / ui.panels`。

</details>

---

## 🛠 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → 单文件 main.js
npm test            # build + 32 项 Mock 冒烟测试
npm run check       # typecheck + test
```

`test/mock.mjs` 提供 Mock 宿主与 Mock Notion API；`test/smoke.mjs` 覆盖连接测试、401/429、预览只读、首次确认、重复同步不重复创建、双向更新、冲突不覆盖、人工解决、分页、截断保护、软删除、附件去重、**一键建库（链接解析、全属性 schema、自动保存 ID、幂等补属性、403/404 指引、手写目标优先、旧库失效不重建）**、Token 不泄露、bundle 大小等验收项。当前 **32/32 通过**。

### 项目结构

```text
├── manifest.json          # 插件清单 + 设置 Schema
├── main.js                # 打包产物（提交入库，供 Release 分发）
├── styles.css             # 面板样式
├── src/
│   ├── config/            # 设置读取与校验
│   ├── notion/            # 客户端、数据源、页面、Markdown、块、文件、一键建库
│   ├── converters/        # 正文规范化与占位符
│   ├── sync/              # Hash、队列、映射、冲突、附件、引擎、建库记录
│   ├── ui/                # 同步面板
│   ├── edgeever/          # 宿主笔记适配
│   ├── types.ts / util.ts
│   └── main.ts            # 插件入口
└── test/                  # Mock 宿主 + 冒烟测试
```

### 发布新版本

仓库内置 [`.github/workflows/release.yml`](./.github/workflows/release.yml)：推送 `main` 或 `v*` Tag 时自动创建 / 刷新 Release，并上传 `manifest.json`、`main.js`、`styles.css` 三个资产（使用仓库内置 `GITHUB_TOKEN`，无需额外凭据）。

1. 同步更新 `manifest.json` 的 `version`；
2. `npm run check` 全绿后提交 `main.js`；
3. 推送 Tag（需匹配 Manifest 版本）：`git tag -a v0.1.0 -m "..." && git push origin v0.1.0`，Release 随即自动生成；也可在 Actions 页手动 `Run workflow`。

---

## 🚧 已知限制与后续计划

**刻意不做，不猜测实现：**

- 完整 Block → Markdown 转换器：Markdown 内容不完整时走 Block 结构**报告**路径并跳过，不把不完整正文写回任一端。
- 多段上传（> 20 MiB）、视频与大文件：只保留占位并记录原因；免费工作区还有 5 MiB 上限。
- Notion Webhook 接收（纯客户端插件无法直接接回调）、桌面端 `context.schedules` 定时任务、Notion 侧自动轮询。
- 双向自动删除 / 归档落地：首版一律不自动永久删除。
- 特殊笔记（思维导图、流程图、表格、海报、信息图）的结构化同步。
- Android / iOS 原生端支持。
- 工作区根建库（`parent: {"type":"workspace"}`）：官方正文仍要求父页面，插件只实现 `page_id`。
- 代替用户在 Notion 里把 Integration 加到页面 Connections：授权必须由用户在工作区完成，API 无此能力。

附件上传**默认关闭**：正文中会把 EdgeEver 本地资源引用改写为 `EE-ATTACH:<资源ID>|<文件名>` 可追溯占位并报告；开启后才上传到 Notion，并在页面末尾追加由 `EE-ATTACHMENTS-START/END` 包裹、由插件维护的附件区（该区不参与正文 Hash）。

> [!IMPORTANT]
> 本仓库**只做了 Mock 联调，未接入真实 Notion 工作区**。首次使用建议在一个测试页面上执行「一键生成」，确认库与属性符合预期后再用于正式笔记。

> [!NOTE]
> Notion API 会持续演进。升级 `notion-version` 前请重新核对官方文档的 Data Source 查询、Markdown 更新与文件上传接口；`2026-03-11` 中 `markdown_version: v1` 已弃用，升级到下一个 Notion-Version 前需确认 v2 行为。

---

<div align="center">

Made for [EdgeEver](https://github.com/tianma-if/edgeever) · Notion API `2026-03-11`

</div>
