"use strict";

const { aiPostChat } = require("./ai-providers");
const { parseSrt, formatSrt } = require("./review-script-core");

/**
 * Chuẩn hóa văn bản trên 1 dòng
 */
function normalizeText(str) {
  return String(str || "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Phân tích đầu vào (có thể là chuỗi SRT hoặc mảng các dòng/cue)
 */
function parseInputCues(input) {
  if (Array.isArray(input)) {
    return input.map((item, idx) => ({
      index: item.index || idx + 1,
      startUs: item.startUs != null ? item.startUs : idx * 3000000,
      endUs: item.endUs != null ? item.endUs : (idx + 1) * 3000000,
      text: normalizeText(item.text || item.narration || item)
    }));
  }
  const str = String(input || "").trim();
  if (str.includes("-->")) {
    return parseSrt(str);
  }
  return str
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text, idx) => ({
      index: idx + 1,
      startUs: idx * 3000000,
      endUs: (idx + 1) * 3000000,
      text
    }));
}

/**
 * Dịch phụ đề theo từng khối (chunk 45 dòng), giữ nguyên 100% số dòng, thứ tự index và [startUs, endUs]
 */
async function translateSubtitles({
  input,
  targetLang = "Tiếng Việt",
  styleNote = "Tự nhiên, ngắn gọn, đúng ngữ cảnh thoại phim",
  chunkSize = 45,
  providerId,
  model,
  onProgress
} = {}) {
  const cues = parseInputCues(input);
  if (!cues.length) {
    throw new Error("Không có dòng phụ đề nào hợp lệ để dịch.");
  }

  const totalChunks = Math.ceil(cues.length / chunkSize);
  const translatedCues = [];

  for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
    const start = cIdx * chunkSize;
    const chunk = cues.slice(start, start + chunkSize);

    if (onProgress) {
      onProgress({
        chunkIndex: cIdx + 1,
        totalChunks,
        message: `Đang dịch khối ${cIdx + 1}/${totalChunks} (dòng ${chunk[0].index} -> ${chunk[chunk.length - 1].index})...`
      });
    }

    const numberedInput = chunk
      .map((c, i) => `[${i + 1}] ${c.text}`)
      .join("\n");

    const sysPrompt = `Bạn là dịch giả phụ đề phim chuyên nghiệp sang ngôn ngữ: ${targetLang}.
Phong cách dịch: ${styleNote}.
QUY TẮC BẮT BUỘC:
1. Dịch ĐÚNG ${chunk.length} dòng được đánh số từ [1] đến [${chunk.length}].
2. Tuyệt đối KHÔNG gộp dòng, KHÔNG tách dòng, KHÔNG bỏ sót dòng nào.
3. Trả về DUY NHẤT một JSON object hợp lệ theo cấu trúc:
{
  "items": [
    { "id": 1, "text": "Bản dịch dòng 1" }
  ]
}`;

    const res = await aiPostChat({
      providerId,
      model,
      system: sysPrompt,
      user: numberedInput,
      temperature: 0.3,
      maxTokens: 4096,
      responseJson: true
    });

    const items =
      res.json && Array.isArray(res.json.items)
        ? res.json.items
        : Array.isArray(res.json)
        ? res.json
        : [];

    const mapById = new Map();
    items.forEach((it, idx) => {
      if (it && typeof it === "object") {
        const key = Number(it.id || it.index) || idx + 1;
        mapById.set(key, normalizeText(it.text || it.translation || ""));
      } else if (typeof it === "string") {
        mapById.set(idx + 1, normalizeText(it));
      }
    });

    chunk.forEach((origCue, idx) => {
      const translatedText = mapById.get(idx + 1) || origCue.text;
      translatedCues.push({
        ...origCue,
        origText: origCue.text,
        text: translatedText
      });
    });
  }

  return {
    cues: translatedCues,
    srt: formatSrt(translatedCues),
    totalLines: translatedCues.length
  };
}

/**
 * Tạo Prompt tạo Ảnh / Video AI (tiếng Anh chi tiết) tương ứng 1:1 với từng dòng kịch bản/phụ đề
 */
async function generateVisualPrompts({
  input,
  visualStyle = "Cinematic 8k, photorealistic, dramatic lighting, shallow depth of field, movie still",
  chunkSize = 35,
  providerId,
  model,
  onProgress
} = {}) {
  const cues = parseInputCues(input);
  if (!cues.length) {
    throw new Error("Không có dòng thoại/kịch bản nào để tạo Prompt.");
  }

  const totalChunks = Math.ceil(cues.length / chunkSize);
  const promptCues = [];

  for (let cIdx = 0; cIdx < totalChunks; cIdx++) {
    const start = cIdx * chunkSize;
    const chunk = cues.slice(start, start + chunkSize);

    if (onProgress) {
      onProgress({
        chunkIndex: cIdx + 1,
        totalChunks,
        message: `Đang tạo Prompt hình ảnh khối ${cIdx + 1}/${totalChunks}...`
      });
    }

    const numberedInput = chunk
      .map((c, i) => `[${i + 1}] ${c.text}`)
      .join("\n");

    const sysPrompt = `You are an expert AI Visual Director & Prompt Engineer for Midjourney / Flux / Google Veo / Sora.
Visual Style Guideline: ${visualStyle}
TASK:
For each numbered narration/subtitle line [1]..[${chunk.length}], write 1 detailed English visual prompt describing the scene, subject appearance, action, camera angle, and lighting. Keep consistency across consecutive lines.
Return ONLY valid JSON:
{
  "items": [
    { "id": 1, "prompt": "Detailed English visual prompt for line 1..." }
  ]
}`;

    const res = await aiPostChat({
      providerId,
      model,
      system: sysPrompt,
      user: numberedInput,
      temperature: 0.5,
      maxTokens: 6144,
      responseJson: true
    });

    const items =
      res.json && Array.isArray(res.json.items)
        ? res.json.items
        : Array.isArray(res.json)
        ? res.json
        : [];

    const mapById = new Map();
    items.forEach((it, idx) => {
      if (it && typeof it === "object") {
        const key = Number(it.id || it.index) || idx + 1;
        mapById.set(key, normalizeText(it.prompt || it.text || ""));
      }
    });

    chunk.forEach((origCue, idx) => {
      promptCues.push({
        ...origCue,
        prompt: mapById.get(idx + 1) || `${visualStyle}, ${origCue.text}`
      });
    });
  }

  return {
    cues: promptCues,
    totalLines: promptCues.length
  };
}

module.exports = {
  normalizeText,
  parseInputCues,
  translateSubtitles,
  generateVisualPrompts
};
