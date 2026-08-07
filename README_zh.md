# pi-local-rag（jimewu fork）

[English](README.md) · [繁體中文](README_zh.md)

> **Agent 輔助開發的 fork** — 本 fork 由 AI coding agent（pi）在主理者指示下輔助開發完成。

針對 [Pi coding agent](https://github.com/badlogic/pi-mono) 的本地混合 RAG 管線，**定位為案件文件知識庫**（例如法規合規送審案件的資料夾）。**只索引 markdown**；所有非 markdown 文件（docx/pdf/xlsx/csv…）先透過 `convert-documents-to-markdown` skill 轉成 markdown，再由具備 checksum 驗證的同步掃描器確認狀態。零雲端依賴，完全離線運作。

> Fork 自 [vahidkowsari/pi-local-rag](https://github.com/vahidkowsari/pi-local-rag)。
> 上游未完成的 refactor（壞掉的 `openDb` import）已在此修復；embedding 管線已重寫以支援大型多語言模型。

## 功能

- **混合 BM25 + 向量檢索** — SQLite FTS5（`tokenize=trigram`，中文關鍵字檢索因此可用；預設的 `unicode61` 會把連續中文字視為單一 token，導致中文搜尋失效）+ [`sqlite-vec`](https://github.com/asg017/sqlite-vec) 餘弦相似度，檢索時加權混合
- **可設定的多語言 embedding** — 預設 `Xenova/bge-m3`（1024 維、中英文表現佳）；可透過環境變數更換
- **可選 cross-encoder reranker** — 預設 `Xenova/bge-reranker-base`；以 (query, section) 相關性重排混合檢索候選；`RAG_RERANKER=false` 可關閉
- **Markdown 的 parent-child chunking** — parent = 一個 heading 章節（≤200 行），child = 段落/列表/表格/程式碼區塊；命中 child 時召回**整個章節**，避免斷章取義
- **只索引 markdown** — extension 不直接處理 docx/pdf/xlsx/csv；改為回報轉檔狀態（見下方 md-sync）
- **md-sync 掃描器** — `A/B.docx` → `A/B/B.md` + `A/B/B.docx.sha256`；相容舊版 `<stem>_ocr/<stem>.md` 配置；標記 `no_markdown` / `checksum_changed` / `checksum_missing`，並以 realpath 收斂 symlink 重複
- **專案級儲存** — 從 cwd 向上尋找 `.pi/rag/`；退回 `~/.pi/rag/` 全域儲存
- **自動重新整理** — 索引超過 24 小時會在下次 agent turn 前靜默重新整理；`/rag refresh` 可手動增量更新
- **自動注入** — 每次 agent turn 前將相關的 **parent 章節**附加在使用者提示後（對 KV-cache 友善）
- **4 個 AI 工具** — `rag_index`、`rag_query`、`rag_status`、`rag_md_sync`

## 安裝

```bash
# 臨時、單次 session 載入（建議——不會寫入你的全域設定）
pi -e /path/to/pi-local-rag

# 或永久安裝
pi install /path/to/pi-local-rag
```

注意：pi 0.83 無法直接載入 `.tgz` 或 `git:` 套件 URL；請使用目錄路徑（本 repo 已安裝 `node_modules`）。

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `RAG_EMBEDDING_MODEL` | `Xenova/bge-m3` | Embedding 模型（任何 Transformers.js 相容模型） |
| `RAG_EMBEDDING_DIM` | `1024` | sqlite-vec 的向量維度；須與模型一致 |
| `RAG_EMBED_MAX_LENGTH` | `512` | 限制 tokenizer 序列長度（bge-m3 的 8192 上限 × batch 會 OOM；段落很短） |
| `RAG_EMBED_BATCH_SIZE` | `32` | ONNX batch 大小；記憶體受限機器建議降到 8 |
| `RAG_RERANKER` | `true` | 設 `false` 關閉 rerank |
| `RAG_RERANKER_MODEL` | `Xenova/bge-reranker-base` | Cross-encoder reranker |
| `RAG_RERANK_TOP_K` | `20` | 送入 reranker 的混合檢索候選數 |
| `PI_RAG_DIR` | — | 明確指定儲存位置（優先於 walk-up） |

模型首次使用時從 HuggingFace 下載一次並快取於本機。

## 工作流：轉檔 → 同步 → 索引

```bash
cd <案件repo>
pi -e /path/to/pi-local-rag

/rag exclude regulations/            # 法規來源排除（改用法規 skill）
/rag coverage                        # 知識庫是否完整？（一眼判斷）
/rag coverage --auto                 # 或自動補齊：索引、checksum、轉檔
#   → N 個需要轉檔 / M 個缺 checksum / … 已是最新
#   → agent 用 convert-documents-to-markdown skill 轉檔（anydoc / batch-ocr）：
#       A/B.docx → A/B/B.md，然後寫入 A/B/B.docx.sha256
/rag mdsync                          # 再次檢查：現在應為 up to date
/rag index .                         # 索引 markdown（chunk → embed → store）
/rag search 產品規格 演算法           # 混合檢索，回傳整個章節
```

## CLI（`bin/rag`）

本套件的命令列工具——**不必開啟 pi session** 也**不必安裝本 extension**（執行檔就在本 repo 內），
就能檢查、補完知識庫：

```bash
cd /path/to/case-repo
/path/to/pi-local-rag/bin/rag status    # 索引統計 + 設定
/path/to/pi-local-rag/bin/rag coverage  # 完整性報告
/path/to/pi-local-rag/bin/rag auto      # 自動補齊：補 checksum → 轉檔 → 索引
/path/to/pi-local-rag/bin/rag mdsync    # 文件轉檔狀態
/path/to/pi-local-rag/bin/rag help
```

- 在 case repo 目錄下執行（RAG store 會向上尋找 `.pi/rag`），或明確指定 `--dir <path>`。
- `--json` — 機器可讀輸出，方便腳本化。
- 進行中的進度（轉檔 / 索引 / embedding）即時顯示於 stderr，隨時掌握狀況；
  長時間的自動補齊結束後會印出摘要，並提示「可以啟動 pi 開始對話」。
- 需要 **Node ≥ 23.6**（原生 TypeScript type stripping）。

若你之後 `pi install` 本套件，同一 CLI 也會連結為 `rag`。

進 session 前的範例流程：

```bash
cd /path/to/case-repo
RAG=/path/to/pi-local-rag/bin/rag
$RAG coverage        # 看看缺什麼
$RAG auto            # 補齊（可能需數分鐘；進度即時顯示）
pi                    # 然後啟動 session 開始對話
```

## 指令

| 指令 | 說明 |
|---|---|
| `/rag index <path>` | 索引路徑下的 markdown |
| `/rag mdsync [path]` | 掃描非 md 文件的 markdown 轉檔狀態（checksum 檢查） |
| `/rag coverage [path]` | 完整性報告：已索引 md vs 磁碟、文件轉檔狀態、索引健康 |
| `/rag coverage --auto` | 依優先序自動補齊：補 checksum、轉檔（anydoc；OCR 需 `RAG_OCR_CLI`）、重新索引 |
| `/rag search <query>` | 混合 BM25 + 向量檢索（回傳召回的 parent 章節） |
| `/rag find <glob>` | 列出符合 glob 的已索引檔案 |
| `/rag status` | 索引統計、embedding 模型、reranker 狀態、設定、儲存位置 |
| `/rag rebuild [--force]` | 重新走訪 tracked paths 並全部重 embed |
| `/rag refresh` | 增量重新整理（24 小時自動執行同路徑） |
| `/rag clear` | 清空索引（保留 tracked paths） |
| `/rag exclude <pattern>` | 加入 gitignore 風格的排除規則 |
| `/rag ext list \| add <.ext> \| remove <.ext> \| reset` | 管理可索引副檔名白名單（預設為 markdown） |
| `/rag on` \| `off` | 開關自動注入 |
| `/rag help` | 顯示所有子指令 |

## AI 工具

- **`rag_index`** — 將路徑加入索引（僅 markdown）
- **`rag_query`** — 混合檢索；命中 child 時回傳 **parent 章節**（整個 heading 區段），含檔案路徑、行號、分數
- **`rag_status`** — 索引統計、embedding 模型、reranker、設定、儲存位置
- **`rag_md_sync`** — 哪些非 md 文件需要轉檔 / 過期 / 已最新的 JSON 報告
- **`rag_coverage`** — 一次呼叫的完整性報告（md vs 索引、文件轉檔狀態、索引新鮮度），附 verdict

## 運作原理

1. **索引（僅 markdown）** — `chunkForFile` 依檔案類型選擇 chunker：markdown 走 parent-child（parent = heading 章節、child = 語意區塊），其他格式退回純行數 chunk（僅可經由 `extraExtensions` 觸及）。child 被 embedding（`bge-m3`、mean pooling、L2 正規化、序列長度受限）並存入 SQLite；parent 完整存放供召回。
2. **檢索** — FTS5 `bm25()`（`trigram` 分詞，CJK 感知）+ `sqlite-vec` 餘弦最近鄰，以 `alpha × BM25 + (1-alpha) × cosine` 混合。命中對象是 child；每個命中召回其 **parent 章節**。啟用 reranker 時，前 `RAG_RERANK_TOP_K` 個候選以 (query, parent) cross-encoder 配對重新計分排序。
3. **md-sync** — 對每個非 md 文件，`scanMarkdownSync` 檢查 `A/B/B.md`（或舊版 `A/B_ocr/B.md`）是否存在，以及記錄的 sha256 sidecar 是否與目前來源相符；回報 `up_to_date` / `needs_convert` / `checksum_missing`。
4. **自動注入** — 每次 agent turn 前以提示詞檢索，將相關 **parent 章節**作為隱藏 `customType: "rag"` 訊息附加（KV-cache 友善）。
5. **自動重新整理** — 索引超過 24 小時時，背景重新走訪 tracked paths 並重新索引變更檔案（每小時至多一次檢查）。

## 儲存

索引資料位於 `rag.db`（SQLite WAL、FTS5 + sqlite-vec）。解析順序：`$PI_RAG_DIR` → 向上尋找 `.pi/rag/` → `~/.pi/rag/`。Schema 帶有版本；舊索引會自動遷移（FTS 表以 trigram 重建、向量表重新調整維度、檔案標記為需重新 embed）。

## 設定

設定位於 `<ragDir>/config.json`：

| 設定 | 預設 | 說明 |
|---|---|---|
| `ragEnabled` | `true` | 每次 turn 前自動注入 context |
| `ragTopK` | `5` | 注入的章節數上限 |
| `ragScoreThreshold` | `0.1` | 包含的最小混合分數 |
| `ragAlpha` | `0.4` | BM25/向量混合權重（0 = 純向量、1 = 純 BM25） |
| `extraExtensions` | `[]` | 除 markdown 外額外可索引的副檔名 |
| `excludeExtensions` | `[]` | 預設要跳過的副檔名 |
| `trackedPaths` | `[]` | `/rag rebuild`/`refresh` 重新走訪的絕對路徑 |
| `excludePatterns` | `[]` | 走訪 tracked paths 時套用的 gitignore 風格規則 |

## 測試

```bash
npm run typecheck
npx vitest run                      # 128 個測試（embedding 套件跑真實 bge-m3）
SKIP_EMBEDDING_TESTS=1 npx vitest run
```

## 已知限制 / 備註

- `@xenova/transformers` 的 feature-extraction **pipeline 會忽略 `max_length`**；因此 embedding 直接驅動 `AutoTokenizer + AutoModel`（mean pooling + L2 正規化）——這也是 bge-m3 記憶體可控的關鍵。
- Rerank 後的結果可能包含同一 parent 章節的多個命中（parent 召回）；parent 去重可作為未來優化。
- `regulations/` 這類法規來源資料夾應排除（`/rag exclude`），改由逐字法規 skill 處理，而非 RAG。
