"use strict";

const fs = require("fs");
const path = require("path");
const { detectShotsAndRms } = require("./core/ffmpeg-analyzer");
const { detectHighlights, pickHookClips } = require("./core/highlight-core");
const { parseSrt, generateReviewScript } = require("./core/review-script-core");
const { computeTimeline } = require("./core/review-sync");
const { buildPremiereXml, buildMasterSrt } = require("./core/premiere-xml-builder");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || (!args.video && !args.srt)) {
    console.log(`
Cách dùng Auto Studio AI CLI:
  node src/cli.js --video "D:/phim.mp4" --srt "D:/phim.srt" [--voice-srt "D:/voice.srt"] [--voice-audio "D:/voice.wav"] [--minutes 6] [--zoom 1.08] [--flip] [--out "output/Review_Premiere.xml"]
`);
    process.exit(0);
  }

  const videoPath = args.video ? path.resolve(args.video) : null;
  const srtPath = args.srt ? path.resolve(args.srt) : null;
  const srtCues = srtPath ? parseSrt(fs.readFileSync(srtPath, "utf8")) : [];
  const dialog = srtCues.map((c) => ({ s: c.startUs, e: c.endUs }));

  console.log("1. Đang phân tích Video & Phụ đề...");
  let analysis = {
    videoInfo: {
      path: videoPath || "movie.mp4",
      width: 1920,
      height: 1080,
      fps: 24,
      timebase: 24,
      ntsc: false,
      durationUs: srtCues.length ? srtCues[srtCues.length - 1].endUs + 10000000 : 3600000000
    },
    shots: [],
    rms: []
  };

  if (videoPath && fs.existsSync(videoPath)) {
    analysis = await detectShotsAndRms(videoPath);
    console.log(`   -> Đã phát hiện ${analysis.shots.length} điểm chuyển cảnh (shots).`);
  }

  const highlights = detectHighlights({
    rms: analysis.rms,
    shots: analysis.shots,
    dialog,
    durationUs: analysis.videoInfo.durationUs
  });
  const hookClips = pickHookClips(highlights, {
    movieEndUs: analysis.videoInfo.durationUs
  });
  console.log(`   -> Phát hiện ${highlights.length} phân đoạn cao trào & ${hookClips.length} clip Hook.`);

  let scriptCues = [];
  if (args["voice-srt"] && fs.existsSync(path.resolve(args["voice-srt"]))) {
    const vCues = parseSrt(fs.readFileSync(path.resolve(args["voice-srt"]), "utf8"));
    scriptCues = vCues.map((vc) => ({
      index: vc.index,
      text: vc.text,
      ttsDurationUs: vc.endUs - vc.startUs,
      audioSrcStartUs: vc.startUs,
      audioPath: args["voice-audio"] ? path.resolve(args["voice-audio"]) : null,
      startUs: vc.startUs,
      endUs: vc.endUs
    }));
  } else {
    console.log("2. Đang gọi AI viết kịch bản Review Phim 4 bước...");
    const aiResult = await generateReviewScript({
      srtCues,
      highlights,
      targetMinutes: Number(args.minutes) || 6,
      onProgress: (p) => console.log(`   ${p.message}`)
    });
    scriptCues = aiResult.cues.map((c) => {
      const words = c.text.split(/\s+/).filter(Boolean).length;
      return {
        ...c,
        ttsDurationUs: Math.max(1800000, Math.round(words * 200000))
      };
    });
  }

  console.log("3. Đang chạy thuật toán Beam-Search cắt cảnh...");
  const tl = computeTimeline(scriptCues, analysis.videoInfo, {
    shots: analysis.shots,
    highlights,
    hookClips: args["no-hook"] ? [] : hookClips
  });

  const outXml = args.out
    ? path.resolve(args.out)
    : path.join(__dirname, "..", "output", "Premiere_Timeline.xml");
  const outSrt = outXml.replace(/\.xml$/i, "_MasterVoice.srt");

  const xml = buildPremiereXml(tl, analysis.videoInfo, {
    videoPath: analysis.videoInfo.path,
    voiceAudioPath: args["voice-audio"] ? path.resolve(args["voice-audio"]) : null,
    zoom: Number(args.zoom) || 1.08,
    flip: Boolean(args.flip !== "false")
  });
  const masterSrt = buildMasterSrt(tl.cuePlacements);

  fs.mkdirSync(path.dirname(outXml), { recursive: true });
  fs.writeFileSync(outXml, xml, "utf8");
  fs.writeFileSync(outSrt, masterSrt, "utf8");

  console.log(`\n✅ HOÀN TẤT! Thống kê Timeline:`, tl.stats);
  console.log(`🎬 Premiere Pro XML : ${outXml}`);
  console.log(`📝 Phụ đề Master SRT: ${outSrt}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Lỗi:", err.message);
    process.exit(1);
  });
}
