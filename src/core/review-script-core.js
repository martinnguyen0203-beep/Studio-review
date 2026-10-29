"use strict";

const { aiPostChat, extractJsonSafely } = require("./ai-providers");
const { injectHighlightMarkers } = require("./highlight-core");

/**
 * Bảng tốc độ đọc chuẩn theo ngôn ngữ
 */
const LANGS = {
  vi: {
    name: "Tiếng Việt",
    unit: "từ",
    perMin: 300,
    maxSent: 30,
    sentUnits: 25,
    cjk: false
  },
  en: {
    name: "English",
    unit: "words",
    perMin: 160,
    maxSent: 22,
    sentUnits: 19,
    cjk: false
  },
  zh: {
    name: "中文",
    unit: "字",
    perMin: 240,
    maxSent: 45,
    sentUnits: 30,
    cjk: true
  },
  ko: {
    name: "한국어",
    unit: "어절",
    perMin: 120,
    maxSent: 15,
    sentUnits: 13,
    cjk: false
  },
  ja: {
    name: "日本語",
    unit: "文字",
    perMin: 300,
    maxSent: 55,
    sentUnits: 36,
    cjk: true
  }
};

/**
 * Phong cách viết lời bình Review Phim
 */
const STYLES = {
  "kich-tinh":
    "Kịch tính, cuốn hút, đẩy cao xung đột và bất ngờ, nhịp câu dứt khoát, mở đầu bằng câu hook giữ chân người xem ngay từ giây đầu tiên.",
  "tau-hai":
    "Hài hước, tấu hài duyên dáng, bình luận dí dỏm, châm biếm nhẹ nhàng những pha xử lý cồng kềnh của nhân vật nhưng vẫn bám sát mạch truyện.",
  "tam-ly":
    "Sâu sắc, giàu cảm xúc, giọng kể trầm ấm như tâm sự đêm khuya, đi sâu vào nội tâm và bi kịch của nhân vật.",
  "trinh-tham":
    "Phân tích sắc bén, cài cắm manh mối, đặt giả thuyết suy luận logic khiến khán giả hồi hộp theo dõi từng tình tiết phá án.",
  "tu-viet": ""
};

/**
 * Chuyển chuỗi thời gian SRT (HH:MM:SS,mmm) sang micro-giây (us)
 */
function tsToUs(ts) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(String(ts || "").trim());
  if (!m) return 0;
  const h = +m[1];
  const min = +m[2];
  const s = +m[3];
  const ms = +m[4].padEnd(3, "0").slice(0, 3);
  return ((h * 3600 + min * 60 + s) * 1000 + ms) * 1000;
}

/**
 * Chuyển micro-giây (us) sang chuỗi thời gian SRT (HH:MM:SS,mmm)
 */
function usToTs(us) {
  const totalMs = Math.max(0, Math.round((Number(us) || 0) / 1000));
  const h = Math.floor(totalMs / 3600000);
  const min = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  return `${pad2(h)}:${pad2(min)}:${pad2(s)},${pad3(ms)}`;
}

/**
 * Phân tích nội dung file .srt thành mảng các cue [{ index, startUs, endUs, text }]
 */
function parseSrt(raw) {
  const blocks = String(raw || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n\s*\r?\n/);
  const cues = [];

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) continue;

    const timeIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeIdx < 0) continue;

    const parts = lines[timeIdx].split("-->");
    const startUs = tsToUs(parts[0]);
    const endUs = tsToUs(parts[1]);
    const text = lines
      .slice(timeIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();

    if (endUs > startUs && text) {
      cues.push({
        index: cues.length + 1,
        startUs,
        endUs,
        text
      });
    }
  }
  return cues;
}

/**
 * Xuất danh sách cues về lại định dạng file .srt
 */
function formatSrt(cues) {
  return (cues || [])
    .map(
      (c, i) =>
        `${i + 1}\n${usToTs(c.startUs)} --> ${usToTs(c.endUs)}\n${String(
          c.text || c.narration || ""
        ).trim()}`
    )
    .join("\n\n");
}

/**
 * Đánh số dòng phụ đề "[1] text" để gửi cho AI
 */
function numberedSrt(cues) {
  return (cues || []).map((c) => `[${c.index}] ${c.text}`).join("\n");
}

/**
 * Đếm số đơn vị từ (hoặc ký tự CJK) trong câu
 */
function countUnits(text, isCjk = false) {
  const str = String(text || "").trim();
  if (!str) return 0;
  if (isCjk) {
    return (
      str.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g) || []
    ).length;
  }
  return str.split(/\s+/).filter(Boolean).length;
}

/**
 * Làm sạch và chuẩn hóa dàn ý (Outline) do AI trả về ở Stage 1
 */
function sanitizeOutline(raw, totalCues) {
  if (!raw || typeof raw !== "object") return null;
  const N = Math.max(1, Number(totalCues) || 1);
  const clampIdx = (v, fb) =>
    Math.max(1, Math.min(N, Math.round(Number(v) || fb)));

  const beats = Array.isArray(raw.beats)
    ? raw.beats
        .filter((b) => b && (b.what || b.title))
        .map((b) => {
          const from = clampIdx(b.from, 1);
          const to = Math.max(from, clampIdx(b.to, from));
          const w = Number(b.weight);
          const weight = w === 1 || w === 2 || w === 3 ? w : 2;
          return {
            from,
            to,
            title: String(b.title || "").trim(),
            what: String(b.what || "").trim(),
            why: String(b.why || "").trim(),
            weight
          };
        })
    : [];

  const characters = Array.isArray(raw.characters)
    ? raw.characters
        .filter((c) => c && c.name)
        .map((c) => {
          const role =
            c.role === "main" || c.role === "minor" ? c.role : null;
          const charBeats = Array.isArray(c.beats)
            ? c.beats
                .map((n) => Math.round(Number(n)))
                .filter((n) => n >= 1 && n <= beats.length)
            : [];
          return {
            name: String(c.name).trim(),
            role,
            desc: String(c.desc || c.role || "").trim(),
            relation: String(c.relation || "").trim(),
            pronoun: String(c.pronoun || "").trim(),
            beats: charBeats
          };
        })
    : [];

  return {
    summary: String(raw.summary || "").trim(),
    beats,
    characters,
    themes: String(raw.themes || "").trim(),
    twist: String(raw.twist || "").trim(),
    ending: String(raw.ending || "").trim()
  };
}

/**
 * Stage 2: Phân loại nhân vật chính (main, tối đa 5) và phụ (minor, tối đa 9)
 */
function classifyCharacters(outline, { maxMain = 5, maxMinor = 9 } = {}) {
  const chars = (outline && outline.characters) || [];
  const totalBeats = ((outline && outline.beats) || []).length || 1;
  const mainThreshold = Math.max(3, Math.ceil(totalBeats * 0.35));

  const mains = [];
  const minors = [];

  for (const c of chars) {
    const beatPresence = (c.beats && c.beats.length) || 0;
    const isMain =
      c.role === "main"
        ? beatPresence >= 2 || !c.beats.length
        : c.role === "minor"
        ? false
        : beatPresence >= mainThreshold;

    if (isMain && mains.length < maxMain) {
      mains.push(c);
    } else if (minors.length < maxMinor) {
      minors.push(c);
    }
  }

  if (!mains.length && minors.length) {
    mains.push(...minors.splice(0, Math.min(2, minors.length)));
  }

  return { mains, minors };
}

/**
 * Stage 3: Chia phụ đề thành K phần, hút (snap) điểm cắt vào đầu beat gần nhất
 * và phân bổ thời lượng theo trọng số `beat.weight`
 */
function planParts(totalCues, partCount, targetMinutes, outline) {
  const N = Math.max(1, Number(totalCues) || 1);
  const K = Math.max(1, Math.round(Number(partCount) || 1));
  const totalMin = Math.max(0.5, Number(targetMinutes) || 5);
  const beats = (outline && Array.isArray(outline.beats) && outline.beats) || [];

  if (K === 1) {
    return [{ from: 1, to: N, minutes: totalMin, beats }];
  }

  const avgSpan = N / K;
  const boundaries = [1];

  for (let i = 1; i < K; i++) {
    const rawCut = Math.round(1 + i * avgSpan);
    let snapped = rawCut;
    let bestDist = avgSpan * 0.4;

    for (const b of beats) {
      const d = Math.abs(b.from - rawCut);
      if (d < bestDist && b.from > boundaries[boundaries.length - 1] + 5) {
        bestDist = d;
        snapped = b.from;
      }
    }
    boundaries.push(
      Math.max(
        boundaries[boundaries.length - 1] + 1,
        Math.min(N - (K - i), snapped)
      )
    );
  }
  boundaries.push(N + 1);

  const parts = [];
  for (let i = 0; i < K; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1] - 1;
    const partBeats = beats.filter((b) => b.to >= from && b.from <= to);
    const weightSum = partBeats.length
      ? partBeats.reduce((acc, b) => acc + (b.weight || 2), 0)
      : 2;
    parts.push({ from, to, beats: partBeats, weightSum });
  }

  const totalWeights = parts.reduce((acc, p) => acc + p.weightSum, 0) || K;
  const minFloor = (totalMin / K) * 0.4;

  const rawMins = parts.map((p) =>
    Math.max(minFloor, (totalMin * p.weightSum) / totalWeights)
  );
  const sumRawMins = rawMins.reduce((acc, m) => acc + m, 0) || totalMin;

  return parts.map((p, idx) => ({
    from: p.from,
    to: p.to,
    minutes: +((rawMins[idx] * totalMin) / sumRawMins).toFixed(2),
    beats: p.beats
  }));
}

/**
 * Các danh xưng viết tắt không được chẻ câu tại dấu chấm
 */
const ABBREV_REGEX =
  /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|TP|TS|ThS|PGS|GS|BS|KS)\.\s*$/i;

/**
 * Tìm vị trí dấu câu tốt nhất gần giữa câu (trong vùng 20% - 80%) để chẻ câu dài
 */
function findBestSplitPos(text) {
  const len = text.length;
  const mid = len / 2;
  const minIdx = Math.floor(len * 0.2);
  const maxIdx = Math.ceil(len * 0.8);

  const tiers = [/[.!?…。！？]/g, /[;:—–；]/g, /[,、，]/g];

  for (const regex of tiers) {
    let bestPos = -1;
    let bestDist = Infinity;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const cutPos = m.index + m[0].length;
      if (cutPos < minIdx || cutPos > maxIdx) continue;
      if (m[0] === "." && ABBREV_REGEX.test(text.slice(0, cutPos))) continue;
      const dist = Math.abs(cutPos - mid);
      if (dist < bestDist) {
        bestDist = dist;
        bestPos = cutPos;
      }
    }
    if (bestPos > 0) return bestPos;
  }
  return -1;
}

/**
 * Stage 4: Tự động chẻ các câu lời bình quá dài (> maxUnits) và chia đôi [srtFrom, srtTo]
 */
function splitLongCues(cues, maxUnits = 32, isCjk = false) {
  let list = [...(cues || [])];
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const nextList = [];

    for (const cue of list) {
      if (countUnits(cue.narration, isCjk) <= maxUnits) {
        nextList.push(cue);
        continue;
      }

      const splitPos = findBestSplitPos(cue.narration);
      if (splitPos < 0) {
        nextList.push(cue);
        continue;
      }

      const leftText = cue.narration.slice(0, splitPos).trim();
      const rightText = cue.narration.slice(splitPos).trim();
      if (
        countUnits(leftText, isCjk) < 4 ||
        countUnits(rightText, isCjk) < 4
      ) {
        nextList.push(cue);
        continue;
      }

      const midSrt = Math.floor((cue.srtFrom + cue.srtTo) / 2);
      nextList.push(
        {
          narration: leftText,
          srtFrom: cue.srtFrom,
          srtTo: Math.max(cue.srtFrom, midSrt)
        },
        {
          narration: rightText,
          srtFrom: Math.min(cue.srtTo, midSrt),
          srtTo: cue.srtTo
        }
      );
      changed = true;
    }

    list = nextList;
    if (!changed) break;
  }
  return list;
}

/**
 * Chuyển đổi mảng cues [{ narration, srtFrom, srtTo }] sang mốc thời gian thực [startUs, endUs]
 */
function cuesToRanges(srtCues, aiCues) {
  const N = (srtCues || []).length;
  if (!N) return [];
  const clamp = (n) => Math.max(1, Math.min(N, Math.round(Number(n) || 1)));

  return (aiCues || [])
    .map((c, idx) => {
      const text = String(c.narration || c.text || "")
        .replace(/\s+/g, " ")
        .trim();
      const from = clamp(c.srtFrom);
      const to = Math.max(from, clamp(c.srtTo || from));
      return {
        index: idx + 1,
        text,
        narration: text,
        srtFrom: from,
        srtTo: to,
        startUs: srtCues[from - 1].startUs,
        endUs: srtCues[to - 1].endUs
      };
    })
    .filter((c) => c.text && c.endUs > c.startUs);
}

/**
 * Chuẩn hóa chuỗi để so sánh độ tương đồng
 */
function normalizeForSim(str) {
  return String(str || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tính hệ số tương đồng từ vựng đa tập hợp Sørensen–Dice:
 * sim(A, B) = (2 * |A ∩ B|) / (|A| + |B|)
 */
function lineSimilarity(a, b) {
  const na = normalizeForSim(a);
  const nb = normalizeForSim(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const wordsA = na.split(" ");
  const wordsB = nb.split(" ");
  const freq = new Map();
  for (const w of wordsA) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }

  let inter = 0;
  for (const w of wordsB) {
    const c = freq.get(w) || 0;
    if (c > 0) {
      inter++;
      freq.set(w, c - 1);
    }
  }
  return (2 * inter) / (wordsA.length + wordsB.length);
}

/**
 * QUY HOẠCH ĐỘNG (Weighted LCS DP):
 * Ánh xạ lại mốc thời gian [startUs, endUs] khi người dùng sửa chữ, xóa câu hoặc thêm câu mới
 */
function remapScriptRanges(oldCues, editedLines, { minSim = 0.35 } = {}) {
  const oldList = (oldCues || []).filter(
    (c) => c && c.text && c.endUs > c.startUs
  );
  const newLines = (editedLines || [])
    .map((l) => (typeof l === "string" ? l.trim() : String((l && l.text) || "").trim()))
    .filter(Boolean);

  const M = oldList.length;
  const N = newLines.length;
  if (!N) return [];
  if (!M) {
    return newLines.map((text, idx) => ({
      index: idx + 1,
      text,
      startUs: null,
      endUs: null,
      status: "new",
      sim: 0
    }));
  }

  // Ma trận tương đồng sim[M][N]
  const sim = Array.from({ length: M }, (_, i) =>
    Array.from({ length: N }, (__, j) => lineSimilarity(oldList[i].text, newLines[j]))
  );

  // Bảng quy hoạch động dp[M+1][N+1]
  const dp = Array.from({ length: M + 1 }, () => new Float64Array(N + 1));
  const choice = Array.from({ length: M + 1 }, () => new Uint8Array(N + 1));

  for (let i = M - 1; i >= 0; i--) {
    for (let j = N - 1; j >= 0; j--) {
      let best = dp[i + 1][j];
      let dir = 1; // skip old i
      if (dp[i][j + 1] > best) {
        best = dp[i][j + 1];
        dir = 2; // skip new j
      }
      if (sim[i][j] >= minSim) {
        const matchScore = dp[i + 1][j + 1] + sim[i][j];
        if (matchScore >= best) {
          best = matchScore;
          dir = 3; // match (i, j)
        }
      }
      dp[i][j] = best;
      choice[i][j] = dir;
    }
  }

  // Truy vết nghiệm
  const matchedOldForNew = new Array(N).fill(-1);
  let i = 0;
  let j = 0;
  while (i < M && j < N) {
    const dir = choice[i][j];
    if (dir === 3) {
      matchedOldForNew[j] = i;
      i++;
      j++;
    } else if (dir === 1) {
      i++;
    } else {
      j++;
    }
  }

  const result = newLines.map((text, idx) => {
    const oldIdx = matchedOldForNew[idx];
    if (oldIdx >= 0) {
      const oldCue = oldList[oldIdx];
      const s = sim[oldIdx][idx];
      return {
        index: idx + 1,
        text,
        startUs: oldCue.startUs,
        endUs: oldCue.endUs,
        srtFrom: oldCue.srtFrom,
        srtTo: oldCue.srtTo,
        status: s >= 0.999 ? "kept" : "edited",
        sim: +s.toFixed(3)
      };
    }
    return {
      index: idx + 1,
      text,
      startUs: null,
      endUs: null,
      status: "new",
      sim: 0
    };
  });

  // Nội suy khoảng thời gian cho các chuỗi câu mới liên tiếp (status === "new")
  const minFirstStart = oldList[0].startUs;
  const maxLastEnd = oldList[M - 1].endUs;

  let k = 0;
  while (k < N) {
    if (result[k].startUs !== null) {
      k++;
      continue;
    }
    let endNew = k;
    while (endNew < N && result[endNew].startUs === null) {
      endNew++;
    }
    const countNew = endNew - k;
    const prev = k > 0 ? result[k - 1] : null;
    const next = endNew < N ? result[endNew] : null;

    let spanStart;
    let spanEnd;
    if (prev && next) {
      if (next.startUs - prev.endUs >= 3000000 * countNew) {
        spanStart = prev.endUs;
        spanEnd = next.startUs;
      } else if (next.startUs >= prev.startUs) {
        spanStart = prev.startUs;
        spanEnd = Math.max(next.endUs, prev.endUs);
      } else {
        spanStart = prev.startUs;
        spanEnd = prev.endUs;
      }
    } else if (prev) {
      spanStart = prev.endUs;
      spanEnd = Math.max(maxLastEnd, prev.endUs + 5000000 * countNew);
      if (spanEnd - spanStart < 2000000 * countNew) {
        spanStart = prev.startUs;
      }
    } else if (next) {
      spanEnd = next.startUs;
      spanStart = Math.max(0, Math.min(minFirstStart, spanEnd - 5000000 * countNew));
      if (spanEnd - spanStart < 2000000 * countNew) {
        spanEnd = next.endUs;
      }
    } else {
      spanStart = minFirstStart;
      spanEnd = maxLastEnd;
    }

    const step = Math.max(1000000, Math.round((spanEnd - spanStart) / countNew));
    for (let m = 0; m < countNew; m++) {
      result[k + m].startUs = spanStart + m * step;
      result[k + m].endUs =
        m === countNew - 1 ? Math.max(spanStart + (m + 1) * step, spanEnd) : spanStart + (m + 1) * step;
    }
    k = endNew;
  }

  return result;
}

/**
 * Thực thi trọn bộ Pipeline AI 4 Bước để viết kịch bản Review Phim
 */
async function generateReviewScript({
  srtCues,
  highlights = [],
  targetMinutes = 6,
  lang = "vi",
  style = "kich-tinh",
  customStyle = "",
  funNames = false,
  providerId,
  model,
  onProgress
} = {}) {
  const L = LANGS[lang] || LANGS.vi;
  const styleDesc =
    style === "tu-viet" && customStyle.trim()
      ? customStyle.trim()
      : STYLES[style] || STYLES["kich-tinh"];

  // Trộn các điểm CẢNH CAO TRÀO không thoại vào phụ đề
  const { cues: enrichedCues, added: addedHighlights } = injectHighlightMarkers(
    srtCues,
    highlights
  );
  const srtText = numberedSrt(enrichedCues);
  const totalCues = enrichedCues.length;

  // STAGE 1: Lập dàn ý cốt truyện & trọng số Beat
  if (onProgress) {
    onProgress({
      stage: 1,
      message: `Bước 1/4: Đang đọc ${totalCues} dòng phụ đề (${addedHighlights} cảnh cao trào) để lập dàn ý...`
    });
  }

  const outlineSys = `Bạn là nhà phê bình điện ảnh và biên kịch Review Phim kỳ cựu.
Hãy đọc toàn bộ phụ đề đánh số [1]..[${totalCues}] của bộ phim và lập dàn ý cấu trúc cốt truyện thật chuẩn xác.
Các dòng "【CẢNH CAO TRÀO...】" là đoạn hành động/cảm xúc mạnh không có lời thoại do hệ thống âm thanh/hình ảnh phát hiện.
Trả về DUY NHẤT một JSON object hợp lệ (không giải thích ngoài JSON):
{
  "summary": "Tóm tắt cốt truyện chính trong 3-5 câu (${L.name})",
  "beats": [
    {
      "from": 1,
      "to": 45,
      "title": "Tên hồi/tình tiết",
      "what": "Diễn biến cụ thể xảy ra trong đoạn [from..to]",
      "why": "Ý nghĩa/hậu quả đối với mạch truyện",
      "weight": 2
    }
  ],
  "characters": [
    {
      "name": "Tên nhân vật",
      "role": "main",
      "desc": "Đặc điểm nhận dạng/nghề nghiệp",
      "relation": "Mối quan hệ với nhân vật chính",
      "pronoun": "Cách gọi/xưng hô",
      "beats": [1, 2, 3]
    }
  ],
  "twist": "Cú lật (plot twist) lớn nhất phim",
  "ending": "Kết cục của bộ phim"
}
Quy tắc weight: 3 = cao trào/bước ngoặt quan trọng nhất, 2 = tình tiết chính, 1 = chuyển cảnh/mở đầu phụ.`;

  const outlineRes = await aiPostChat({
    providerId,
    model,
    system: outlineSys,
    user: srtText,
    temperature: 0.3,
    maxTokens: 4096,
    responseJson: true
  });

  const outline = sanitizeOutline(outlineRes.json, totalCues) || {
    summary: "",
    beats: [{ from: 1, to: totalCues, title: "Toàn bộ phim", what: "", why: "", weight: 2 }],
    characters: [],
    twist: "",
    ending: ""
  };

  // STAGE 2: Phân loại nhân vật & đặt danh xưng
  if (onProgress) {
    onProgress({
      stage: 2,
      message: "Bước 2/4: Đang chuẩn hóa tuyến nhân vật chính/phụ..."
    });
  }

  const { mains, minors } = classifyCharacters(outline);
  let castGuide = [
    ...mains.map((c) => `- [CHÍNH] ${c.name}: ${c.desc} (${c.relation})`),
    ...minors.map((c) => `- [PHỤ - gọi bằng vai trò] ${c.relation || c.desc || c.name}`)
  ].join("\n");

  if (funNames && mains.length) {
    try {
      const castRes = await aiPostChat({
        providerId,
        model,
        system: `Đặt biệt danh tấu hài ngắn gọn (2-4 chữ, dễ nhớ, đúng tính cách) bằng ${L.name} cho các nhân vật chính sau. Trả về JSON: {"cast":[{"orig":"...","call":"...","note":"..."}]}`,
        user: JSON.stringify({ summary: outline.summary, mains }),
        temperature: 0.6,
        maxTokens: 1024,
        responseJson: true
      });
      if (castRes.json && Array.isArray(castRes.json.cast)) {
        castGuide = castRes.json.cast
          .map((c) => `- ${c.orig} -> gọi là "${c.call}" (${c.note || ""})`)
          .join("\n");
      }
    } catch (_) {}
  }

  // STAGE 3: Chia phần theo trọng số Beat & viết lời bình chi tiết
  const partCount = Math.max(1, Math.min(6, Math.ceil(targetMinutes / 3)));
  const parts = planParts(totalCues, partCount, targetMinutes, outline);
  const allAiCues = [];

  for (let pIdx = 0; pIdx < parts.length; pIdx++) {
    const part = parts[pIdx];
    const targetWords = Math.round(part.minutes * L.perMin);
    const targetSentences = Math.max(
      4,
      Math.round(targetWords / L.sentUnits)
    );

    if (onProgress) {
      onProgress({
        stage: 3,
        partIndex: pIdx + 1,
        partCount: parts.length,
        message: `Bước 3/4: Đang viết lời bình Phần ${pIdx + 1}/${parts.length} (dòng [${part.from}..${part.to}], ~${targetSentences} câu)...`
      });
    }

    const partCues = enrichedCues.filter(
      (c) => c.index >= part.from && c.index <= part.to
    );
    const partSrtText = numberedSrt(partCues);

    const partSys = `Bạn là biên kịch Review Phim chuyên nghiệp viết bằng ${L.name}.
Phong cách yêu cầu: ${styleDesc}

THÔNG TIN TỔNG QUAN PHIM:
- Tóm tắt: ${outline.summary}
- Bảng nhân vật:
${castGuide || "(Theo phụ đề)"}

NHIỆM VỤ PHẦN ${pIdx + 1}/${parts.length} (Phụ đề từ [${part.from}] đến [${part.to}]):
- Viết khoảng ${targetSentences} câu lời bình (tổng ~${targetWords} ${L.unit}), mỗi câu dài khoảng ${L.sentUnits} ${L.unit} (tối đa ${L.maxSent} ${L.unit}).
- Mỗi câu lời bình ("narration") PHẢI gắn chính xác khoảng dòng phụ đề tương ứng "srtFrom" và "srtTo" (${part.from} <= srtFrom <= srtTo <= ${part.to}) theo trình tự thời gian tăng dần.
- Không dịch từng câu thoại rời rạc; hãy kể lại diễn biến, động cơ nhân vật và kịch tính của cảnh đó.
${pIdx === 0 ? "- Câu đầu tiên phải là câu HOOK cực kỳ cuốn hút!" : "- Nối tiếp tự nhiên mạch kể của phần trước."}

Trả về DUY NHẤT JSON hợp lệ theo mẫu:
{
  "cues": [
    { "narration": "Câu lời bình...", "srtFrom": ${part.from}, "srtTo": ${Math.min(part.to, part.from + 8)} }
  ]
}`;

    const partRes = await aiPostChat({
      providerId,
      model,
      system: partSys,
      user: partSrtText,
      temperature: 0.45,
      maxTokens: 6144,
      responseJson: true
    });

    const rawPartCues =
      partRes.json && Array.isArray(partRes.json.cues)
        ? partRes.json.cues
        : Array.isArray(partRes.json)
        ? partRes.json
        : [];

    for (const c of rawPartCues) {
      if (c && c.narration) {
        allAiCues.push({
          narration: String(c.narration).trim(),
          srtFrom: Math.max(part.from, Math.min(part.to, Number(c.srtFrom) || part.from)),
          srtTo: Math.max(part.from, Math.min(part.to, Number(c.srtTo) || Number(c.srtFrom) || part.to))
        });
      }
    }
  }

  // STAGE 4: Tự động chẻ câu dài & ánh xạ sang [startUs, endUs]
  if (onProgress) {
    onProgress({
      stage: 4,
      message: "Bước 4/4: Đang chẻ các câu quá dài và đồng bộ mốc thời gian gốc..."
    });
  }

  const splitCues = splitLongCues(allAiCues, L.maxSent + 2, L.cjk);
  const finalCues = cuesToRanges(enrichedCues, splitCues);

  return {
    outline,
    castGuide,
    parts,
    cues: finalCues,
    totalSentences: finalCues.length,
    totalWords: finalCues.reduce((acc, c) => acc + countUnits(c.text, L.cjk), 0)
  };
}

module.exports = {
  LANGS,
  STYLES,
  tsToUs,
  usToTs,
  parseSrt,
  formatSrt,
  numberedSrt,
  countUnits,
  sanitizeOutline,
  classifyCharacters,
  planParts,
  splitLongCues,
  cuesToRanges,
  lineSimilarity,
  remapScriptRanges,
  generateReviewScript
};
