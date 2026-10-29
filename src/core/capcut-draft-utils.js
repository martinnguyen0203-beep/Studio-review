"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PER_SEGMENT_ARRAYS = new Set([
  "speeds",
  "sound_channel_mappings",
  "vocal_separations",
  "placeholder_infos",
  "beats"
]);

const AC_TRACK_NAME = "AutoCapCut";
const AC_COVER_TRACK_NAME = "AutoCapCut Che";
const AC_WM_TRACK_NAME = "AutoCapCut WM";
const BLUR_EFFECT_ID = "7399464929830423813";
const MASK_RECT_RESOURCE_ID = "7374021450748924432";

/**
 * Tạo UUID v4 viết hoa chuẩn CapCut
 */
function uuid() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().toUpperCase();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
    .replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    })
    .toUpperCase();
}

/**
 * Sao chép sâu (Deep Clone)
 */
const deep =
  typeof structuredClone === "function"
    ? (obj) => structuredClone(obj)
    : (obj) => JSON.parse(JSON.stringify(obj));

/**
 * Tự động dò đường dẫn font mặc định của CapCut trên Windows
 */
let cachedFontPath;
function resolveCapCutFontPath() {
  if (cachedFontPath !== undefined) return cachedFontPath;
  cachedFontPath = "";
  try {
    const appsDir = path.join(process.env.LOCALAPPDATA || "", "CapCut", "Apps");
    const candidates = fs
      .readdirSync(appsDir)
      .map((ver) =>
        path.join(appsDir, ver, "Resources", "Font", "SystemFont", "en.ttf")
      )
      .filter((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch (_) {
          return false;
        }
      })
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (candidates.length) {
      cachedFontPath = candidates[0].replace(/\\/g, "/");
    }
  } catch (_) {}
  return cachedFontPath;
}

/**
 * Sửa đường dẫn font bị thiếu trong text material của CapCut
 */
function fixTemplateFont(textMat) {
  if (!textMat) return textMat;
  const fallbackFont = resolveCapCutFontPath();
  const isMissing = (p) => {
    if (typeof p !== "string" || !p) return false;
    try {
      return !fs.existsSync(p);
    } catch (_) {
      return true;
    }
  };

  if (isMissing(textMat.font_path)) {
    textMat.font_path = fallbackFont;
  }
  try {
    const parsed = JSON.parse(textMat.content);
    if (Array.isArray(parsed.styles)) {
      for (const st of parsed.styles) {
        if (st && st.font && isMissing(st.font.path)) {
          st.font.path = fallbackFont;
        }
      }
    }
    textMat.content = JSON.stringify(parsed);
  } catch (_) {}
  return textMat;
}

/**
 * Xây dựng bảng chỉ mục tra cứu nhanh cho toàn bộ `draft.materials`
 */
function buildMaterialIndex(materials) {
  const index = {};
  for (const [arrName, list] of Object.entries(materials || {})) {
    if (!Array.isArray(list)) continue;
    list.forEach((mat, i) => {
      if (mat && mat.id) {
        index[String(mat.id).toUpperCase()] = { arr: arrName, i, mat };
      }
    });
  }
  return index;
}

/**
 * Tạo đối tượng Keyframe chuẩn CapCut
 */
function makeKeyframe(propertyType, points) {
  return {
    id: uuid(),
    property_type: propertyType,
    material_id: "",
    keyframe_list: (points || []).map((pt) => ({
      id: uuid(),
      curveType: "Line",
      graphID: "",
      left_control: { x: 0, y: 0 },
      right_control: { x: 0, y: 0 },
      string_value: "",
      time_offset: Math.round(pt.t),
      values: [pt.v]
    }))
  };
}

/**
 * Tạo Track Hiệu ứng Làm mờ Phụ đề Gốc (buildBlurEffectTrack)
 */
function buildBlurEffectTrack(draft, coverCfg, totalDurationUs) {
  const effectId = coverCfg.effectId || BLUR_EFFECT_ID;
  const maskResId = coverCfg.maskResourceId || MASK_RECT_RESOURCE_ID;
  const strength = coverCfg.strength != null ? coverCfg.strength : 1;

  const masks = (coverCfg.rects || []).map((r) => ({
    id: uuid(),
    type: "video_effect",
    category: "effect",
    category_name: "",
    category_id: "",
    panel: "",
    is_old_version: false,
    resource_id: maskResId,
    constant_material_id: uuid(),
    name: "Rectangle",
    resource_type: "rectangle",
    path: coverCfg.maskPath || "",
    position_info: "",
    config: {
      width: r.w,
      height: r.h,
      centerX: r.cx,
      centerY: r.cy,
      rotation: 0,
      feather: r.feather != null ? r.feather : 0.01,
      expansion: 0,
      roundCorner: r.round != null ? r.round : 0,
      invert: false,
      aspectRatio: 1
    },
    text_config: {
      content: "",
      font_name: "",
      font_path: "",
      font_resource_id: "",
      font_size: 15,
      bold_width: 0,
      italic_degree: 0,
      has_underline: false,
      line_gap: 0,
      char_spacing: 0,
      align_type: 15,
      scale: 1
    },
    platform: "all",
    loader_work_space: "",
    track_segment: "",
    contour_path: null,
    source_platform: 0
  }));

  const effectMat = {
    adjust_params: [
      {
        name: "effects_adjust_blur",
        value: strength,
        default_value: 0.5
      }
    ],
    aigc_current_artifact_cnt: 0,
    aigc_current_artifact_path: "",
    algorithm_artifact_path: "",
    apply_target_type: 2,
    apply_time_range: null,
    bind_segment_id: "",
    category_id: "1111",
    category_name: "Video effects",
    common_keyframes: [],
    covering_relation_change: 0,
    disable_effect_faces: [],
    effect_id: effectId,
    effect_mask: masks,
    enable_mask: true,
    enable_video_mask_shadow: true,
    enable_video_mask_stroke: true,
    formula_id: "",
    id: uuid(),
    item_effect_type: 0,
    name: "Blur",
    path: coverCfg.effectPath || "",
    platform: "all",
    render_index: 0,
    request_id: "",
    resource_id: effectId,
    source_platform: 1,
    sub_type: 0,
    time_range: null,
    track_render_index: 0,
    transparent_params: "",
    type: "video_effect",
    value: strength,
    version: ""
  };

  if (!draft.materials.video_effects) {
    draft.materials.video_effects = [];
  }
  draft.materials.video_effects.push(effectMat);

  let maxRenderIdx = 0;
  for (const tr of draft.tracks || []) {
    if (!tr || tr.type !== "video") continue;
    for (const seg of tr.segments || []) {
      const idx = Number(seg.render_index);
      if (Number.isFinite(idx)) maxRenderIdx = Math.max(maxRenderIdx, idx);
    }
  }

  const effectSeg = {
    id: uuid(),
    source_timerange: null,
    target_timerange: { start: 0, duration: totalDurationUs },
    render_timerange: { start: 0, duration: 0 },
    desc: "",
    state: 0,
    speed: 1,
    is_loop: false,
    is_tone_modify: false,
    reverse: false,
    intensifies_audio: false,
    cartoon: false,
    volume: 1,
    last_nonzero_volume: 1,
    clip: null,
    uniform_scale: null,
    material_id: effectMat.id,
    extra_material_refs: [],
    render_index: maxRenderIdx + 1,
    keyframe_refs: [],
    enable_lut: false,
    enable_adjust: false,
    enable_hsl: false,
    visible: true,
    group_id: "",
    enable_color_curves: true,
    enable_hsl_curves: true,
    track_render_index: 1,
    hdr_settings: null,
    enable_color_wheels: true,
    track_attribute: 0,
    is_placeholder: false,
    template_id: "",
    enable_smart_color_adjust: false,
    template_scene: "default",
    common_keyframes: [],
    caption_info: null,
    responsive_layout: {
      enable: false,
      target_follow: "",
      size_layout: 0,
      horizontal_pos_layout: 0,
      vertical_pos_layout: 0
    },
    enable_color_match_adjust: false,
    enable_color_correct_adjust: false,
    enable_adjust_mask: false,
    raw_segment_id: "",
    lyric_keyframes: null,
    enable_video_mask: true,
    digital_human_template_group_id: "",
    color_correct_alg_result: "",
    source: "segmentsourcenormal",
    enable_mask_stroke: false,
    enable_mask_shadow: false,
    enable_color_adjust_pro: false
  };

  return {
    attribute: 0,
    flag: 0,
    id: uuid(),
    is_default_name: false,
    name: AC_COVER_TRACK_NAME,
    segments: [effectSeg],
    type: "effect"
  };
}

/**
 * Tạo Track Watermark chạy quanh màn hình bằng Keyframe (buildWatermark)
 */
function buildWatermark(draft, baseTextMat, baseTextSeg, totalDurationUs, wmCfg) {
  if (!wmCfg || !wmCfg.text) return false;
  const textMat = deep(baseTextMat);
  textMat.id = uuid();
  textMat.type = "text";
  fixTemplateFont(textMat);

  let contentObj;
  try {
    contentObj = JSON.parse(textMat.content);
  } catch (_) {
    contentObj = {
      text: wmCfg.text,
      styles: [{ fill: { content: { solid: { color: [1, 1, 1] } } }, range: [0, wmCfg.text.length], size: 5 }]
    };
  }

  contentObj.text = wmCfg.text;
  if (Array.isArray(contentObj.styles)) {
    contentObj.styles.forEach((st) => {
      st.range = [0, wmCfg.text.length];
      if (st.fill && st.fill.content && st.fill.content.solid) {
        st.fill.content.solid.color = wmCfg.color || [1, 1, 1];
      }
      if (st.size) {
        st.size = st.size * (wmCfg.sizeScale || 0.6);
      }
    });
  }
  textMat.content = JSON.stringify(contentObj);
  textMat.global_alpha = wmCfg.alpha != null ? wmCfg.alpha : 0.7;
  textMat.text_to_audio_ids = [];
  draft.materials.texts.push(textMat);

  const seg = deep(baseTextSeg);
  seg.id = uuid();
  seg.material_id = textMat.id;
  seg.target_timerange = { start: 0, duration: totalDurationUs };
  seg.source_timerange = null;
  seg.extra_material_refs = [];
  seg.clip = seg.clip || {};
  seg.clip.transform = { x: 0.7, y: 0.85 };
  seg.clip.alpha = 1;

  const cycleUs = (wmCfg.cycleSec || 25) * 1000000;
  const waypoints = [
    { x: 0.7, y: 0.85 },
    { x: -0.7, y: 0.8 },
    { x: -0.65, y: -0.8 },
    { x: 0.65, y: -0.85 },
    { x: 0, y: 0 },
    { x: 0.7, y: 0.85 }
  ];

  const kfx = [];
  const kfy = [];
  let t = 0;
  const stepUs = cycleUs / (waypoints.length - 1);

  while (t < totalDurationUs) {
    for (let i = 0; i < waypoints.length && t < totalDurationUs; i++) {
      kfx.push({ t, v: waypoints[i].x });
      kfy.push({ t, v: waypoints[i].y });
      t += stepUs;
    }
  }
  kfx.push({ t: totalDurationUs, v: waypoints[0].x });
  kfy.push({ t: totalDurationUs, v: waypoints[0].y });

  seg.common_keyframes = [
    makeKeyframe("KFTypePositionX", kfx),
    makeKeyframe("KFTypePositionY", kfy)
  ];

  draft.tracks.push({
    attribute: 0,
    flag: 0,
    id: uuid(),
    is_default_name: false,
    name: AC_WM_TRACK_NAME,
    segments: [seg],
    type: "text"
  });
  return true;
}

/**
 * Xác định đường dẫn thực tế tới file `draft_content.json` từ đường dẫn thư mục hoặc file
 */
function resolveDraftJsonPath(draftPathInput) {
  const abs = path.resolve(String(draftPathInput || ""));
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    const candidate = path.join(abs, "draft_content.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return abs;
  }
  throw new Error(`Không tìm thấy draft_content.json tại: ${abs}`);
}

/**
 * Tạo bản sao lưu (backup) trước khi ghi đè draft_content.json
 */
function writeDraftWithBackup(draftJsonPath, draftObj) {
  const backupPath = `${draftJsonPath}.autostudio.bak`;
  if (fs.existsSync(draftJsonPath) && !fs.existsSync(backupPath)) {
    fs.copyFileSync(draftJsonPath, backupPath);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  draftObj.update_time = nowSec;
  fs.writeFileSync(draftJsonPath, JSON.stringify(draftObj), "utf8");
  return { draftJsonPath, backupPath };
}

/**
 * Trích xuất văn bản thuần từ đối tượng text material của CapCut
 */
function getTextFromMaterial(textMat) {
  if (!textMat) return "";
  try {
    const parsed = JSON.parse(textMat.content);
    if (parsed && typeof parsed.text === "string") {
      return parsed.text.trim();
    }
  } catch (_) {}
  return String(textMat.recognize_text || textMat.content || "").trim();
}

/**
 * Ghi văn bản mới vào đối tượng text material của CapCut
 */
function setTextInMaterial(textMat, newText) {
  const str = String(newText || "").trim();
  let parsed;
  try {
    parsed = JSON.parse(textMat.content);
  } catch (_) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") {
    parsed = {
      text: str,
      styles: [
        {
          fill: {
            alpha: 1,
            content: { render_type: "solid", solid: { alpha: 1, color: [1, 0.85, 0] } }
          },
          range: [0, str.length],
          size: 7,
          bold: true
        }
      ]
    };
  } else {
    parsed.text = str;
    if (Array.isArray(parsed.styles)) {
      parsed.styles.forEach((st) => {
        if (st && typeof st === "object") st.range = [0, str.length];
      });
    }
  }
  textMat.content = JSON.stringify(parsed);
  fixTemplateFont(textMat);
  return textMat;
}

/**
 * Bơm danh sách câu lời bình vào CapCut `draft_content.json`
 * Sử dụng Quy hoạch động LCS để bảo toàn `material_id` và `text_to_audio` cho các câu không đổi chữ!
 */
function injectCaptionsToCapCutDraft(draftPathInput, linesInput, opts = {}) {
  const draftJsonPath = resolveDraftJsonPath(draftPathInput);
  const draft = JSON.parse(fs.readFileSync(draftJsonPath, "utf8"));
  draft.materials = draft.materials || {};
  draft.materials.texts = draft.materials.texts || [];
  draft.materials.audios = draft.materials.audios || [];
  draft.tracks = draft.tracks || [];

  const cleanLines = (linesInput || [])
    .map((l) => (typeof l === "string" ? l.trim() : String((l && (l.text || l.narration)) || "").trim()))
    .filter(Boolean);

  if (!cleanLines.length) {
    throw new Error("Danh sách lời bình trống.");
  }

  const slotUs = Math.round((Number(opts.slotSec) || 3.0) * 1000000);
  const textMatMap = new Map(
    draft.materials.texts.map((m) => [m.id, m])
  );

  // Tìm track text hiện có (ưu tiên track có liên kết text_to_audio)
  let targetTrack = null;
  for (const tr of draft.tracks) {
    if (tr && tr.type === "text" && tr.name !== AC_WM_TRACK_NAME) {
      targetTrack = tr;
      break;
    }
  }

  const defaultTextMat = draft.materials.texts[0] || {
    id: uuid(),
    type: "text",
    content: JSON.stringify({
      text: "Sample",
      styles: [
        {
          fill: {
            alpha: 1,
            content: { render_type: "solid", solid: { alpha: 1, color: [1, 0.85, 0] } }
          },
          range: [0, 6],
          size: 7,
          bold: true
        }
      ]
    }),
    font_size: 7,
    global_alpha: 1,
    text_to_audio_ids: []
  };

  const defaultTextSeg =
    (targetTrack && targetTrack.segments && targetTrack.segments[0]) || {
      id: uuid(),
      material_id: defaultTextMat.id,
      target_timerange: { start: 0, duration: slotUs },
      source_timerange: null,
      speed: 1,
      volume: 1,
      extra_material_refs: [],
      clip: {
        alpha: 1,
        flip: { horizontal: false, vertical: false },
        rotation: 0,
        scale: { x: 1, y: 1 },
        transform: { x: 0, y: -0.78 }
      },
      common_keyframes: [],
      render_index: 14000,
      visible: true
    };

  let keptCount = 0;
  let addedCount = 0;

  if (targetTrack && Array.isArray(targetTrack.segments) && targetTrack.segments.length) {
    // QUY HOẠCH ĐỘNG EXACT LCS: Giữ nguyên segment + text_to_audio cho các câu không đổi chữ
    const oldSegs = targetTrack.segments.map((seg) => ({
      seg,
      mat: textMatMap.get(seg.material_id),
      norm: getTextFromMaterial(textMatMap.get(seg.material_id)).normalize("NFC").replace(/\s+/g, " ").trim()
    }));
    const newNorms = cleanLines.map((l) => l.normalize("NFC").replace(/\s+/g, " ").trim());

    const M = oldSegs.length;
    const N = newNorms.length;
    const dp = Array.from({ length: M + 1 }, () => new Int32Array(N + 1));

    for (let i = M - 1; i >= 0; i--) {
      for (let j = N - 1; j >= 0; j--) {
        if (oldSegs[i].norm && oldSegs[i].norm === newNorms[j]) {
          dp[i][j] = 1 + dp[i + 1][j + 1];
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const matchedOldForNew = new Array(N).fill(-1);
    const usedOldSet = new Set();
    let i = 0;
    let j = 0;
    while (i < M && j < N) {
      if (oldSegs[i].norm && oldSegs[i].norm === newNorms[j]) {
        matchedOldForNew[j] = i;
        usedOldSet.add(i);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }

    // Dọn các text material và audio TTS của những câu đã bị xóa/sửa
    const removedMatIds = new Set();
    for (let k = 0; k < M; k++) {
      if (!usedOldSet.has(k) && oldSegs[k].mat) {
        removedMatIds.add(oldSegs[k].mat.id);
      }
    }
    if (removedMatIds.size) {
      draft.materials.texts = draft.materials.texts.filter((m) => !removedMatIds.has(m.id));
    }

    const newSegments = [];
    let cursorUs = 0;

    for (let idx = 0; idx < N; idx++) {
      const oldIdx = matchedOldForNew[idx];
      if (oldIdx >= 0) {
        const keptSeg = oldSegs[oldIdx].seg;
        const dur = (keptSeg.target_timerange && keptSeg.target_timerange.duration) || slotUs;
        keptSeg.target_timerange = { start: cursorUs, duration: dur };
        newSegments.push(keptSeg);
        cursorUs += dur;
        keptCount++;
      } else {
        const newMat = setTextInMaterial(deep(defaultTextMat), cleanLines[idx]);
        newMat.id = uuid();
        newMat.text_to_audio_ids = [];
        draft.materials.texts.push(newMat);

        const newSeg = deep(defaultTextSeg);
        newSeg.id = uuid();
        newSeg.material_id = newMat.id;
        newSeg.target_timerange = { start: cursorUs, duration: slotUs };
        newSeg.extra_material_refs = [];
        newSegments.push(newSeg);
        cursorUs += slotUs;
        addedCount++;
      }
    }

    targetTrack.segments = newSegments;
  } else {
    // Bơm mới hoàn toàn
    const segments = [];
    cleanLines.forEach((line, idx) => {
      const newMat = setTextInMaterial(deep(defaultTextMat), line);
      newMat.id = uuid();
      newMat.text_to_audio_ids = [];
      draft.materials.texts.push(newMat);

      const newSeg = deep(defaultTextSeg);
      newSeg.id = uuid();
      newSeg.material_id = newMat.id;
      newSeg.target_timerange = { start: idx * slotUs, duration: slotUs };
      newSeg.extra_material_refs = [];
      segments.push(newSeg);
      addedCount++;
    });

    draft.tracks.push({
      attribute: 0,
      flag: 0,
      id: uuid(),
      is_default_name: true,
      name: "",
      segments,
      type: "text"
    });
  }

  const saved = writeDraftWithBackup(draftJsonPath, draft);
  return {
    ok: true,
    ...saved,
    totalLines: cleanLines.length,
    keptCount,
    addedCount
  };
}

/**
 * Áp dụng kết quả cắt cảnh của `computeTimeline` trực tiếp vào CapCut `draft_content.json`
 */
function applySyncToCapCutDraft(draftPathInput, timelineResult, opts = {}) {
  const draftJsonPath = resolveDraftJsonPath(draftPathInput);
  const draft = JSON.parse(fs.readFileSync(draftJsonPath, "utf8"));
  const materials = draft.materials || {};
  const matIdx = buildMaterialIndex(materials);

  const videoTrack = (draft.tracks || []).find((t) => t && t.type === "video");
  if (!videoTrack || !Array.isArray(videoTrack.segments) || !videoTrack.segments.length) {
    throw new Error("Project CapCut chưa có video gốc trên timeline.");
  }

  const templateVideoSeg = deep(videoTrack.segments[0]);
  const mainVideoMaterialId = templateVideoSeg.material_id;

  const zoom = opts.zoom != null ? Number(opts.zoom) : 1.08;
  const flip = Boolean(opts.flip);
  const volume = opts.muteOriginal
    ? 0
    : opts.originalVolume != null
    ? Math.max(0, Math.min(1, Number(opts.originalVolume) / 100))
    : 0;

  const newVideoSegments = (timelineResult.pieces || []).map((piece) => {
    const seg = deep(templateVideoSeg);
    seg.id = uuid();
    seg.material_id = mainVideoMaterialId;
    seg.source_timerange = { start: piece.srcStart, duration: piece.srcDur };
    seg.target_timerange = { start: piece.dstStart, duration: piece.dstDur };
    seg.speed = piece.speed;
    seg.volume = volume;
    seg.last_nonzero_volume = volume > 0 ? volume : 1;
    seg.common_keyframes = [];
    seg.keyframe_refs = [];

    seg.clip = seg.clip || {};
    if (zoom > 0 && Math.abs(zoom - 1) > 0.001) {
      seg.clip.scale = { x: zoom, y: zoom };
    }
    if (flip) {
      seg.clip.flip = { horizontal: true, vertical: false };
    }

    // Nhân bản riêng các bảng thuộc PER_SEGMENT_ARRAYS (đặc biệt là speeds)
    const newExtraRefs = [];
    for (const refId of templateVideoSeg.extra_material_refs || []) {
      const entry = matIdx[String(refId).toUpperCase()];
      if (entry && PER_SEGMENT_ARRAYS.has(entry.arr)) {
        const clonedMat = deep(entry.mat);
        clonedMat.id = uuid();
        if (entry.arr === "speeds") {
          clonedMat.speed = piece.speed;
          clonedMat.mode = 0;
          clonedMat.curve_speed = null;
        }
        materials[entry.arr].push(clonedMat);
        newExtraRefs.push(clonedMat.id);
      } else {
        newExtraRefs.push(refId);
      }
    }
    seg.extra_material_refs = newExtraRefs;
    return seg;
  });

  videoTrack.segments = newVideoSegments;

  // Dọn các track hiệu ứng/watermark cũ của tool trước khi thêm mới
  draft.tracks = (draft.tracks || []).filter(
    (t) => !t || (t.name !== AC_COVER_TRACK_NAME && t.name !== AC_WM_TRACK_NAME)
  );

  const totalDurUs = timelineResult.totalTimelineUs || 0;
  if (opts.coverSub && Array.isArray(opts.coverSub.rects) && opts.coverSub.rects.length) {
    let coverCfg = opts.coverSub;
    if (flip) {
      coverCfg = {
        ...coverCfg,
        rects: coverCfg.rects.map((r) => ({ ...r, cx: -(r.cx || 0) }))
      };
    }
    draft.tracks.push(buildBlurEffectTrack(draft, coverCfg, totalDurUs));
  }

  draft.duration = totalDurUs;
  const saved = writeDraftWithBackup(draftJsonPath, draft);
  return {
    ok: true,
    ...saved,
    totalSegments: newVideoSegments.length,
    durationUs: totalDurUs
  };
}

module.exports = {
  uuid,
  deep,
  PER_SEGMENT_ARRAYS,
  AC_TRACK_NAME,
  AC_COVER_TRACK_NAME,
  AC_WM_TRACK_NAME,
  BLUR_EFFECT_ID,
  MASK_RECT_RESOURCE_ID,
  resolveCapCutFontPath,
  fixTemplateFont,
  buildMaterialIndex,
  makeKeyframe,
  buildBlurEffectTrack,
  buildWatermark,
  injectCaptionsToCapCutDraft,
  applySyncToCapCutDraft
};
