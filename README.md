# 🎬 Auto Studio AI — Review Phim Beam-Search & Dual Export (Premiere Pro XML / CapCut)

Studio tự động hóa quy trình sản xuất Video Review Phim chuyên nghiệp, kế thừa và mở rộng thuật toán cắt cảnh của Auto CapCut, tích hợp cổng AI đa nhà cung cấp (**CKey.vn** / **DeepSeek V4.1 Flash** / OpenAI / Gemini / Custom Base URL) và xuất thẳng ra **Adobe Premiere Pro (.XML FCP7 XMEML v4 - 100% Online Media)** cùng **CapCut Project (draft_content.json)**.

---

## ✨ Tính Năng Nổi Bật

### 1. 🔑 Quản Lý API AI Đa Nhà Cung Cấp (Multi-Provider AI Gateway)
- **Tích hợp sẵn CKey.vn:** Mặc định kết nối tới `https://api.xah.io/v1` với model `deepseek-v4.1-flash` (`reasoning_effort: xhigh`).
- **Nạp nhanh từ `@openai/codex`:** Nút bấm `⚡ Tự nạp Key & Model từ @openai/codex` tự động đọc `~/.codex/config.toml` và `~/.codex/auth.json` (hỗ trợ trực tiếp script cài đặt `curl` từ ckey.vn).
- **Thêm không giới hạn cổng API bên thứ 3:** Tự do thêm bất kỳ cổng OpenAI-compatible nào (`Base URL`, `API Key`, `Model ID`, `Reasoning Effort`).
- **Tự động tải danh sách Model:** Bấm nút `🔄 Tải danh sách Model` để fetch trực tiếp từ `/v1/models`.

### 2. 🔍 Phân Tích Video, Điểm Cắt Máy & Đo Cao Trào (Robust Z-Score)
- **FFmpeg Scene Detection:** Tự động quét các mốc chuyển góc máy (`shots`) bằng filter `select='gt(scene,0.3)',showinfo`.
- **Đo năng lượng âm lượng RMS:** Quét log âm thanh `astats` (8000Hz mono).
- **Phát hiện Cao trào (Highlights):** Tính **Robust Z-Score dựa trên Trung vị và MAD ($1.4826$)**, kết hợp 60% năng lượng âm thanh + 40% mật độ chuyển cảnh, loại bỏ 3% rìa đầu/cuối phim, gộp các đoạn kịch tính.
- **Tự nhặt Hook 15s:** Tự động cắt các clip 1.6s quanh đỉnh cao trào (chống spoiler 15% cuối phim) ghép thành 15s Hook mở đầu.
- **Bơm nhãn cao trào vào phụ đề:** Tự động chèn dòng `【CẢNH CAO TRÀO...】` vào các đoạn hành động không có thoại để AI viết kịch bản không bỏ sót cảnh đánh đấm/rượt đuổi.

### 3. ✍️ Pipeline AI Viết Kịch Bản 4 Bước & Quy Hoạch Động (LCS DP) Khi Sửa Chữ
- **Stage 1 — Dàn ý Beat:** Phân tích toàn bộ phim ra các hồi, gán trọng số kịch tính (`weight` 1, 2, 3) cho từng beat.
- **Stage 2 — Nhân vật & Xưng hô:** Phân loại nhân vật chính (tối đa 5) và phụ (gọi bằng vai trò/quan hệ). Hỗ trợ đặt biệt danh tấu hài khi bật `funNames`.
- **Stage 3 — Chia phần theo trọng số:** Snap ranh giới phần vào đầu beat gần nhất; phân bổ số phút và số câu theo tổng `weight` của beat.
- **Stage 4 — Chuốt văn & Chẻ câu dài:** Tự động chẻ đôi các câu > 32 từ tại dấu câu gần điểm giữa nhất, chia đôi khoảng phụ đề `[srtFrom, srtTo]`.
- **Quy hoạch động Sørensen–Dice LCS (`remapScriptRanges`):** Bạn sửa chữ, xóa câu hoặc thêm câu mới thoải mái; thuật toán so khớp từ vựng đa tập hợp giữ nguyên mốc thời gian cũ cho câu khớp và tự động nội suy chia đều khoảng trống cho các câu mới chèn thêm.

### 4. ⚡ Thuật Toán Beam-Search Cắt Cảnh Chống Giật (ReviewSync)
- **Beam Search (`beamWidth = 48`):** Duyệt 48 nhánh tối ưu nhất trên 3 cấp độ nới lỏng (`relax = 0, 1, 2`) để chọn 2–3 mảnh cắt cho mỗi câu lời bình.
- **Bộ lọc chống nháy hình (Anti-Flash-Frame):** Loại bỏ mọi ứng viên nếu có điểm cắt camera của phim gốc rơi vào vùng đệm `[60ms, 600ms]` ở đầu hoặc cuối clip.
- **Quy tắc chuyển tiếp:** Nhảy cảnh tối thiểu $\ge 2.0\text{ s}$ (hoặc chạy liên tục $\le 6.0\text{ s}$ để tránh bản quyền Content ID). Chống trùng lặp cảnh cũ $< 2\%$.
- **Co giãn tốc độ Vàng ($0.9\times \to 1.1\times$):** Khớp thời lượng video với câu đọc chính xác tuyệt đối đến từng micro-giây.

### 5. 🎬 Xuất Kép: Adobe Premiere Pro XML & CapCut Project
- **Adobe Premiere Pro (`.xml` FCP7 XMEML v4):**
  - Khai báo 1 thẻ `<file id="master-video-1">` duy nhất $\to$ **100% Online Media**, mở lên là nhận ngay lập tức, không tốn 1 giây render cắt clip!
  - `startFrame = endFrame` liền mạch chống trôi frame (Zero Frame Drift).
  - Gắn thẻ Time Remapping (`speed`), Basic Motion Scale (Zoom chống bản quyền, mặc định 108%), Horizontal Flip (Lật hình), Track Voiceover A1, Track Audio gốc A2, và Sequence/Clip Markers tiếng Việt.
  - Xuất kèm file `Master_Voice.srt` đồng bộ 100% với Timeline mới.
- **CapCut Project (`draft_content.json`):**
  - Bơm phụ đề vào track text; Quy hoạch động Exact LCS bảo toàn liên kết giọng đọc TTS (`text_to_audio`).
  - Nhân bản riêng `PER_SEGMENT_ARRAYS` (`speeds`, v.v.), áp dụng Zoom, Flip, làm mờ phụ đề gốc (`BLUR_EFFECT_ID = 7399464929830423813`) và Watermark chạy keyframe.

---

## 🚀 Cài Đặt & Khởi Chạy

### Yêu Cầu Hệ Thống
- **Node.js** v18+ trở lên.
- **FFmpeg & FFprobe** đã thêm vào biến môi trường `PATH`.

### Cài Đặt Gói Phụ Thuộc
```bash
npm install
```

### Khởi Động Studio Web UI (Dark Mode)
```bash
npm start
```
Mở trình duyệt tại: **`http://localhost:3456`**

### Sử Dụng Bằng Dòng Lệnh (CLI)
```bash
node src/cli.js --video "D:/phim.mp4" --srt "D:/phim.srt" --minutes 6 --zoom 1.08 --flip --out "output/Review_Premiere.xml"
```

---

## 📁 Cấu Trúc Mã Nguồn

```text
├── config/
│   └── ai-settings.json          # Cấu hình lưu trữ API Key, Provider, Model
├── public/
│   └── index.html                # Giao diện Studio Dark Mode, nút bấm [Render] lún xuống
├── src/
│   ├── core/
│   │   ├── ai-providers.js       # Quản lý cổng AI (CKey.vn / OpenAI / Codex import)
│   │   ├── ffmpeg-analyzer.js    # Quét shots, RMS và thông số video (cache JSON)
│   │   ├── highlight-core.js     # Robust Z-Score, tìm cảnh cao trào & nhặt Hook 15s
│   │   ├── review-script-core.js # Pipeline kịch bản AI 4 bước & Quy hoạch động LCS
│   │   ├── review-sync.js        # Thuật toán Beam-Search cắt cảnh (beamWidth = 48)
│   │   ├── premiere-xml-builder.js # Bộ sinh Premiere Pro XML (FCP7 XMEML v4)
│   │   ├── capcut-draft-utils.js # Đọc/ghi và can thiệp draft_content.json của CapCut
│   │   └── translate-core.js     # Dịch phụ đề đa luồng & tạo prompt ảnh/video
│   ├── cli.js                    # Giao diện dòng lệnh CLI
│   └── server.js                 # Express server & API endpoints
├── package.json
└── README.md
```

---

## 📜 Giấy Phép
Dự án được phân phối theo giấy phép ISC.
