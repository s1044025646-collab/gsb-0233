# PNG 近似重复检测后端

一个 Windows 本地可运行的 PNG 图片目录与近似重复查询服务，仅提供 HTTP API 与 CLI（无前端）。
使用 TypeScript + Node.js + SQLite（better-sqlite3），不依赖 Docker、WSL、付费服务或任何在线 API。

## 功能

- 管理图片**集合**（collection），不同集合之间不能混查。
- 导入本地 PNG：把图片**复制**到项目数据目录，记录原文件名与大小；**源文件不会被删除或改写**。
- SHA-256 标识**字节相同**；同一集合内重复导入字节相同的文件会被**去重**（不重复存盘，导入记录标记 `duplicate`）。
- 自实现 **64 位 dHash** 与 **Hamming 距离**，近似结果只作为**候选报告**，不自动合并或删除任何图片。
- 用已导入图片或新上传图片查询近似项，可设置距离阈值（0–64）与数量上限，结果按 `(距离, 图片ID)` 稳定排序。
- 查询记录与报告保存在 SQLite，可导出 JSON / Markdown 报告。
- 文件保存失败不会留下可正常查询的假记录（先写文件、后写库，失败即清理）。

## 环境要求

- Windows + Node.js ≥ 18（开发验证使用 Node 25）
- 首次安装依赖需要网络（`npm install`），运行时完全离线

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 生成演示图片并演示不同阈值下的候选列表
npm start         # 启动 API（默认端口 0 = 自动选择空闲端口）
```

指定端口：`node dist/src/cli.js serve --port 8080`，或设置环境变量 `PORT`。

## dHash 计算规则（固定，不可配置）

1. **解码**：用 pngjs 解码 PNG 为 RGBA。
2. **透明像素**：按 alpha 合成到**不透明白色背景**（全透明像素视为白色）。
3. **灰度**：`Y = round((299*R + 587*G + 114*B) / 1000)`，整数运算。
4. **缩放**：双线性插值缩放到 **9×8**，采样映射 `src = (dst + 0.5) * scale - 0.5`，边缘截断。
5. **比特**：每行比较相邻像素，`左亮度 > 右亮度` 时比特为 1，**相等亮度比特为 0**（严格大于）。
6. **位序**：行优先（row 0..7，col 0..7），第 `i = row*8+col` 位放在 64 位整数的第 `63-i` 位，
   即 hex 字符串从左到右与位序一致；**保存为 16 位小写 hex，保留前导零**。
7. **距离**：两个哈希按位异或后数 1 的个数（Hamming 距离），**不是**对 hex 字符串做字符差异计数。

> 注意：距离小只表示感知上相似，**不代表内容必然相同**；近似结果仅供人工确认。

## 限制

- 仅接受 PNG；单文件 ≤ 20 MB，宽高 ≤ 4096（均可用环境变量调整）。
- dHash 对缩放、轻微亮度变化稳健，但**不保证**识别所有压缩、裁剪、旋转等变换。
- 不做自动聚类、不建向量索引；查询为集合内全量比对，适合中小规模集合。
- 不做人物识别或图像内容理解；演示图片全部由程序生成，不下载在线图片。

## 数据位置

- 数据目录：默认 `./data`（环境变量 `PNGDUP_DATA_DIR` 可改）
  - `data/pngdup.sqlite`：SQLite 数据库（集合、图片与哈希、导入记录、查询记录）
  - `data/images/<集合ID>/<sha256>.png`：导入图片的副本
- 演示图片：`./demo-images/`（由 `npm run demo` 生成）

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `0`（空闲端口） | API 监听端口 |
| `PNGDUP_DATA_DIR` | `./data` | 数据目录 |
| `PNGDUP_MAX_FILE_BYTES` | `20971520` | 单文件大小上限 |
| `PNGDUP_MAX_DIMENSION` | `4096` | 图片宽/高上限 |
| `PNGDUP_DEFAULT_THRESHOLD` | `10` | 默认距离阈值 |
| `PNGDUP_DEFAULT_LIMIT` / `PNGDUP_MAX_LIMIT` | `50` / `500` | 结果数量上限 |

## CLI 用法

```powershell
node dist/src/cli.js create 我的集合
node dist/src/cli.js import 1 .\demo-images\base-96.png .\demo-images\slight-change.png
node dist/src/cli.js list 1
node dist/src/cli.js show 1
node dist/src/cli.js query 1 --image 1 --threshold 10 --limit 20 --export report.md
node dist/src/cli.js query 1 --file .\some-new.png --threshold 8
node dist/src/cli.js queries 1
node dist/src/cli.js report 1 --format md
node dist/src/cli.js imports 1
```

## HTTP API

基础路径 `/api`，错误统一返回 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/collections` | 创建集合，body `{"name":"..."}` |
| GET | `/api/collections` | 列出集合（含图片数） |
| POST | `/api/collections/:id/images` | 导入 PNG（body 为原始字节，`?filename=` 指定原文件名） |
| GET | `/api/collections/:id/images` | 列出集合内图片 |
| GET | `/api/collections/:id/imports` | 导入记录（含去重/失败状态） |
| GET | `/api/images/:id` | 图片元数据（含 sha256、dhash） |
| GET | `/api/images/:id/file` | 取回图片文件 |
| POST | `/api/collections/:id/query` | 用已导入图片查询，body `{"imageId":1,"threshold":10,"limit":50}` |
| POST | `/api/collections/:id/query-upload?threshold=&limit=` | 用新上传 PNG 查询（不写入图片表） |
| GET | `/api/collections/:id/queries` | 查询记录列表 |
| GET | `/api/queries/:id` | 查询详情（含结果） |
| GET | `/api/queries/:id/export?format=json\|md` | 导出报告 |

错误码：`INVALID_ARGUMENT`（400）、`NOT_FOUND`（404）、`INVALID_PNG`（422）、
`FILE_TOO_LARGE` / `DIMENSIONS_TOO_LARGE`（413）、`INTERNAL`（500）。

### curl 示例

```powershell
# 启动服务（假设输出端口 51234）
curl -X POST http://127.0.0.1:51234/api/collections -H "Content-Type: application/json" -d '{"name":"demo"}'
curl -X POST "http://127.0.0.1:51234/api/collections/1/images?filename=a.png" -H "Content-Type: image/png" --data-binary "@demo-images/base-96.png"
curl -X POST http://127.0.0.1:51234/api/collections/1/query -H "Content-Type: application/json" -d '{"imageId":1,"threshold":10}'
curl "http://127.0.0.1:51234/api/queries/1/export?format=md"
```

## 测试

`npm test` 覆盖：手工亮度矩阵核对位序与前导零、已知 Hamming 距离、相等亮度规则、
透明像素白底合成、固定样例缩放验证、零阈值与阈值边界、重复导入去重、损坏 PNG、
空集合查询、跨集合隔离、排序与 limit、报告导出、重启后（重开数据库）查询。

## 项目结构

```
src/
  dhash.ts        # 64 位 dHash 与 Hamming 距离（自实现）
  pngutil.ts      # PNG 解码、白底合成灰度化、双线性缩放
  db.ts           # SQLite 表结构
  store.ts        # 业务逻辑：集合/导入/查询/报告
  server.ts       # Express HTTP API
  cli.ts          # 命令行入口
  demo-images.ts  # 程序生成的演示图片
test/             # node:test 测试
```
