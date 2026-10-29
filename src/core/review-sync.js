"use strict";

const { highlightCover } = require("./highlight-core");

/**
 * Tạo hàm sinh số giả ngẫu nhiên xác định (FNV-1a + LCG)
 * @param {number|string} seedInput
 */
function createSeededRng(seedInput) {
  if (seedInput == null || seedInput === "") {
    return () => Math.random();
  }
  let state = 2166136261 >>> 0;
  const str = String(seedInput);
  for (let i = 0; i < str.length; i++) {
    state ^= str.charCodeAt(i);
    state = Math.imul(state, 16777619) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * THUẬT TOÁN BEAM-SEARCH CẮT CẢNH & KHỚP LỜI BÌNH (computeTimeline)
 *
 * @param {Array} cues - Danh sách các câu kịch bản:
 *   [{ index, text, ttsDurationUs, audioPath, audioSrcStartUs, startUs, endUs, clipStartUs, clipEndUs }]
 * @param {Object} videoInfo - Thông số video gốc:
 *   { durationUs, movieStartUs, movieEndUs, width, height, fps, timebase, ntsc, path }
 * @param {Object} opts - Tùy chọn thuật toán
 */
function computeTimeline(cues, videoInfo = {}, opts = {}) {
  const movieStartUs = Number(videoInfo.movieStartUs) || 0;
  const movieEndUs = Math.max(
    movieStartUs + 1000000,
    Number(videoInfo.movieEndUs || videoInfo.durationUs) || 3600000000
  );
  const movieSpanUs = Math.max(1, movieEndUs - movieStartUs);

  // Phát hiện giọng đọc liền mạch (Contiguous External Voice):
  // Nếu tất cả các câu trỏ tới cùng 1 file audio và nối tiếp nhau <= 2ms thì ép gapUs = 0
  let contiguousVoice = Boolean(opts.contiguousVoice);
  if (opts.contiguousVoice === undefined && Array.isArray(cues) && cues.length > 1) {
    const firstPath = cues[0] && cues[0].audioPath;
    if (firstPath && cues.every((c) => c.audioPath === firstPath && c.audioSrcStartUs != null)) {
      contiguousVoice = cues.every((c, idx) => {
        if (idx === 0) return true;
        const prevEnd = cues[idx - 1].audioSrcStartUs + (cues[idx - 1].ttsDurationUs || 0);
        return Math.abs(c.audioSrcStartUs - prevEnd) <= 2000;
      });
    }
  }

  const gapUs = contiguousVoice
    ? 0
    : opts.gapUs != null
    ? Math.round(Number(opts.gapUs))
    : 120000; // Mặc định 0.12s

  const cutMinUs = Math.round((Number(opts.cutSecMin) || 2.0) * 1000000);
  const cutMaxUs = Math.round(
    Math.max(cutMinUs, (Number(opts.cutSecMax) || 3.0) * 1000000)
  );
  const minCutsPerCue = Math.max(1, Math.round(Number(opts.minCutsPerCue) || 2));
  const maxCutsPerCue = Math.max(
    minCutsPerCue,
    Math.round(Number(opts.maxCutsPerCue) || 3)
  );
  const maxClipUs = Math.round((Number(opts.maxClipSec) || 6.0) * 1000000);
  const minJumpUs = Math.round(
    (opts.minJumpSec != null ? Number(opts.minJumpSec) : 2.0) * 1000000
  );
  const backJumpUs = Math.round(
    (opts.backJumpSec != null ? Number(opts.backJumpSec) : 90.0) * 1000000
  );

  // Biên độ độ dài mỗi mảnh cắt hợp lệ
  const minSegUs = Math.round(
    Math.max(1200000, Math.min(cutMinUs * 0.7, maxClipUs))
  );
  const maxSegUs = Math.round(
    Math.max(minSegUs, Math.min(maxClipUs, cutMaxUs * 1.35))
  );

  const shots = Array.isArray(opts.shots)
    ? [...opts.shots].sort((a, b) => a - b)
    : [];
  const dialog = Array.isArray(opts.dialog) ? opts.dialog : [];
  const highlights = Array.isArray(opts.highlights) ? opts.highlights : [];
  const hookClips = Array.isArray(opts.hookClips) ? opts.hookClips : [];
  const rand = createSeededRng(opts.seed);

  const usedIntervals = [];

  /**
   * Kiểm tra một mốc thời gian t có nằm sát điểm cắt camera (shots) trong bán kính tol (80ms) không
   */
  function isNearShot(t, tol = 80000) {
    if (!shots.length) return false;
    let lo = 0;
    let hi = shots.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const diff = shots[mid] - t;
      if (Math.abs(diff) <= tol) return true;
      if (diff < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /**
   * BỘ LỌC CHỐNG NHÁY KHUNG HÌNH (Anti-Flash-Frame Filter):
   * Cấm cắt nếu bên trong đoạn [s, e] có điểm chuyển góc máy của phim gốc nằm sát đầu hoặc cuối clip [60ms, 600ms]
   */
  function hasInternalEdgeCut(s, e) {
    if (!shots.length) return false;
    const innerLo = s + 60000;
    const innerHi = e - 60000;
    if (innerHi <= innerLo) return false;

    const headZoneEnd = s + 600000;
    const tailZoneStart = e - 600000;

    let lo = 0;
    let hi = shots.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (shots[mid] < innerLo) lo = mid + 1;
      else hi = mid - 1;
    }

    for (let k = lo; k < shots.length && shots[k] <= innerHi; k++) {
      if (shots[k] <= headZoneEnd || shots[k] >= tailZoneStart) {
        return true;
      }
    }
    return false;
  }

  /**
   * Tỷ lệ trùng lặp của đoạn [s, e] với các đoạn video đã sử dụng ở những câu trước
   */
  function usedOverlapRatio(s, e) {
    if (e <= s || !usedIntervals.length) return 0;
    let ov = 0;
    for (const u of usedIntervals) {
      const d = Math.min(e, u.e) - Math.max(s, u.s);
      if (d > 0) ov += d;
    }
    return ov / (e - s);
  }

  /**
   * Tỷ lệ thời gian trong đoạn [s, e] có nhân vật đang thoại
   */
  function dialogOverlapRatio(s, e) {
    if (e <= s || !dialog.length) return 0;
    let ov = 0;
    for (const d of dialog) {
      const ds = d.s != null ? d.s : d.startUs;
      const de = d.e != null ? d.e : d.endUs;
      const inter = Math.min(e, de) - Math.max(s, ds);
      if (inter > 0) ov += inter;
    }
    return Math.min(1, ov / (e - s));
  }

  /**
   * Công thức chấm điểm ứng viên mảnh cắt [s, e] (9 thành phần)
   */
  function scoreCandidate(s, e, winA, winB, origStart, origEnd) {
    const len = e - s;
    const sCut = isNearShot(s) ? 1 : 0;
    const eCut = isNearShot(e) ? 1 : 0;
    const dlg = dialogOverlapRatio(s, e);
    const hl = highlightCover(highlights, s, e);

    const inWin =
      origEnd > origStart
        ? Math.max(0, Math.min(e, origEnd) - Math.max(s, origStart)) / len
        : 1;

    const durPenalty =
      len >= cutMinUs && len <= cutMaxUs
        ? 0
        : len < cutMinUs
        ? (cutMinUs - len) / cutMinUs
        : (len - cutMaxUs) / cutMaxUs;

    const usedOv = usedOverlapRatio(s, e);
    const posPenalty =
      winB > winA ? Math.max(0, s - winA) / (winB - winA) : 0;

    return (
      2.0 * sCut +
      1.0 * eCut +
      1.5 * dlg +
      2.0 * hl +
      4.0 * inWin -
      0.8 * durPenalty -
      16.0 * usedOv -
      0.6 * posPenalty +
      rand() * 0.25
    );
  }

  /**
   * Kiểm tra quy tắc chuyển tiếp giữa mảnh trước (prevEnd, prevRun) và mảnh tiếp theo (s, len)
   */
  function canTransition(prevEnd, prevRun, s, len, relax) {
    if (prevEnd === null) {
      return { ok: true, run: len };
    }
    if (s < prevEnd) {
      return { ok: false, run: 0 };
    }
    const gap = s - prevEnd;

    // 1. Nối tiếp sát nhau (<= 0.15s) miễn là tổng thời gian chạy liên tục <= maxClipUs (6s)
    if (gap <= 150000) {
      const nextRun = prevRun + gap + len;
      return { ok: nextRun <= maxClipUs, run: nextRun };
    }

    // 2. Cả 2 điểm đều là cú cắt camera gần nhau (<= 1.5s) và tổng thời gian <= maxClipUs
    if (gap < minJumpUs) {
      if (
        shots.length &&
        isNearShot(prevEnd) &&
        isNearShot(s) &&
        gap <= 1500000 &&
        prevRun + len <= maxClipUs
      ) {
        return { ok: true, run: prevRun + len };
      }
      if (relax > 0 && gap >= minJumpUs * 0.5) {
        return { ok: true, run: len };
      }
      return { ok: false, run: 0 };
    }

    // 3. Nhảy cảnh rõ ràng (>= 2.0s) -> reset bộ đếm chạy liên tục
    return { ok: true, run: len };
  }

  /**
   * Giải thuật Beam Search (beamWidth = 48) tìm tổ hợp mảnh cắt tối ưu cho 1 câu lời bình
   */
  function solveCueBeamSearch(
    targetDurUs,
    origStartUs,
    origEndUs,
    prevCueEndUs,
    prevCueRunUs,
    relax
  ) {
    const origSpan = Math.max(cutMaxUs, origEndUs - origStartUs);
    const pad =
      relax === 0
        ? 0
        : relax === 1
        ? Math.max(origSpan, 15000000)
        : Math.max(origSpan * 3, 60000000);

    let winA = Math.max(movieStartUs, origStartUs - pad);
    let winB = Math.min(movieEndUs, origEndUs + pad);

    if (prevCueEndUs !== null && backJumpUs < Infinity) {
      const floorByBackJump = prevCueEndUs - backJumpUs;
      if (floorByBackJump > winA && floorByBackJump + minSegUs < winB) {
        winA = floorByBackJump;
      }
    }
    if (winB - winA < minSegUs) {
      winA = Math.max(movieStartUs, origStartUs - 30000000);
      winB = Math.min(movieEndUs, winA + 60000000);
    }

    const minK = Math.max(
      1,
      Math.min(
        maxCutsPerCue,
        Math.max(minCutsPerCue, Math.floor(targetDurUs / maxSegUs))
      )
    );
    const maxK = Math.max(
      minK,
      Math.min(maxCutsPerCue, Math.ceil(targetDurUs / minSegUs))
    );

    const lowSum = targetDurUs * (relax === 2 ? 0.8 : 0.9);
    const highSum = targetDurUs * (relax === 2 ? 1.25 : 1.1);

    // Tập hợp các điểm bắt đầu ứng viên s
    const startSet = new Set();
    startSet.add(Math.round(winA));
    for (const sh of shots) {
      if (sh >= winA && sh <= winB - minSegUs) {
        startSet.add(Math.round(sh));
      }
    }
    for (const hl of highlights) {
      if (hl.startUs >= winA && hl.startUs <= winB - minSegUs) {
        startSet.add(Math.round(hl.startUs));
      }
    }
    const gridStep = shots.length ? 1000000 : 500000;
    const maxStarts = 220;
    const step = Math.max(
      gridStep,
      Math.ceil((winB - winA) / maxStarts)
    );
    for (let t = winA; t <= winB - minSegUs; t += step) {
      startSet.add(Math.round(t));
    }

    const starts = [...startSet].sort((a, b) => a - b);
    const canonicalLens = [
      minSegUs,
      Math.round((cutMinUs + cutMaxUs) / 2),
      cutMaxUs,
      maxSegUs
    ];

    const candidates = [];
    for (const s of starts) {
      const endSet = new Set();
      for (const sh of shots) {
        if (sh >= s + minSegUs && sh <= s + maxSegUs && sh <= winB) {
          endSet.add(Math.round(sh));
        }
      }
      for (const len of canonicalLens) {
        const e = s + len;
        if (e <= winB && e - s >= minSegUs && e - s <= maxSegUs) {
          endSet.add(Math.round(e));
        }
      }
      for (const e of endSet) {
        if (relax < 2 && hasInternalEdgeCut(s, e)) continue;
        if (relax < 2 && usedOverlapRatio(s, e) > 0.02) continue;
        candidates.push({
          s,
          e,
          len: e - s,
          sc: scoreCandidate(s, e, winA, winB, origStartUs, origEndUs)
        });
      }
    }

    if (!candidates.length) return null;

    const beamWidth = 48;
    let beam = [
      {
        segs: [],
        end: prevCueEndUs,
        run: prevCueRunUs,
        sum: 0,
        score: 0
      }
    ];
    let bestSolution = null;

    const cutPenalty = (k) =>
      k < minCutsPerCue
        ? (minCutsPerCue - k) * 2.5
        : k > maxCutsPerCue
        ? (k - maxCutsPerCue) * 2.5
        : 0;

    for (let stepIdx = 0; stepIdx < maxK; stepIdx++) {
      const nextBeam = [];
      for (const state of beam) {
        for (const cand of candidates) {
          if (state.sum + cand.len > highSum) continue;
          const tr = canTransition(state.end, state.run, cand.s, cand.len, relax);
          if (!tr.ok) continue;

          const nextState = {
            segs: [...state.segs, cand],
            end: cand.e,
            run: tr.run,
            sum: state.sum + cand.len,
            score: state.score + cand.sc
          };

          const k = nextState.segs.length;
          if (k >= minK && nextState.sum >= lowSum && nextState.sum <= highSum) {
            const tot =
              nextState.score -
              cutPenalty(k) -
              (Math.abs(nextState.sum - targetDurUs) / targetDurUs) * 4.0;
            if (!bestSolution || tot > bestSolution.tot) {
              bestSolution = { ...nextState, tot };
            }
          }

          if (k < maxK) {
            nextBeam.push(nextState);
          }
        }
      }

      if (!nextBeam.length) break;
      nextBeam.sort(
        (a, b) =>
          b.score / Math.max(0.3, b.sum / targetDurUs) -
          a.score / Math.max(0.3, a.sum / targetDurUs)
      );
      beam = nextBeam.slice(0, beamWidth);
    }

    return bestSolution;
  }

  // Bắt đầu lắp ráp Timeline tổng
  const pieces = [];
  const cuePlacements = [];
  let timelineCursorUs = 0;
  let prevEndUs = null;
  let prevRunUs = 0;
  let relax1Count = 0;
  let relax2Count = 0;
  let fallbackCount = 0;

  // 1. Chèn các clip Hook mở đầu (nếu có)
  for (const hk of hookClips) {
    const s = Math.max(
      movieStartUs,
      Math.min(movieEndUs - 500000, Math.round(hk.startUs || 0))
    );
    const dur = Math.max(
      500000,
      Math.min(movieEndUs - s, Math.round(hk.durUs || 1600000))
    );
    pieces.push({
      srcStart: s,
      srcDur: dur,
      dstStart: timelineCursorUs,
      dstDur: dur,
      speed: 1.0,
      cueIndex: -1,
      isHook: true
    });
    usedIntervals.push({ s, e: s + dur });
    timelineCursorUs += dur;
  }

  // 2. Giải Beam Search cho từng câu lời bình
  for (let i = 0; i < (cues || []).length; i++) {
    const cue = cues[i];
    const ttsDurUs = Math.max(
      800000,
      Math.round(Number(cue.ttsDurationUs || cue.durationUs) || 3500000)
    );
    const targetDurUs = ttsDurUs + gapUs;

    const origStartUs =
      cue.clipStartUs != null
        ? cue.clipStartUs
        : cue.startUs != null
        ? cue.startUs
        : movieStartUs + Math.round((i / Math.max(1, cues.length)) * movieSpanUs);

    const origEndUs =
      cue.clipEndUs != null
        ? cue.clipEndUs
        : cue.endUs != null && cue.endUs > origStartUs
        ? cue.endUs
        : Math.min(movieEndUs, origStartUs + Math.max(targetDurUs * 2, 10000000));

    let sol = null;
    let usedRelax = 0;
    for (let r = 0; r <= 2; r++) {
      sol = solveCueBeamSearch(
        targetDurUs,
        origStartUs,
        origEndUs,
        prevEndUs,
        prevRunUs,
        r
      );
      if (sol) {
        usedRelax = r;
        break;
      }
    }

    if (usedRelax === 1) relax1Count++;
    if (usedRelax === 2) relax2Count++;

    let chosenSegs;
    if (sol && sol.segs.length) {
      chosenSegs = sol.segs;
      prevEndUs = sol.end;
      prevRunUs = sol.run;
    } else {
      // Fallback an toàn nếu cửa sổ quá hẹp: chia thành k mảnh không vượt maxClipUs
      fallbackCount++;
      const k = Math.max(1, Math.ceil(targetDurUs / maxClipUs));
      const segLen = Math.min(maxClipUs, Math.round(targetDurUs / k));
      const jump = Math.max(minJumpUs, Math.round(segLen * 0.5));
      chosenSegs = [];
      let curS = Math.max(
        movieStartUs,
        Math.min(movieEndUs - segLen, origStartUs)
      );
      for (let m = 0; m < k; m++) {
        if (curS + segLen > movieEndUs) {
          curS = Math.max(movieStartUs, movieEndUs - segLen);
        }
        chosenSegs.push({ s: curS, e: curS + segLen, len: segLen });
        curS += segLen + jump;
      }
      prevEndUs = chosenSegs[chosenSegs.length - 1].e;
      prevRunUs = segLen;
    }

    const totalSrcDur =
      chosenSegs.reduce((acc, sg) => acc + sg.len, 0) || targetDurUs;
    const cueStartOnTimelineUs = timelineCursorUs;
    let accDstDur = 0;

    chosenSegs.forEach((sg, idx) => {
      const isLast = idx === chosenSegs.length - 1;
      const dstDur = isLast
        ? Math.max(1, targetDurUs - accDstDur)
        : Math.max(1, Math.round((targetDurUs * sg.len) / totalSrcDur));
      const speed = +(sg.len / dstDur).toFixed(4);

      pieces.push({
        pieceIndex: pieces.length + 1,
        cueIndex: i,
        cueNumber: cue.index || i + 1,
        srcStart: Math.round(sg.s),
        srcDur: Math.round(sg.len),
        dstStart: timelineCursorUs + accDstDur,
        dstDur,
        speed,
        isHook: false
      });

      usedIntervals.push({ s: sg.s, e: sg.e });
      accDstDur += dstDur;
    });

    cuePlacements.push({
      cueIndex: i,
      index: cue.index || i + 1,
      text: String(cue.text || cue.narration || "").trim(),
      newStart: cueStartOnTimelineUs,
      newEnd: cueStartOnTimelineUs + ttsDurUs,
      slotDurationUs: targetDurUs,
      ttsDurationUs: ttsDurUs,
      audioPath: cue.audioPath || null,
      audioSrcStartUs: cue.audioSrcStartUs != null ? cue.audioSrcStartUs : 0,
      origStartUs,
      origEndUs,
      cutCount: chosenSegs.length,
      relaxLevel: usedRelax
    });

    timelineCursorUs += targetDurUs;
  }

  const totalSourceUsedUs = pieces.reduce((acc, p) => acc + p.srcDur, 0);
  const usedMovieRatioPct = +((totalSourceUsedUs / movieSpanUs) * 100).toFixed(2);

  return {
    pieces,
    cuePlacements,
    totalTimelineUs: timelineCursorUs,
    contiguousVoice,
    stats: {
      totalCues: (cues || []).length,
      totalPieces: pieces.length,
      hookPieces: hookClips.length,
      avgCutsPerCue: cues && cues.length
        ? +((pieces.length - hookClips.length) / cues.length).toFixed(2)
        : 0,
      relax1Count,
      relax2Count,
      fallbackCount,
      totalTimelineSec: +(timelineCursorUs / 1000000).toFixed(2),
      usedMovieRatioPct
    }
  };
}

module.exports = {
  createSeededRng,
  computeTimeline
};
