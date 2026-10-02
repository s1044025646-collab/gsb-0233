# 本地 PNG 近似重复检测后端（TypeScript + Node.js + SQLite）

一个只跑在 Windows 本地、无 Docker / 无 WSL / 无在线服务的后端项目，提供 **HTTP API** 与 **CLI**：

- 管理图片集合（collection）；
- 导入本地 PNG（复制到项目数据目录，源文件只读，绝不删除或改写）；
- 自行实现 **64 位 dHash** 与 **Hamming 距离**；
- 用已导入图片或新上传图片查询近似项，按距离稳定排序，区分 `identical`（字节相同）与 `similar`（感知近似候选）；
- 记录导入历史与每次查询，导出 JSON 报告；
- 内置离线演示图片生成器（确定性合成，不下载任何图片，不含人物识别或图像内容理解）。

> 重要语义：dHash 距离小只表示“感知近似候选”，**不代表内容必然相同**。
> 只有 SHA-256 相同才是字节完全相同。本服务不会自动合并、删除任何图片。

## 环境要求

- Node.js **22.5+**（开发与验证使用 Node.js 25.5.0；使用内置 `node:sqlite`）
- npm
- Windows（PowerShell）。不依赖 Docker、WSL、付费服务或外部在线 API。

## 快速开始

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 运行全部测试（25 个）
npm run demo       # 一键离线演示：生成样例 -> 导入 -> 多阈值查询 -> 导出报告
npm start          # 启动 HTTP 服务（默认让系统选择空闲端口）
```

启动后控制台会输出实际地址，例如：

```json
{
  "service": "png-dhash",
  "url": "http://127.0.0.1:59954",
  "dataDir": "E:\\GSB\\0233\\A\\data"
}
```

指定端口（0 表示自动选空闲端口；未被占用时使用给定端口）：

```powershell
npm run cli -- serve --port 8080
npm run cli -- serve --port 0
```

## 数据位置

默认数据目录为项目内的 `./data`（可用 `--data-dir` 覆盖）：

```
data/
├─ app.sqlite               # SQLite 数据库（图片/哈希/导入/查询记录）
├─ app.sqlite-wal / -shm     # SQLite WAL 文件（运行期）
├─ images/<collectionId>/<sha256>.png   # 导入时复制保留的图片
├─ samples/                  # 自生成的演示 PNG
└─ reports/                  # 导出的查询报告 JSON
```

源图片只在导入时读取并复制到 `data/images/...`，不会被移动、修改或删除。

## dHash 计算规则（固定、确定性）

实现见 `src/image.ts`，没有调用任何现成的感知哈希或距离库（PNG 解码使用成熟的 `pngjs`）。

1. **解码**：只接受 PNG（校验 8 字节签名），RGBA 输出。
2. **灰度**：像素先按 alpha 合成到**黑色背景**，再按 ITU-R BT.601 加权：

   `gray = (0.299*R + 0.587*G + 0.114*B) * (A/255)`

   - 完全透明像素亮度为 **0**（等同黑色）；
   - 半透明像素按比例压暗。
3. **缩放为 9×8**：使用**区域平均（box/area）缩放**。每个目标像素对应源图的一块矩形区域，
   按源像素与矩形的重叠面积加权平均；规则确定、无随机抖动。
4. **比较取值**：每行从左到右比较 8 对相邻像素。**左亮度严格大于右亮度时该位为 1，否则为 0**；
   因此**亮度相等时该位为 0**（不做四舍五入、不做符号随机化）。
5. **位序**：行优先，每行从左到右。第 0 行（最上面）第 0 列（最左一对）是 64 位整数的
   **最高位 bit63**；第 7 行第 7 列是 **bit0**。
6. **存储格式**：64 位哈希用 `bigint` 参与运算，落库与输出为**固定 16 位小写十六进制**，
   **保留前导零**（例如 `0000000000000001`）。

### Hamming 距离

两张图的距离是两个 64 位哈希**异或后值为 1 的比特数量**（用 `x &= x - 1` 计数）。
**绝不是**对十六进制字符串逐字符比较差异。距离范围 0–64。

### 匹配分类与排序

- `identical`：SHA-256 相同（字节完全相同，此时距离必为 0）；
- `similar`：SHA-256 不同但距离不超过阈值的**候选**。注意距离为 0 也可能是不同字节
  （dHash 只有 64 位，存在哈希碰撞），此时仍是 `similar`。
- 排序：`distance ASC`，随后按稳定标识 `image_id ASC`。
- 查询默认 `includeSelf=false`，按 SHA-256 排除查询图自身。
- 查询始终限定在单个集合内，**不同集合不能混查**。

## 限制与假设

- 仅接受 PNG；上传文件名必须以 `.png` 结尾，且内容需通过 PNG 解码。
- 文件大小上限默认 **20 MiB**；图像边长上限默认 **4096 像素**；
  最小尺寸为 **9×8**（dHash 需要 9 列 8 行）。
- 默认阈值 `10`，允许范围 `0–64`；默认 `limit=20`，允许 `1–200`。
- 比对为集合内全表扫描计算距离，面向演示/中小规模；**不做自动聚类或高级向量索引**。
- dHash 对整体缩放、轻微亮度调整较稳健；对裁剪、局部遮挡、强压缩伪影等**不保证**识别，
  本项目不追求覆盖所有变换。
- 重复导入按 **(collection_id, sha256)** 去重：返回既有图片记录，状态为 `duplicate`，
  不重复落盘，并写一条导入记录。相同字节在**不同集合**中各自保存一份。
- 落盘与落库在同一事务中处理；若文件写入或数据库插入失败，事务回滚并清理已写文件，
  不会留下能被查询到的“假记录”。

## HTTP API

所有响应为 JSON；错误形如 `{"error":{"code":"...","message":"..."}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/collections` | 创建集合，body：`{"name":"demo"}` |
| GET | `/api/collections` | 集合列表（含图片计数） |
| GET | `/api/collections/:cid` | 集合详情 |
| POST | `/api/collections/:cid/images` | 导入 PNG（`multipart/form-data`，字段名 `image`） |
| GET | `/api/collections/:cid/images` | 图片列表（含 SHA-256、dHash、尺寸、大小、原文件名） |
| GET | `/api/collections/:cid/images/:id` | 单张图片元数据 |
| POST | `/api/collections/:cid/query?threshold=8&limit=20&includeSelf=false` | 用**新上传** PNG 查询（multipart，字段名 `image`；阈值也可放在表单字段） |
| POST | `/api/collections/:cid/images/:id/query?threshold=8` | 用**已导入**图片查询 |
| GET | `/api/collections/:cid/queries` | 查询历史 |
| GET | `/api/collections/:cid/queries/:qid` | 某次查询及其结果 |
| GET | `/api/collections/:cid/imports` | 导入历史 |

### 错误码

`INVALID_ARGUMENT`、`BAD_REQUEST`、`NOT_FOUND`(404)、`CONFLICT`(409)、
`UNSUPPORTED_MEDIA_TYPE`(415)、`FILE_TOO_LARGE` / `IMAGE_TOO_LARGE_DIMENSIONS`(413)、
`INVALID_PNG`、`IMAGE_TOO_SMALL`、`EMPTY_COLLECTION`、`STORAGE_ERROR`(500)、`INTERNAL`(500)。

### PowerShell + curl 示例

```powershell
$base = 'http://127.0.0.1:8080'
curl.exe -s -X POST "$base/api/collections" -H 'content-type: application/json' -d '{"name":"demo"}'
curl.exe -s -X POST "$base/api/collections/1/images" -F "image=@data/samples/01_original_320x240.png"
curl.exe -s "$base/api/collections/1/images"
curl.exe -s -X POST "$base/api/collections/1/query?threshold=8" -F "image=@data/samples/04_tweaked_320x240.png"
curl.exe -s -X POST "$base/api/collections/1/images/1/query?threshold=16&includeSelf=true"
```

结果示例（threshold=8 查询原图，候选含 8 位差异的微调图）：

```json
{
  "queryId": 7,
  "querySha256": "d44f48425856297dd89856401ab21b465cdaf9b9dcb9ca9955fd46d31cc059d3",
  "queryDhash": "dbdbdbdbdbdbdbdb",
  "threshold": 8,
  "count": 1,
  "results": [
    {
      "image_id": 10,
      "distance": 8,
      "match_type": "similar",
      "original_name": "04_tweaked_320x240.png",
      "sha256": "fb6b3225e9033065c1f960220fd60d80f2f474a357780d2b6a34ffc85cc43fd0",
      "dhash": "d3d3d3d3d3d3d3d3",
      "width": 320, "height": 240, "file_size": 1484,
      "rank": 1
    }
  ]
}
```

## CLI

```powershell
npm run cli -- collection create demo
npm run cli -- collection list
npm run cli -- images import 1 data/samples/01_original_320x240.png data/samples/02_resized_160x120.png
npm run cli -- images list 1
npm run cli -- image 1 1
npm run cli -- query 1 --image 1 --threshold 8
npm run cli -- query 1 --image data/samples/05_tweaked_more_320x240.png --threshold 16 --include-self
npm run cli -- imports 1
npm run cli -- queries 1
npm run cli -- report 1 3 data/reports/query-3.json
npm run cli -- generate-samples
npm run cli -- help
```

## 演示图片与阈值效果

`npm run demo` 与 `npm run generate-samples` 会在 `data/samples/` 生成 8 张确定性 PNG：

| 文件 | 说明 | 相对原图的 dHash 距离（实测） |
| --- | --- | --- |
| `01_original_320x240.png` | 水平条纹原图 | 0（自身） |
| `02_resized_160x120.png` | 缩小 | 0（字节不同，similar） |
| `03_resized_480x360.png` | 放大 | 0（字节不同，similar） |
| `04_tweaked_320x240.png` | 中央窄条反色，轻微改动 | 8 |
| `05_tweaked_more_320x240.png` | 宽条反色，较强改动 | 16 |
| `06_transparent_320x240.png` | 左半完全透明 | 较大 |
| `07_blocks_320x240.png` | 棋盘块，明显不同 | 较大 |
| `08_solid_dark_256x256.png` | 近纯色深灰 | 64（互补哈希） |

演示会在阈值 `0 / 8 / 16 / 24` 下分别查询：

- `threshold=0`：只出现缩放版本（距离 0，但 SHA-256 不同，标记为 `similar`）；
- `threshold=8`：额外出现轻微改动图（距离 8）；
- `threshold=16`：再出现较强改动图（距离 16）；
- `includeSelf=true` 时，查询图自身排第一且标记为 `identical`。

这正是“阈值变化改变候选列表”的直观展示，也说明距离 0 ≠ 字节相同。

## 测试

```powershell
npm test
```

覆盖内容：

- 手工 9×8 亮度矩阵核对**位序**（bit63 / bit0 / 全 1 / 全 0）、**相等亮度为 0**；
- **前导零**固定 16 位十六进制、哈希字符串解析校验；
- 已知 BigInt 的 **Hamming 距离**，并防止退化为字符串字符差异；
- 透明像素按黑底合成（亮度 0）、区域缩放确定性与均匀灰不变性、损坏 PNG 拒绝；
- 零阈值、阈值边界（距离恰等于阈值被包含）、`limit`、排序与 `includeSelf`；
- 重复导入去重、不同集合隔离、空集合查询、透明图导入、损坏 PNG 不落库、过小图片拒绝；
- **重启后查询**（关闭并重开 Store，SQLite 持久化）；
- HTTP API 端到端冒烟（multipart 上传、URL 阈值参数、查询记录、错误码）。

## 目录结构

```
src/
├─ cli.ts        # CLI 入口
├─ server.ts     # HTTP 服务与路由
├─ multipart.ts  # 最小 multipart/form-data 解析
├─ store.ts      # 集合/导入/查询业务逻辑与事务
├─ db.ts         # SQLite 建表
├─ image.ts      # PNG 解码、灰度、区域缩放、dHash、Hamming
├─ samples.ts    # 离线演示图片生成
├─ demo.ts       # 一键演示流程
├─ report.ts     # 查询报告构建与导出
├─ config.ts     # 数据目录/上限/默认值/端口
└─ errors.ts     # 错误码
test/             # node:test 测试
```
