"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const express = require("express");
const cors = require("cors");

const {
  loadAiSettings,
  saveAiSettings,
  upsertProvider,
  removeProvider,
  importFromCodexConfig,
  fetchAvailableModels,
  checkApiKey
} = require("./core/ai-providers");

const {
  probeVideo,
  probeAudioDurationUs,
  detectShotsAndRms
} = require("./core/ffmpeg-analyzer");

const {
  detectHighlights,
  pickHookClips
} = require("./core/highlight-core");

const {
  LANGS,
  STYLES,
  parseSrt,
  formatSrt,
  remapScriptRanges,
  generateReviewScript
} = require("./core/review-script-core");

const {
  computeTimeline
} = require("./core/review-sync");

const {
  buildPremiereXml,
  buildMasterSrt
} = require("./core/premiere-xml-builder");

const {
  injectCaptionsToCapCutDraft,
  applySyncToCapCutDraft
} = require("./core/capcut-draft-utils");

const {
  translateSubtitles,
  generateVisualPrompts
} = require("./core/translate-core");

const app = express();
const PORT = Number(process.env.PORT) || 3456;

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ============================================================================
// 0. HỘP THOẠI CHỌN FILE / THƯ MỤC BẢN ĐỊA WINDOWS (NATIVE FILE/FOLDER PICKER)
// ============================================================================

const NATIVE_PICKER_EXE = path.join(__dirname, "..", "bin", "filepicker.exe");

function normalizeFileCompareName(str) {
  if (!str) return "";
  return String(str).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Tự động tìm đường dẫn thực tế của file trên các ổ đĩa nếu người dùng chỉ nhập tên file hoặc đường dẫn tương đối
 */
function resolveMediaPath(inputPath, hintDir = "") {
  if (!inputPath || typeof inputPath !== "string") return "";
  let clean = inputPath.trim().replace(/^["']|["']$/g, "");
  if (!clean) return "";

  // 1. Kiểm tra trực tiếp đường dẫn
  if (fs.existsSync(clean)) return path.resolve(clean);
  const resolved = path.resolve(clean);
  if (fs.existsSync(resolved)) return resolved;

  const baseName = path.basename(clean);
  const normTarget = normalizeFileCompareName(baseName);

  // 2. Nếu có thư mục gợi ý (ví dụ video nằm ở đâu thì tìm srt/voice ở đó trước)
  if (hintDir && typeof hintDir === "string") {
    let validHint = "";
    try {
      if (fs.existsSync(hintDir)) {
        validHint = fs.statSync(hintDir).isDirectory() ? hintDir : path.dirname(hintDir);
      } else {
        const parent = path.dirname(hintDir);
        if (fs.existsSync(parent)) validHint = parent;
      }
    } catch (_) {}

    if (validHint) {
      try {
        const hintFiles = fs.readdirSync(validHint);
        for (const f of hintFiles) {
          if (normalizeFileCompareName(f) === normTarget) {
            return path.resolve(path.join(validHint, f));
          }
        }
      } catch (_) {}
    }
  }

  // 3. Quét các thư mục lưu trữ media phổ biến qua Breadth-First Search (BFS)
  const searchRoots = [
    "Y:/9 DOWNLOAD NETFLIX",
    "D:/9 Raw",
    "D:/12 Project Review Phim",
    "E:/1 Huy/8 OBSIDIAN/auto edit",
    "Z:/2 Review Phim",
    "Y:/",
    "E:/",
    "Z:/",
    "D:/",
    "C:/Users/Admin/Downloads",
    "C:/Users/Admin/Desktop",
    "C:/Users/Admin/Videos",
    "O:/"
  ];

  const skipDirs = new Set([
    "node_modules", ".git", "$recycle.bin", "system volume information",
    "windows", "appdata", "program files", "program files (x86)", ".fseventsd"
  ]);

  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    const queue = [[root, 0]];
    while (queue.length > 0) {
      const [currentDir, depth] = queue.shift();
      if (depth > 4) continue;
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            if (normalizeFileCompareName(entry.name) === normTarget) {
              return path.resolve(path.join(currentDir, entry.name));
            }
          } else if (entry.isDirectory()) {
            const lower = entry.name.toLowerCase();
            if (!skipDirs.has(lower) && !entry.name.startsWith(".")) {
              queue.push([path.join(currentDir, entry.name), depth + 1]);
            }
          }
        }
      } catch (_) {}
    }
  }

  return resolved;
}

/**
 * Tự động tìm file phụ đề .srt tương ứng trong cùng thư mục với video
 */
function findMatchingSrt(videoPath) {
  if (!videoPath) return null;
  const resolvedVideo = resolveMediaPath(videoPath);
  if (!resolvedVideo || !fs.existsSync(resolvedVideo)) return null;

  const vDir = path.dirname(resolvedVideo);
  const vBase = path.parse(resolvedVideo).name;
  const normVBase = normalizeFileCompareName(vBase);

  try {
    const files = fs.readdirSync(vDir);
    const srtCandidates = files.filter((f) => f.toLowerCase().endsWith(".srt"));
    if (!srtCandidates.length) return null;

    let best = srtCandidates.find((f) => {
      const nf = normalizeFileCompareName(f);
      return nf.includes(normVBase) && (nf.includes("_vi") || nf.includes("vi_") || nf.includes("viet"));
    });

    if (!best) {
      best = srtCandidates.find((f) => normalizeFileCompareName(f).includes(normVBase));
    }

    if (!best) {
      best = srtCandidates.find((f) => {
        const nf = normalizeFileCompareName(f);
        return nf.includes("_vi") || nf.includes("vi_") || nf.includes("viet");
      });
    }

    if (!best && srtCandidates.length === 1) {
      best = srtCandidates[0];
    }

    if (best) {
      const fullSrt = path.resolve(path.join(vDir, best));
      return {
        path: fullSrt,
        content: fs.readFileSync(fullSrt, "utf8")
      };
    }
  } catch (_) {}
  return null;
}

function runNativePicker(mode, title, filter, initialDir) {
  // Áp dụng Phương án A: Sử dụng trực tiếp PowerShell WinForms - chắc chắn 100% hoạt động trên mọi máy Windows
  return runPowerShellPickerFallback(mode, title, filter, initialDir);
}

function runPowerShellPickerFallback(mode, title, filter, initialDir) {
  return new Promise((resolve) => {
    const tempOut = path.join(
      os.tmpdir(),
      `picker_ps_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`
    );
    const safeTitle = String(title || "").replace(/'/g, "''");
    const safeFilter = String(filter && filter.includes("|") ? filter : "All files (*.*)|*.*").replace(/'/g, "''");
    const safeOut = tempOut.replace(/'/g, "''");
    const safeDir = initialDir && fs.existsSync(initialDir)
      ? String(fs.statSync(initialDir).isDirectory() ? initialDir : path.dirname(initialDir)).replace(/'/g, "''")
      : "";

    let psScript = "";
    if (mode === "folder") {
      psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$top = New-Object System.Windows.Forms.Form
$top.TopMost = $true
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${safeTitle}'
$d.ShowNewFolderButton = $true
${safeDir ? `$d.SelectedPath = '${safeDir}'` : ""}
if ($d.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('${safeOut}', $d.SelectedPath, [System.Text.Encoding]::UTF8)
}
$top.Dispose()
`;
    } else if (mode === "save") {
      psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$top = New-Object System.Windows.Forms.Form
$top.TopMost = $true
$f = New-Object System.Windows.Forms.SaveFileDialog
$f.Title = '${safeTitle}'
$f.Filter = '${safeFilter}'
$f.RestoreDirectory = $true
${safeDir ? `$f.InitialDirectory = '${safeDir}'` : ""}
if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('${safeOut}', $f.FileName, [System.Text.Encoding]::UTF8)
}
$top.Dispose()
`;
    } else {
      psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$top = New-Object System.Windows.Forms.Form
$top.TopMost = $true
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = '${safeTitle}'
$f.Filter = '${safeFilter}'
$f.RestoreDirectory = $true
${safeDir ? `$f.InitialDirectory = '${safeDir}'` : ""}
if ($f.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText('${safeOut}', $f.FileName, [System.Text.Encoding]::UTF8)
}
$top.Dispose()
`;
    }

    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: false }
    );
    child.on("close", () => {
      let picked = "";
      if (fs.existsSync(tempOut)) {
        try {
          picked = fs.readFileSync(tempOut, "utf8").trim();
          fs.unlinkSync(tempOut);
        } catch (_) {}
      }
      resolve({ ok: true, canceled: !picked, path: picked });
    });
    child.on("error", (err) => {
      console.error("[picker] PowerShell lỗi:", err.message);
      resolve({
        ok: false,
        canceled: true,
        path: "",
        error: `Không khởi chạy được PowerShell: ${err.message}`,
      });
    });
  });
}

app.post("/api/dialog/find-file", (req, res) => {
  try {
    const { fileName, hintDir = "" } = req.body || {};
    const foundPath = resolveMediaPath(fileName, hintDir);
    if (foundPath && fs.existsSync(foundPath)) {
      return res.json({ ok: true, found: true, path: foundPath });
    }
    res.json({ ok: true, found: false, path: "" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/dialog/auto-match-srt", (req, res) => {
  try {
    const { videoPath } = req.body || {};
    const match = findMatchingSrt(videoPath);
    if (match) {
      return res.json({ ok: true, found: true, srtPath: match.path, srtContent: match.content });
    }
    res.json({ ok: true, found: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/dialog/pick-file", async (req, res) => {
  try {
    const {
      title = "Chọn file",
      filter = "All Files (*.*)|*.*",
      initialDir = "",
      readText = false
    } = req.body || {};

    const result = await runNativePicker("file", title, filter, initialDir);
    if (!result || result.ok === false) {
      return res.status(500).json({
        ok: false,
        error: (result && result.error) || "Không mở được hộp thoại chọn file",
      });
    }
    if (!result.path || result.canceled) {
      return res.json({ ok: true, canceled: true, path: "" });
    }

    let content = null;
    if (readText && fs.existsSync(result.path)) {
      content = fs.readFileSync(result.path, "utf8");
    }

    res.json({ ok: true, canceled: false, path: result.path, content });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/dialog/pick-save-file", async (req, res) => {
  try {
    const {
      title = "Chọn nơi lưu file",
      filter = "Premiere Pro XML (*.xml)|*.xml|All Files (*.*)|*.*",
      defaultName = "Review_Premiere.xml"
    } = req.body || {};

    const result = await runNativePicker("save", title, filter, defaultName);
    if (!result || result.ok === false) {
      return res.status(500).json({
        ok: false,
        error: (result && result.error) || "Không mở được hộp thoại lưu file",
      });
    }
    res.json({ ok: true, canceled: result.canceled, path: result.path || "" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/dialog/pick-folder", async (req, res) => {
  try {
    const { description = "Chọn thư mục", initialDir = "" } = req.body || {};
    const result = await runNativePicker("folder", description, "", initialDir);
    if (!result || result.ok === false) {
      return res.status(500).json({
        ok: false,
        error: (result && result.error) || "Không mở được hộp thoại chọn thư mục",
      });
    }
    res.json({ ok: true, canceled: result.canceled, path: result.path || "" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/dialog/capcut-projects", (req, res) => {
  try {
    const draftRoot = path.join(
      process.env.LOCALAPPDATA || "",
      "CapCut",
      "User Data",
      "Projects",
      "com.lveditor.draft"
    );
    if (!fs.existsSync(draftRoot)) {
      return res.json({ ok: true, projects: [], draftRoot });
    }
    const projects = fs
      .readdirSync(draftRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== ".recycle_bin")
      .map((d) => {
        const dirPath = path.join(draftRoot, d.name);
        const draftJson = path.join(dirPath, "draft_content.json");
        if (!fs.existsSync(draftJson)) return null;
        const stat = fs.statSync(draftJson);
        return {
          name: d.name,
          path: dirPath,
          mtimeMs: stat.mtimeMs
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    res.json({ ok: true, draftRoot, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/dialog/open-explorer", (req, res) => {
  try {
    const { targetPath } = req.body || {};
    if (!targetPath) {
      return res.status(400).json({ ok: false, error: "Chưa có đường dẫn." });
    }
    const abs = path.resolve(String(targetPath));
    if (fs.existsSync(abs)) {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        spawn("explorer.exe", [`/select,${abs}`], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("explorer.exe", [abs], { detached: true, stdio: "ignore" }).unref();
      }
      return res.json({ ok: true });
    }
    const parent = path.dirname(abs);
    if (fs.existsSync(parent)) {
      spawn("explorer.exe", [parent], { detached: true, stdio: "ignore" }).unref();
      return res.json({ ok: true });
    }
    res.status(404).json({ ok: false, error: `Không tìm thấy đường dẫn: ${abs}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// 1. QUẢN LÝ ĐA CỔNG AI API (CKey.vn / @openai/codex / Custom Base URL)
// ============================================================================

app.get("/api/ai/settings", (req, res) => {
  try {
    const settings = loadAiSettings();
    res.json({ ok: true, settings, langs: LANGS, styles: STYLES });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/settings", (req, res) => {
  try {
    const {
      activeProviderId,
      activeModel,
      provider
    } = req.body || {};

    let settings = loadAiSettings();
    if (provider && typeof provider === "object" && provider.id) {
      settings = upsertProvider({
        ...provider,
        setActive: Boolean(activeProviderId === provider.id || provider.setActive)
      });
    }
    if (activeProviderId && settings.providers[activeProviderId]) {
      settings.activeProviderId = activeProviderId;
    }
    if (activeModel) {
      settings.activeModel = String(activeModel).trim();
    }
    saveAiSettings(settings);
    res.json({
      ok: true,
      settings,
      message: "Đã lưu cấu hình AI API thành công."
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/add-provider", (req, res) => {
  try {
    const settings = upsertProvider({
      ...(req.body || {}),
      setActive: true
    });
    res.json({
      ok: true,
      settings,
      message: `Đã lưu nhà cung cấp "${req.body.name || req.body.id}".`
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/ai/provider/:id", (req, res) => {
  try {
    const settings = removeProvider(req.params.id);
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/import-codex", (req, res) => {
  try {
    const result = importFromCodexConfig();
    const settings = loadAiSettings();
    res.json({ ...result, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/models", async (req, res) => {
  try {
    const { providerId, apiKey, baseUrl } = req.body || {};
    const result = await fetchAvailableModels(providerId, {
      apiKeyOverride: apiKey,
      baseUrlOverride: baseUrl
    });
    const settings = loadAiSettings();
    res.json({ ...result, settings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/ai/check-key", async (req, res) => {
  try {
    const { providerId, model, apiKey, baseUrl } = req.body || {};
    const result = await checkApiKey(providerId, {
      modelOverride: model,
      apiKeyOverride: apiKey,
      baseUrlOverride: baseUrl
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// 2. PIPELINE REVIEW PHIM AI & BEAM-SEARCH AUTO-CUT
// ============================================================================

app.post("/api/review/analyze-video", async (req, res) => {
  try {
    const {
      videoPath,
      srtPath,
      srtContent,
      sceneThreshold = 0.3,
      forceRefresh = false,
      hookSec = 15,
      clipSec = 1.6,
      noSpoiler = true
    } = req.body || {};

    const targetVideoPath = videoPath ? resolveMediaPath(videoPath) : "";
    const targetSrtPath = srtPath
      ? resolveMediaPath(srtPath, targetVideoPath ? path.dirname(targetVideoPath) : "")
      : "";

    let rawSrt = String(srtContent || "");
    if (!rawSrt && targetSrtPath) {
      if (fs.existsSync(targetSrtPath)) {
        rawSrt = fs.readFileSync(targetSrtPath, "utf8");
      }
    }
    // Nếu vẫn chưa có phụ đề và có video, tự động tìm file .srt cùng thư mục video
    if (!rawSrt && targetVideoPath && fs.existsSync(targetVideoPath)) {
      const autoSrt = findMatchingSrt(targetVideoPath);
      if (autoSrt) {
        rawSrt = autoSrt.content;
      }
    }

    const srtCues = rawSrt ? parseSrt(rawSrt) : [];
    const dialog = srtCues.map((c) => ({ s: c.startUs, e: c.endUs }));

    let analysis = {
      videoInfo: {
        width: 1920,
        height: 1080,
        fps: 24,
        timebase: 24,
        ntsc: false,
        durationUs: srtCues.length ? srtCues[srtCues.length - 1].endUs + 10000000 : 3600000000,
        path: targetVideoPath || ""
      },
      shots: [],
      rms: [],
      fromCache: false
    };

    if (targetVideoPath) {
      if (!fs.existsSync(targetVideoPath)) {
        throw new Error(`Không tìm thấy file media: ${targetVideoPath}\n👉 Mẹo: Hãy bấm nút [📂 Chọn Video...] để chọn trực tiếp file từ cửa sổ Windows, hoặc copy đường dẫn đầy đủ từ File Explorer (ví dụ: D:\\Phim\\${path.basename(videoPath)})`);
      }
      analysis = await detectShotsAndRms(targetVideoPath, {
        sceneThreshold: Number(sceneThreshold) || 0.3,
        forceRefresh: Boolean(forceRefresh)
      });
    }

    const highlights = detectHighlights({
      rms: analysis.rms,
      shots: analysis.shots,
      dialog,
      durationUs: analysis.videoInfo.durationUs
    });

    const hookClips = pickHookClips(highlights, {
      hookSec: Number(hookSec) || 15,
      clipSec: Number(clipSec) || 1.6,
      movieStartUs: 0,
      movieEndUs: analysis.videoInfo.durationUs,
      noSpoiler: noSpoiler !== false
    });

    res.json({
      ok: true,
      fromCache: analysis.fromCache,
      videoInfo: analysis.videoInfo,
      shotsCount: analysis.shots.length,
      shots: analysis.shots,
      srtCount: srtCues.length,
      srtCues,
      highlights,
      hookClips
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/review/generate-script", async (req, res) => {
  try {
    const {
      srtCues: inputCues,
      srtPath,
      srtContent,
      highlights = [],
      targetMinutes = 6,
      lang = "vi",
      style = "kich-tinh",
      customStyle = "",
      funNames = false,
      providerId,
      model
    } = req.body || {};

    let srtCues = Array.isArray(inputCues) && inputCues.length ? inputCues : [];
    if (!srtCues.length) {
      let raw = String(srtContent || "");
      if (!raw && srtPath) {
        raw = fs.readFileSync(path.resolve(String(srtPath)), "utf8");
      }
      srtCues = parseSrt(raw);
    }

    if (!srtCues.length) {
      throw new Error("Chưa có dữ liệu phụ đề gốc (.srt) để AI viết kịch bản.");
    }

    const result = await generateReviewScript({
      srtCues,
      highlights,
      targetMinutes: Number(targetMinutes) || 6,
      lang,
      style,
      customStyle,
      funNames: Boolean(funNames),
      providerId,
      model
    });

    res.json({
      ok: true,
      ...result
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/review/remap-script", (req, res) => {
  try {
    const { oldCues, editedLines, minSim = 0.35 } = req.body || {};
    const lines = Array.isArray(editedLines)
      ? editedLines
      : String(editedLines || "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);

    const remapped = remapScriptRanges(oldCues || [], lines, {
      minSim: Number(minSim) || 0.35
    });

    res.json({
      ok: true,
      cues: remapped,
      stats: {
        total: remapped.length,
        kept: remapped.filter((c) => c.status === "kept").length,
        edited: remapped.filter((c) => c.status === "edited").length,
        added: remapped.filter((c) => c.status === "new").length
      }
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/review/render", async (req, res) => {
  try {
    const {
      videoPath,
      videoInfo: clientVideoInfo,
      cues: inputCues,
      shots = [],
      highlights = [],
      hookClips = [],
      includeHook = true,
      voiceAudioPath,
      voiceSrtPath,
      voiceSrtContent,
      exportMode = "premiere-xml", // "premiere-xml" | "capcut-draft" | "both"
      capcutDraftPath,
      outputXmlPath,
      options = {}
    } = req.body || {};

    const targetVideoPath = videoPath ? resolveMediaPath(videoPath) : "";
    let videoInfo = clientVideoInfo;
    if ((!videoInfo || !videoInfo.durationUs) && targetVideoPath && fs.existsSync(targetVideoPath)) {
      videoInfo = await probeVideo(targetVideoPath);
    }
    if (!videoInfo) {
      videoInfo = {
        path: targetVideoPath || videoPath || "D:/movie.mp4",
        width: 1920,
        height: 1080,
        fps: 24,
        timebase: 24,
        ntsc: false,
        durationUs: 3600000000
      };
    } else if (targetVideoPath) {
      videoInfo.path = targetVideoPath;
    }

    const targetVoiceAudioPath = voiceAudioPath
      ? resolveMediaPath(voiceAudioPath, targetVideoPath ? path.dirname(targetVideoPath) : "")
      : "";
    const targetVoiceSrtPath = voiceSrtPath
      ? resolveMediaPath(voiceSrtPath, targetVideoPath ? path.dirname(targetVideoPath) : "")
      : "";

    // Nếu người dùng truyền thêm file Voice SRT (từ V-Clone / TTS ngoài), lấy thời lượng đọc từ đó
    let voiceSrtCues = [];
    if (voiceSrtContent) {
      voiceSrtCues = parseSrt(voiceSrtContent);
    } else if (targetVoiceSrtPath && fs.existsSync(targetVoiceSrtPath)) {
      voiceSrtCues = parseSrt(fs.readFileSync(targetVoiceSrtPath, "utf8"));
    }

    const preparedCues = (inputCues || []).map((c, idx) => {
      const vCue = voiceSrtCues[idx];
      let ttsDurationUs = Number(c.ttsDurationUs) || 0;
      let audioSrcStartUs = c.audioSrcStartUs != null ? Number(c.audioSrcStartUs) : null;

      if (vCue && vCue.endUs > vCue.startUs) {
        ttsDurationUs = vCue.endUs - vCue.startUs;
        audioSrcStartUs = vCue.startUs;
      }
      if (!ttsDurationUs) {
        // Ước lượng thời lượng đọc theo số từ tiếng Việt (~5 từ / giây = 200ms / từ, tối thiểu 1.8s)
        const words = String(c.text || c.narration || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
        ttsDurationUs = Math.max(1800000, Math.round(words * 200000));
      }

      return {
        ...c,
        index: c.index || idx + 1,
        text: String(c.text || c.narration || "").trim(),
        ttsDurationUs,
        audioPath: c.audioPath || voiceAudioPath || null,
        audioSrcStartUs: audioSrcStartUs != null ? audioSrcStartUs : 0
      };
    });

    if (!preparedCues.length) {
      throw new Error("Danh sách câu kịch bản trống, không thể dựng Timeline.");
    }

    const timelineResult = computeTimeline(preparedCues, videoInfo, {
      gapUs: options.gapSec != null ? Math.round(Number(options.gapSec) * 1000000) : 120000,
      cutSecMin: Number(options.cutSecMin) || 2.0,
      cutSecMax: Number(options.cutSecMax) || 3.0,
      minCutsPerCue: Number(options.minCutsPerCue) || 2,
      maxCutsPerCue: Number(options.maxCutsPerCue) || 3,
      maxClipSec: Number(options.maxClipSec) || 6.0,
      minJumpSec: options.minJumpSec != null ? Number(options.minJumpSec) : 2.0,
      backJumpSec: options.backJumpSec != null ? Number(options.backJumpSec) : 90.0,
      shots,
      highlights,
      hookClips: includeHook ? hookClips : [],
      seed: options.seed
    });

    const outDir = path.join(__dirname, "..", "output");
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const baseName = videoPath
      ? path.parse(videoPath).name
      : `Review_${Date.now()}`;

    const finalXmlPath = outputXmlPath
      ? path.resolve(String(outputXmlPath))
      : path.join(outDir, `${baseName}_Premiere.xml`);
    const finalSrtPath = finalXmlPath.replace(/\.xml$/i, "_MasterVoice.srt");

    const outputs = {};

    if (exportMode === "premiere-xml" || exportMode === "both") {
      const xmlContent = buildPremiereXml(timelineResult, videoInfo, {
        videoPath: videoInfo.path,
        voiceAudioPath: targetVoiceAudioPath || voiceAudioPath,
        zoom: options.zoom != null ? Number(options.zoom) : 1.08,
        flip: options.flip !== false,
        muteOriginal: Boolean(options.muteOriginal),
        originalVolume: options.originalVolume != null ? Number(options.originalVolume) : 15
      });
      const masterSrtContent = buildMasterSrt(timelineResult.cuePlacements);

      fs.mkdirSync(path.dirname(finalXmlPath), { recursive: true });
      fs.writeFileSync(finalXmlPath, xmlContent, "utf8");
      fs.writeFileSync(finalSrtPath, masterSrtContent, "utf8");

      outputs.premiereXmlPath = finalXmlPath;
      outputs.masterSrtPath = finalSrtPath;
    }

    if ((exportMode === "capcut-draft" || exportMode === "both") && capcutDraftPath) {
      const capcutRes = applySyncToCapCutDraft(capcutDraftPath, timelineResult, {
        zoom: options.zoom != null ? Number(options.zoom) : 1.08,
        flip: options.flip !== false,
        muteOriginal: Boolean(options.muteOriginal),
        originalVolume: options.originalVolume != null ? Number(options.originalVolume) : 15
      });
      outputs.capcutDraft = capcutRes;
    }

    res.json({
      ok: true,
      outputs,
      timelineResult
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/capcut/inject-captions", (req, res) => {
  try {
    const { draftPath, lines, slotSec = 3.0 } = req.body || {};
    const result = injectCaptionsToCapCutDraft(draftPath, lines, { slotSec });
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ============================================================================
// 3. DỊCH PHỤ ĐỀ GIỮ NGUYÊN SỐ DÒNG & TẠO PROMPT ẢNH/VIDEO
// ============================================================================

app.post("/api/translate", async (req, res) => {
  try {
    const {
      input,
      targetLang = "Tiếng Việt",
      styleNote,
      chunkSize = 45,
      providerId,
      model
    } = req.body || {};

    const result = await translateSubtitles({
      input,
      targetLang,
      styleNote,
      chunkSize: Number(chunkSize) || 45,
      providerId,
      model
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/prompts", async (req, res) => {
  try {
    const {
      input,
      visualStyle,
      chunkSize = 35,
      providerId,
      model
    } = req.body || {};

    const result = await generateVisualPrompts({
      input,
      visualStyle,
      chunkSize: Number(chunkSize) || 35,
      providerId,
      model
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n==================================================================`);
    console.log(`🚀 AUTO STUDIO AI (Premiere XML + CapCut + Multi-Provider AI)`);
    console.log(`🌐 Mở trình duyệt tại: http://localhost:${PORT}`);
    console.log(`🔑 Cổng AI mặc định : CKey.vn (https://api.xah.io/v1 - deepseek-v4.1-flash)`);
    console.log(`==================================================================\n`);
  });
}

module.exports = app;
