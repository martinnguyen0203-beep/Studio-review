"use strict";

/**
 * Phân tích log RMS_level từ FFmpeg astats filter
 * @param {string} logText
 * @returns {Array<{t: number, db: number}>}
 */
function parseRmsLog(logText) {
  const result = [];
  let currentPts = null;
  const lines = String(logText || "").split(/\r?\n/);

  for (const line of lines) {
    const ptsMatch = /pts_time:([\d.]+)/.exec(line);
    if (ptsMatch) {
      currentPts = parseFloat(ptsMatch[1]);
      continue;
    }
    const rmsMatch = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (rmsMatch && currentPts != null) {
      const db =
        rmsMatch[1] === "-inf"
          ? -120
          : Math.max(-120, parseFloat(rmsMatch[1]));
      result.push({ t: currentPts, db });
      currentPts = null;
    }
  }
  return result;
}

/**
 * Tính trung vị của mảng số
 * @param {number[]} arr
 */
function median(arr) {
  if (!arr || !arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Chuẩn hóa Robust Z-Score dựa trên trung vị và MAD (Median Absolute Deviation)
 * Công thức: Z(x) = (x - med) / (1.4826 * MAD)
 * @param {number[]} arr
 */
function robustZ(arr) {
  const med = median(arr);
  const mad = median(arr.map((x) => Math.abs(x - med))) || 1e-6;
  return arr.map((x) => (x - med) / (1.4826 * mad));
}

/**
 * Làm mượt mảng bằng trung bình trượt với bán kính `radius`
 * @param {number[]} arr
 * @param {number} radius
 */
function smooth(arr, radius) {
  return arr.map((_, i) => {
    let sum = 0;
    let count = 0;
    const lo = Math.max(0, i - radius);
    const hi = Math.min(arr.length - 1, i + radius);
    for (let j = lo; j <= hi; j++) {
      sum += arr[j];
      count++;
    }
    return count ? sum / count : 0;
  });
}

/**
 * Phát hiện các phân đoạn Cao trào (Highlights) kết hợp năng lượng âm thanh RMS (60%)
 * và mật độ chuyển cảnh camera Shots (40%)
 */
function detectHighlights({ rms, loudSec, shots, dialog, durationUs, opt }) {
  if (!rms && Array.isArray(loudSec)) {
    rms = loudSec.map((db, idx) => ({ t: idx, db }));
  }
  opt = opt || {};
  const topN = opt.topN || 30;
  const minSec = opt.minSec || 5;
  const maxSec = opt.maxSec || 60;
  const mergeGapSec = opt.mergeGapSec != null ? opt.mergeGapSec : 3;
  const edgeFrac = opt.edgeFrac != null ? opt.edgeFrac : 0.03;
  const pct = opt.pct || 0.85;

  const lastRmsSec = rms && rms.length ? rms[rms.length - 1].t : 0;
  const totalSec = Math.max(
    1,
    Math.ceil(Math.max(lastRmsSec, (durationUs || 0) / 1000000))
  );

  // 1. Năng lượng âm thanh trung bình theo từng giây (dB)
  const powerSums = new Array(totalSec).fill(0);
  const powerCounts = new Array(totalSec).fill(0);
  for (const sample of rms || []) {
    const secIdx = Math.min(totalSec - 1, Math.max(0, Math.floor(sample.t)));
    powerSums[secIdx] += Math.pow(10, sample.db / 10);
    powerCounts[secIdx]++;
  }
  const secDb = powerSums.map((sum, idx) =>
    powerCounts[idx]
      ? 10 * Math.log10(Math.max(1e-12, sum / powerCounts[idx]))
      : -120
  );

  // 2. Mật độ chuyển cảnh camera theo từng giây
  const shotCounts = new Array(totalSec).fill(0);
  for (const shotUs of shots || []) {
    const secIdx = Math.floor(shotUs / 1000000);
    if (secIdx >= 0 && secIdx < totalSec) {
      shotCounts[secIdx]++;
    }
  }
  const shotRate = smooth(shotCounts, 4).map((v) => v * 9);

  // 3. Tỷ lệ thời lượng có lời thoại trong từng giây
  const dialogSecFrac = new Array(totalSec).fill(0);
  for (const d of dialog || []) {
    const sUs = d.s != null ? d.s : d.startUs;
    const eUs = d.e != null ? d.e : d.endUs;
    if (sUs == null || eUs == null) continue;
    const startSec = Math.max(0, Math.floor(sUs / 1000000));
    const endSec = Math.min(totalSec - 1, Math.floor(eUs / 1000000));
    for (let sec = startSec; sec <= endSec; sec++) {
      const a = Math.max(sec * 1000000, sUs);
      const b = Math.min((sec + 1) * 1000000, eUs);
      if (b > a) {
        dialogSecFrac[sec] = Math.min(
          1,
          dialogSecFrac[sec] + (b - a) / 1000000
        );
      }
    }
  }

  // 4. Chuẩn hóa Robust Z-Score & kết hợp 60% Audio + 40% Shot Density
  const hasShots = (shots || []).length > 20;
  const zAudio = robustZ(smooth(secDb, 1));
  const zShot = hasShots ? robustZ(shotRate) : zAudio.map(() => 0);

  let combined = zAudio.map((za, i) =>
    hasShots
      ? 0.6 * Math.min(za, 4) + 0.4 * Math.min(zShot[i], 4)
      : Math.min(za, 4)
  );
  combined = smooth(combined, 2);

  // 5. Loại bỏ 3% đầu phim và 3% cuối phim (intro / ending credits)
  const edgeSec = Math.floor(totalSec * edgeFrac);
  for (let i = 0; i < totalSec; i++) {
    if (i < edgeSec || i >= totalSec - edgeSec) {
      combined[i] = -99;
    }
  }

  // 6. Xác định ngưỡng phân vị thứ 85% và gộp các đoạn cao trào cách nhau <= 3s
  const validScores = combined.filter((v) => v > -99);
  const sortedValid = [...validScores].sort((a, b) => a - b);
  const threshold = sortedValid[Math.floor(sortedValid.length * pct)] || 0;

  const mergedSpans = [];
  let cur = null;
  for (let sec = 0; sec < totalSec; sec++) {
    if (combined[sec] >= threshold) {
      if (cur && sec - cur.e <= mergeGapSec) {
        cur.e = sec + 1;
      } else {
        if (cur) mergedSpans.push(cur);
        cur = { s: sec, e: sec + 1 };
      }
    }
  }
  if (cur) mergedSpans.push(cur);

  // 7. Lọc độ dài [minSec, maxSec] và tính điểm trung bình top 50% giây cao nhất
  const candidates = [];
  for (const span of mergedSpans) {
    if (span.e - span.s < minSec) continue;
    for (let s = span.s; s < span.e; s += maxSec) {
      const e = Math.min(span.e, s + maxSec);
      if (e - s < minSec) continue;

      const sliceScores = combined.slice(s, e);
      const topHalf = [...sliceScores]
        .sort((a, b) => b - a)
        .slice(0, Math.max(1, Math.ceil(sliceScores.length / 2)));

      let peakSec = s;
      for (let k = s; k < e; k++) {
        if (combined[k] > combined[peakSec]) peakSec = k;
      }

      const avgDialog =
        dialogSecFrac.slice(s, e).reduce((acc, v) => acc + v, 0) / (e - s);
      const avgScore =
        topHalf.reduce((acc, v) => acc + v, 0) / topHalf.length;

      candidates.push({
        startUs: s * 1000000,
        endUs: e * 1000000,
        score: +avgScore.toFixed(3),
        peakUs: peakSec * 1000000,
        dialogFrac: +avgDialog.toFixed(2)
      });
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .sort((a, b) => a.startUs - b.startUs);
}

/**
 * Chèn nhãn CẢNH CAO TRÀO vào danh sách phụ đề cho những đoạn hành động/cảm xúc ít lời thoại
 */
function injectHighlightMarkers(srtCues, highlights, maxDialogFrac = 0.35) {
  const markers = (highlights || [])
    .filter((h) => h.dialogFrac < maxDialogFrac)
    .map((h) => ({
      startUs: h.startUs,
      endUs: h.endUs,
      highlight: true,
      text: "【CẢNH CAO TRÀO: hành động / cảm xúc dồn dập, không có lời thoại — đoán diễn biến từ thoại ngay trước và sau】"
    }));

  const merged = [
    ...(srtCues || []).map((c) => ({ ...c })),
    ...markers
  ].sort((a, b) => a.startUs - b.startUs || (a.highlight ? -1 : 1));

  merged.forEach((cue, i) => {
    cue.index = i + 1;
  });

  return {
    cues: merged,
    added: markers.length
  };
}

/**
 * Tự động nhặt các mảnh cắt ngắn (1.6s) quanh đỉnh cao trào để tạo 15s Hook mở đầu
 */
function pickHookClips(highlights, opt = {}) {
  const hookUs = Math.round((opt.hookSec || 15) * 1000000);
  const clipUs = Math.round((opt.clipSec || 1.6) * 1000000);
  const movieStartUs = opt.movieStartUs || 0;
  const movieEndUs = opt.movieEndUs || Infinity;
  const noSpoiler = opt.noSpoiler !== false;

  const spoilerCutoffUs =
    noSpoiler && isFinite(movieEndUs)
      ? movieStartUs + 0.85 * (movieEndUs - movieStartUs)
      : Infinity;

  const pool = (highlights || [])
    .filter((h) => h.endUs <= spoilerCutoffUs)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  let accUs = 0;

  for (let pass = 0; pass < 3 && accUs < hookUs; pass++) {
    for (const h of pool) {
      if (accUs >= hookUs) break;
      const durUs = Math.min(clipUs, hookUs - accUs);
      if (durUs < 1000000) break;

      const offset =
        pass === 0
          ? -durUs / 2
          : pass === 1
          ? durUs * 1.5
          : -durUs * 2.5;

      const startUs = Math.round(
        Math.max(h.startUs, Math.min(h.endUs - durUs, h.peakUs + offset))
      );

      const overlaps = selected.some(
        (item) =>
          startUs < item.startUs + item.durUs &&
          item.startUs < startUs + durUs
      );
      if (overlaps) continue;

      selected.push({ startUs, durUs });
      accUs += durUs;
    }
  }

  return selected.sort((a, b) => a.startUs - b.startUs);
}

/**
 * Tính tỷ lệ đoạn [startUs, endUs] nằm trong các vùng cao trào [0, 1]
 */
function highlightCover(highlights, startUs, endUs) {
  if (!highlights || !highlights.length || endUs <= startUs) return 0;
  let overlap = 0;
  for (const h of highlights) {
    const d = Math.min(endUs, h.endUs) - Math.max(startUs, h.startUs);
    if (d > 0) overlap += d;
  }
  return Math.min(1, overlap / (endUs - startUs));
}

module.exports = {
  parseRmsLog,
  median,
  robustZ,
  smooth,
  detectHighlights,
  injectHighlightMarkers,
  pickHookClips,
  highlightCover
};
