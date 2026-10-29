"use strict";

const path = require("path");
const { usToTs } = require("./review-script-core");

/**
 * Escape ký tự đặc biệt trong XML
 */
function escXml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Chuyển đổi đường dẫn Windows/POSIX sang chuẩn pathurl của Adobe Premiere Pro (FCP7 XMEML v4)
 * Ví dụ: D:\12 Project Review Phim\movie.mp4 -> file://localhost/D%3a/12%20Project%20Review%20Phim/movie.mp4
 */
function toPathUrl(filePath) {
  const abs = path.resolve(String(filePath || "")).replace(/\\/g, "/");
  const segments = abs.split("/");
  const encoded = segments.map((seg, idx) => {
    if (idx === 0 && /^[a-zA-Z]:$/.test(seg)) {
      return `${seg[0]}%3a`;
    }
    return encodeURIComponent(seg);
  });
  return `file://localhost/${encoded.join("/")}`;
}

/**
 * Quy đổi micro-giây sang số Frame theo chuẩn timebase
 */
function usToFrames(us, fps) {
  return Math.max(0, Math.round(((Number(us) || 0) / 1000000) * fps));
}

/**
 * Tạo khối XML <rate>
 */
function renderRateXml(timebase, ntsc) {
  return `<rate><timebase>${timebase}</timebase><ntsc>${ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
}

/**
 * Tạo hiệu ứng Time Remapping, Scale (Zoom) và Horizontal Flip cho từng <clipitem>
 */
function renderVideoFiltersXml({ speed = 1.0, zoom = 1.0, flip = false, durationFrames = 100, rateXml }) {
  const filters = [];

  // 1. Phóng hình (Zoom / Scale chống Content ID)
  if (Number(zoom) && Math.abs(Number(zoom) - 1.0) > 0.001) {
    const scalePct = +(Number(zoom) * 100).toFixed(2);
    filters.push(`
            <filter>
              <effect>
                <name>Basic Motion</name>
                <effectid>basic</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>
                <parameter authoringApp="PremierePro">
                  <parameterid>scale</parameterid>
                  <name>Scale</name>
                  <valuemin>0</valuemin>
                  <valuemax>1000</valuemax>
                  <value>${scalePct}</value>
                </parameter>
              </effect>
            </filter>`);
  }

  // 2. Lật ngang (Horizontal Flip chống Content ID)
  if (flip) {
    filters.push(`
            <filter>
              <effect>
                <name>Horizontal Flip</name>
                <effectid>horizontalflip</effectid>
                <effectcategory>Transform</effectcategory>
                <effecttype>filter</effecttype>
                <mediatype>video</mediatype>
              </effect>
            </filter>`);
  }

  // 3. Co giãn tốc độ (Time Remapping 0.9x - 1.1x)
  if (Number(speed) && Math.abs(Number(speed) - 1.0) > 0.0005) {
    const speedPct = +(Number(speed) * 100).toFixed(3);
    filters.push(`
            <filter>
              <effect>
                <name>Time Remapping</name>
                <effectid>timeremap</effectid>
                <effectcategory>motion</effectcategory>
                <effecttype>motion</effecttype>
                <mediatype>video</mediatype>
                <parameter authoringApp="PremierePro">
                  <parameterid>variablespeed</parameterid>
                  <name>variablespeed</name>
                  <valuemin>0</valuemin>
                  <valuemax>1</valuemax>
                  <value>0</value>
                </parameter>
                <parameter authoringApp="PremierePro">
                  <parameterid>speed</parameterid>
                  <name>speed</name>
                  <valuemin>-100000</valuemin>
                  <valuemax>100000</valuemax>
                  <value>${speedPct}</value>
                </parameter>
                <parameter authoringApp="PremierePro">
                  <parameterid>reverse</parameterid>
                  <name>reverse</name>
                  <value>FALSE</value>
                </parameter>
                <parameter authoringApp="PremierePro">
                  <parameterid>frameblending</parameterid>
                  <name>frameblending</name>
                  <value>FALSE</value>
                </parameter>
              </effect>
            </filter>`);
  }

  return filters.join("");
}

/**
 * Xây dựng nội dung file .xml chuẩn Final Cut Pro 7 XML (<xmeml version="4">)
 * cho Adobe Premiere Pro — 100% Online Media & Zero Frame Drift
 */
function buildPremiereXml(timelineResult, videoInfo = {}, opts = {}) {
  const pieces = (timelineResult && timelineResult.pieces) || [];
  const cuePlacements = (timelineResult && timelineResult.cuePlacements) || [];

  const width = Number(videoInfo.width) || 1920;
  const height = Number(videoInfo.height) || 1080;
  const timebase = Math.max(1, Math.round(Number(videoInfo.timebase || videoInfo.fps) || 24));
  const ntsc = Boolean(videoInfo.ntsc);
  const fps = ntsc ? timebase * (1000 / 1001) : timebase;
  const rateXml = renderRateXml(timebase, ntsc);

  const videoPath = videoInfo.path || opts.videoPath || "movie.mp4";
  const videoName = path.basename(videoPath);
  const videoPathUrl = toPathUrl(videoPath);
  const masterVideoDurationFrames = Math.max(
    1,
    usToFrames(videoInfo.durationUs || 3600000000, timebase)
  );

  const zoom = opts.zoom != null ? Number(opts.zoom) : 1.08;
  const flip = Boolean(opts.flip);
  const includeOriginalAudio = !opts.muteOriginal && Number(opts.originalVolume) > 0;
  const origVolumeRatio = Math.max(0, Math.min(1, (Number(opts.originalVolume) || 15) / 100));

  const masterFileId = "master-video-1";
  let masterFileDefined = false;

  function getMasterFileXml() {
    if (!masterFileDefined) {
      masterFileDefined = true;
      return `
            <file id="${masterFileId}">
              <name>${escXml(videoName)}</name>
              <pathurl>${escXml(videoPathUrl)}</pathurl>
              ${rateXml}
              <duration>${masterVideoDurationFrames}</duration>
              <media>
                <video>
                  <samplecharacteristics>
                    ${rateXml}
                    <width>${width}</width>
                    <height>${height}</height>
                    <anamorphic>FALSE</anamorphic>
                    <pixelaspectratio>square</pixelaspectratio>
                    <fielddominance>none</fielddominance>
                  </samplecharacteristics>
                </video>
                <audio>
                  <samplecharacteristics>
                    <depth>16</depth>
                    <samplerate>${videoInfo.sampleRate || 48000}</samplerate>
                  </samplecharacteristics>
                  <channelcount>${videoInfo.channels || 2}</channelcount>
                </audio>
              </media>
            </file>`;
    }
    return `<file id="${masterFileId}"/>`;
  }

  // 1. Tạo các <clipitem> trên Track Video V1 (Zero Frame Drift: start_i = end_{i-1})
  const videoClipItemsXml = [];
  const origAudioClipItemsXml = [];
  let currentTimelineFrame = 0;

  // Map lưu câu lời bình bắt đầu ở mảnh cắt đầu tiên của câu đó để gắn Marker
  const cueByIndex = new Map();
  for (const cp of cuePlacements) {
    cueByIndex.set(cp.cueIndex, cp);
  }
  const markedCues = new Set();

  pieces.forEach((piece, idx) => {
    const startFrame = currentTimelineFrame;
    const targetEndFrame = Math.max(
      startFrame + 1,
      usToFrames(piece.dstStart + piece.dstDur, timebase)
    );
    const dstDurFrames = targetEndFrame - startFrame;
    currentTimelineFrame = targetEndFrame;

    const inFrame = usToFrames(piece.srcStart, timebase);
    const srcDurFrames = Math.max(1, usToFrames(piece.srcDur, timebase));
    const outFrame = inFrame + srcDurFrames;

    const clipId = `video-clipitem-${idx + 1}`;
    const cueInfo = piece.cueIndex >= 0 ? cueByIndex.get(piece.cueIndex) : null;
    let clipMarkerXml = "";

    if (cueInfo && !markedCues.has(piece.cueIndex)) {
      markedCues.add(piece.cueIndex);
      clipMarkerXml = `
            <marker>
              <name>${escXml(`Câu #${cueInfo.index}`)}</name>
              <comment>${escXml(cueInfo.text)}</comment>
              <in>${inFrame}</in>
              <out>-1</out>
            </marker>`;
    }

    const filtersXml = renderVideoFiltersXml({
      speed: piece.speed,
      zoom,
      flip,
      durationFrames: dstDurFrames,
      rateXml
    });

    videoClipItemsXml.push(`
          <clipitem id="${clipId}">
            <name>${escXml(piece.isHook ? `[HOOK] ${videoName}` : `[Câu #${piece.cueNumber || idx + 1}] ${videoName}`)}</name>
            <enabled>TRUE</enabled>
            <duration>${masterVideoDurationFrames}</duration>
            ${rateXml}
            <start>${startFrame}</start>
            <end>${targetEndFrame}</end>
            <in>${inFrame}</in>
            <out>${outFrame}</out>
            ${getMasterFileXml()}
            ${filtersXml}
            ${clipMarkerXml}
          </clipitem>`);

    if (includeOriginalAudio) {
      origAudioClipItemsXml.push(`
          <clipitem id="orig-audio-clipitem-${idx + 1}">
            <name>${escXml(videoName)}</name>
            <enabled>TRUE</enabled>
            <duration>${masterVideoDurationFrames}</duration>
            ${rateXml}
            <start>${startFrame}</start>
            <end>${targetEndFrame}</end>
            <in>${inFrame}</in>
            <out>${outFrame}</out>
            ${getMasterFileXml()}
            <sourcetrack>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
            </sourcetrack>
            <filter>
              <effect>
                <name>Audio Levels</name>
                <effectid>audiolevels</effectid>
                <effectcategory>audiolevels</effectcategory>
                <effecttype>audiolevels</effecttype>
                <mediatype>audio</mediatype>
                <parameter authoringApp="PremierePro">
                  <parameterid>level</parameterid>
                  <name>Level</name>
                  <valuemin>0</valuemin>
                  <valuemax>3.98109</valuemax>
                  <value>${origVolumeRatio.toFixed(4)}</value>
                </parameter>
              </effect>
            </filter>
          </clipitem>`);
    }
  });

  // 2. Tạo Track Audio A1 (Voiceover / TTS) và Sequence Markers
  const voiceClipItemsXml = [];
  const sequenceMarkersXml = [];
  const definedAudioFiles = new Map();

  function getAudioFileXml(audioPath, durUs) {
    const abs = path.resolve(String(audioPath));
    if (definedAudioFiles.has(abs)) {
      return `<file id="${definedAudioFiles.get(abs)}"/>`;
    }
    const fileId = `voice-file-${definedAudioFiles.size + 1}`;
    definedAudioFiles.set(abs, fileId);
    const name = path.basename(abs);
    const pathUrl = toPathUrl(abs);
    const durFrames = Math.max(1, usToFrames(durUs || 600000000, timebase));
    return `
            <file id="${fileId}">
              <name>${escXml(name)}</name>
              <pathurl>${escXml(pathUrl)}</pathurl>
              ${rateXml}
              <duration>${durFrames}</duration>
              <media>
                <audio>
                  <samplecharacteristics>
                    <depth>16</depth>
                    <samplerate>44100</samplerate>
                  </samplecharacteristics>
                  <channelcount>2</channelcount>
                </audio>
              </media>
            </file>`;
  }

  const globalVoicePath = opts.voiceAudioPath || null;

  cuePlacements.forEach((cp, idx) => {
    const startFrame = usToFrames(cp.newStart, timebase);
    const endFrame = Math.max(startFrame + 1, usToFrames(cp.newEnd, timebase));

    sequenceMarkersXml.push(`
      <marker>
        <name>${escXml(`Câu #${cp.index}`)}</name>
        <comment>${escXml(cp.text)}</comment>
        <in>${startFrame}</in>
        <out>${endFrame}</out>
      </marker>`);

    const audioFile = cp.audioPath || globalVoicePath;
    if (audioFile) {
      const inFrame = usToFrames(cp.audioSrcStartUs || 0, timebase);
      const outFrame = inFrame + (endFrame - startFrame);
      voiceClipItemsXml.push(`
          <clipitem id="voice-clipitem-${idx + 1}">
            <name>${escXml(`Voice #${cp.index}: ${cp.text.slice(0, 36)}`)}</name>
            <enabled>TRUE</enabled>
            <duration>${Math.max(outFrame, endFrame)}</duration>
            ${rateXml}
            <start>${startFrame}</start>
            <end>${endFrame}</end>
            <in>${inFrame}</in>
            <out>${outFrame}</out>
            ${getAudioFileXml(audioFile, (cp.audioSrcStartUs || 0) + cp.ttsDurationUs + 10000000)}
            <sourcetrack>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
            </sourcetrack>
          </clipitem>`);
    }
  });

  const sequenceName = opts.sequenceName || `AutoStudio_Review_${path.parse(videoName).name}`;
  const totalFrames = Math.max(1, currentTimelineFrame);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-review-1">
    <name>${escXml(sequenceName)}</name>
    <duration>${totalFrames}</duration>
    ${rateXml}
    <timecode>
      ${rateXml}
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            ${rateXml}
            <width>${width}</width>
            <height>${height}</height>
            <anamorphic>FALSE</anamorphic>
            <pixelaspectratio>square</pixelaspectratio>
            <fielddominance>none</fielddominance>
          </samplecharacteristics>
        </format>
        <track>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
          ${videoClipItemsXml.join("\n")}
        </track>
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
        <track>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
          ${voiceClipItemsXml.join("\n")}
        </track>
        ${
          includeOriginalAudio
            ? `<track>
          <enabled>TRUE</enabled>
          <locked>FALSE</locked>
          ${origAudioClipItemsXml.join("\n")}
        </track>`
            : ""
        }
      </audio>
    </media>
    ${sequenceMarkersXml.join("\n")}
  </sequence>
</xmeml>
`;
}

/**
 * Xuất file phụ đề Master_Voice.srt khớp chính xác 100% với vị trí các câu trên Timeline mới
 */
function buildMasterSrt(cuePlacements) {
  return (cuePlacements || [])
    .map(
      (cp, idx) =>
        `${idx + 1}\n${usToTs(cp.newStart)} --> ${usToTs(cp.newEnd)}\n${String(
          cp.text || ""
        ).trim()}`
    )
    .join("\n\n");
}

module.exports = {
  escXml,
  toPathUrl,
  usToFrames,
  buildPremiereXml,
  buildMasterSrt
};
