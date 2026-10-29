# BÁO CÁO TIẾN ĐỘ — Auto Studio AI

> Vai trò: Giám đốc dự án / giám sát tiến độ & báo lỗi
> Thư mục: `D:\10 Obsidian\4 Code` · Cập nhật: 29/10/2026 13:35

## 1. Tình trạng tổng quan

| Hạng mục | Giá trị |
|---|---|
| Stack | Node.js 24 + Express 5 + multer + cors (CommonJS, **không** Electron) |
| Entry point | `src/server.js` (cổng 3456) · `src/cli.js` |
| Core modules | 7 (`src/core/*.js`) |
| Giao diện | SPA 1 file `public/index.html` (5 panel) |
| Tổng dòng mã | ~3.700 dòng |
| Syntax check | ✅ 0 lỗi trên toàn bộ file `.js` |
| **Khả năng chạy** | 🔴 **Hỏng 6/11 endpoint** (xem BUG-001) |

## 2. Ma trận tính năng theo spec

| # | Tính năng (spec) | Module đảm nhiệm | Trạng thái |
|---|---|---|---|
| 1 | Review phim AI 4 bước | `review-script-core.js` (877 d) → `generateReviewScript`, `sanitizeOutline`, `classifyCharacters`, `planParts`, `splitLongCues` | 🟡 Core xong, **chưa có route API/UI** |
| 2 | Dịch phụ đề đa luồng (giữ 100% dòng + mốc) | `translate-core.js` (226 d) → `translateSubtitles` | 🟡 Core xong, **chưa wire** |
| 3 | Tạo Prompt Ảnh/Video hàng loạt | `translate-core.js` → `generateVisualPrompts` | 🟡 Core xong, **chưa wire** |
| 4 | Beam-Search cắt cảnh chống giật | `review-sync.js` (597 d) → `computeTimeline` | 🟢 Đạt spec |
| 5a | Xuất Premiere FCP7 XMEML v4 | `premiere-xml-builder.js` (449 d) → `buildPremiereXml` | 🟢 Đạt spec |
| 5b | Xuất CapCut `draft_content.json` | — | 🔴 **Chưa có file nào** |
| 6 | Quản lý API đa nhà cung cấp | `ai-providers.js` (658 d) | 🟡 Core mới xong, **server gọi API cũ → crash** |

### Chi tiết kỹ thuật đã đạt (beam-search, kiểm chứng bằng code)

- `BEAM_WIDTH = 48` ✔️
- Lọc nháy hình `[60 ms, 600 ms]` ✔️ (`review-sync.js:65-71`)
- Nhảy cảnh `>= 2 s` hoặc chạy tiếp `<= 6 s` ✔️ (`minJumpSec=2.0`, `maxClipSec=6.0`)
- Co giãn tốc độ `0.90x – 1.10x` ✔️ (`low: 0.90, high: 1.10`)

## 3. LỖI NGHIÊM TRỌNG

### BUG-001 — `server.js` gọi API đã bị xoá khỏi `ai-providers.js` 🔴 BLOCKER

`server.js` dòng 19-26 destructure 6 hàm, nhưng bản `ai-providers.js` hiện tại **không còn export** chúng:

| Hàm server cần | `typeof` thực tế |
|---|---|
| `loadProviders` | `undefined` |
| `saveProviders` | `undefined` |
| `loadCodexConfig` | `undefined` |
| `callChatCompletion` | `undefined` |
| `listModels` | `undefined` |
| `testProviderKey` | `undefined` |

**Hệ quả:** server vẫn boot (destructure không ném lỗi) nhưng 6 endpoint sau trả HTTP 500 `TypeError: xxx is not a function`:

- `GET /api/providers`
- `POST /api/providers`
- `POST /api/providers/load-codex`
- `POST /api/providers/list-models`
- `POST /api/providers/test-key`
- `POST /api/chat`

**Bản đồ API cũ → mới:**

| Cũ (server.js dùng) | Mới (ai-providers.js 658 d) |
|---|---|
| `loadProviders()` | `loadAiSettings()` |
| `saveProviders(arr)` | `saveAiSettings(settings)` / `upsertProvider()` / `removeProvider()` |
| `loadCodexConfig()` | `importFromCodexConfig()` |
| `callChatCompletion()` | `aiPostChat()` |
| `listModels()` | `fetchAvailableModels()` |
| `testProviderKey()` | `checkApiKey()` |

### BUG-002 — Cấu hình provider bị phân mảnh

`ai-providers.js` ghi vào `config/ai-settings.json` (đã tồn tại, 79 dòng) nhưng `public/index.html` vẫn POST `/api/providers` theo schema phẳng cũ (`[{id,name,baseUrl,apiKey,model,enabled}]`). Sau khi sửa BUG-001 phải map lại schema, nếu không UI sẽ lưu rỗng.

### BUG-003 — Rủi ro ghi đè đồng thời

Trong 7 phút quan sát, 7 file bị ghi liên tục (mtime 13:28 → 13:34). Có tiến trình thứ hai (nhiều khả năng Claude Code CLI) đang tái cấu trúc `src/core/`. Mọi chỉnh sửa song song có nguy cơ conflict.

## 4. Backlog ưu tiên

| Ưu tiên | Việc | Ước lượng |
|---|---|---|
| P0 | Vá BUG-001: cập nhật `server.js` sang API mới + adapter schema | 1 file, ~120 dòng |
| P0 | Tạo `src/core/capcut-builder.js` → `draft_content.json` | 1 file mới |
| P1 | Thêm route `/api/review-script` (4 bước), `/api/translate`, `/api/visual-prompts` | sửa `server.js` |
| P1 | Thêm 2 panel UI: Dịch phụ đề, Tạo Prompt | `public/index.html` |
| P2 | `README.md`, `.gitignore`, test thật thay `npm test` placeholder | mới |
| P2 | Nút "Kiểm tra Key" gọi `checkApiKey` thay vì `listModels` | UI |

## 5. Cách chạy

```bash
cd "D:\10 Obsidian\4 Code"
npm start          # http://localhost:3456
npm run cli -- --video "..." --srt "..."
```
