"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { parseRmsLog } = require("./highlight-core");

/**
 * Chạy tiến trình con (ffprobe / ffmpeg) và thu thập stdout + stderr
 */
function runProcess(bin, args, { onStderrLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let tail = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      const str = chunk.toString("utf8");
      stderr += str;
      if (onStderrLine) {
        tail += str;
        const lines = tail.split(/\r?\n/);
        tail = lines.pop() || "";
        for (const l of lines) onStderrLine(l);
      }
    });

    child.on("error", (err) => {
      reject(
        new Error(
          `Không thể gọi "${bin}". Hãy chắc chắn FFmpeg đã được cài và thêm vào PATH (${err.message}).`
        )
      );
    });

    child.on("close", (code) => {
      if (tail && onStderrLine) onStderrLine(tail);
      if (code !== 0 && !stdout && !stderr) {
        return reject(new Error(`Tiến trình ${bin} kết thúc với mã lỗi ${code}.`));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Phân tích tỷ lệ khung hình (ví dụ "24000/1001" -> 23.976)
 */
function parseFrameRate(rateStr) {
  if (!rateStr) return 24;
  const parts = String(rateStr).split("/");
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (num > 0 && den > 0) return num / den;
  }
  const v = parseFloat(rateStr);
  return Number.isFinite(v) && v > 0 ? v : 24;
}

/**
 * Lấy thông số kỹ thuật của file Video hoặc Audio bằng ffprobe
 */
async function probeVideo(videoPath) {
  const absPath = path.resolve(String(videoPath || ""));
  if (!fs.existsSync(absPath)) {
    throw new Error(`Không tìm thấy file media: ${absPath}`);
  }

  const args = [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    absPath
  ];

  const { stdout } = await runProcess("ffprobe", args);
  let info = {};
  try {
    info = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Không đọc được thông tin ffprobe cho file: ${absPath}`);
  }

  const streams = Array.isArray(info.streams) ? info.streams : [];
  const videoStream = streams.find((s) => s.codec_type === "video") || {};
  const audioStream = streams.find((s) => s.codec_type === "audio");

  const width = Number(videoStream.width) || 1920;
  const height = Number(videoStream.height) || 1080;
  const fps = parseFrameRate(videoStream.r_frame_rate || videoStream.avg_frame_rate || "24/1");
  const timebase = Math.max(1, Math.round(fps));
  const ntsc = Math.abs(fps - timebase) > 0.01;

  const durSec =
    parseFloat((info.format && info.format.duration) || videoStream.duration || (audioStream && audioStream.duration) || "0") || 0;
  const durationUs = Math.max(1, Math.round(durSec * 1000000));

  return {
    path: absPath,
    name: path.basename(absPath),
    width,
    height,
    fps,
    timebase,
    ntsc,
    durationUs,
    hasAudio: Boolean(audioStream),
    sampleRate: audioStream ? Number(audioStream.sample_rate) || 48000 : 48000,
    channels: audioStream ? Number(audioStream.channels) || 2 : 2
  };
}

/**
 * Đo thời lượng chính xác (micro-giây) của một file Audio (WAV/MP3/M4A)
 */
async function probeAudioDurationUs(audioPath) {
  const info = await probeVideo(audioPath);
  return info.durationUs;
}

/**
 * Quét điểm chuyển cảnh (shots) và năng lượng âm thanh (RMS) bằng FFmpeg,
 * tự động lưu cache vào `<videoPath>.analysis.json`
 */
async function detectShotsAndRms(
  videoPath,
  { sceneThreshold = 0.3, forceRefresh = false, onProgress } = {}
) {
  const absPath = path.resolve(String(videoPath || ""));
  const cachePath = `${absPath}.analysis.json`;

  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      const stat = fs.statSync(absPath);
      if (
        cached &&
        Array.isArray(cached.shots) &&
        Array.isArray(cached.rms) &&
        cached.videoInfo &&
        cached.fileSize === stat.size
      ) {
        return { ...cached, fromCache: true, cachePath };
      }
    } catch (_) {}
  }

  const videoInfo = await probeVideo(absPath);

  // 1. Quét điểm cắt cảnh camera (shots) bằng filter select='gt(scene,0.3)',showinfo
  const shots = [];
  const sceneArgs = [
    "-hide_banner",
    "-i",
    absPath,
    "-an",
    "-vf",
    `select='gt(scene,${Number(sceneThreshold) || 0.3})',showinfo`,
    "-f",
    "null",
    "-"
  ];

  await runProcess("ffmpeg", sceneArgs, {
    onStderrLine: (line) => {
      const m = /pts_time:([\d.]+)/.exec(line);
      if (m) {
        const sec = parseFloat(m[1]);
        if (Number.isFinite(sec) && sec >= 0) {
          shots.push(Math.round(sec * 1000000));
          if (onProgress && shots.length % 25 === 0) {
            onProgress({ stage: "shots", count: shots.length, lastSec: sec });
          }
        }
      }
    }
  });

  shots.sort((a, b) => a - b);

  // 2. Quét mức năng lượng âm thanh (RMS_level) bằng astats
  let rms = [];
  if (videoInfo.hasAudio) {
    const rmsArgs = [
      "-hide_banner",
      "-i",
      absPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-af",
      "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level",
      "-f",
      "null",
      "-"
    ];
    const { stderr } = await runProcess("ffmpeg", rmsArgs);
    rms = parseRmsLog(stderr);
  }

  const stat = fs.statSync(absPath);
  const payload = {
    fileSize: stat.size,
    analyzedAt: new Date().toISOString(),
    sceneThreshold,
    videoInfo,
    shots,
    rms
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(payload), "utf8");
  } catch (_) {}

  return { ...payload, fromCache: false, cachePath };
}

module.exports = {
  probeVideo,
  probeAudioDurationUs,
  detectShotsAndRms
};
