/**
 * Safe post-download H.265 compaction for CR20KB.
 *
 * HandBrakeCLI never encodes over the download in place. A temporary sibling
 * is transcoded and independently verified by FFmpeg, then it must be smaller before
 * the original is swapped out. The swap keeps a backup until the new file is
 * in the original path so a failed rename can be rolled back.
 */

const path = require("path")
const { randomUUID } = require("crypto")
const fs = require("fs/promises")
const { spawn } = require("child_process")

const COMPACT_PROFILES = Object.freeze({
  original: null,
  "h265-1080p": Object.freeze({ width: 1920, height: 1080, quality: 24, audioBitrate: 128 }),
  "h265-720p": Object.freeze({ width: 1280, height: 720, quality: 25, audioBitrate: 112 }),
  "h265-480p": Object.freeze({ width: 854, height: 480, quality: 26, audioBitrate: 96 })
})

const COMPACT_MODE_LABELS = Object.freeze({
  original: "Original",
  "h265-1080p": "1080p H.265",
  "h265-720p": "720p H.265",
  "h265-480p": "480p H.265"
})

const MAX_STDERR = 16 * 1024

function isCompactMode(value) {
  return typeof value === "string" && Object.hasOwn(COMPACT_PROFILES, value)
}

function compactModeLabel(mode) {
  return COMPACT_MODE_LABELS[mode] || COMPACT_MODE_LABELS.original
}

function siblingPath(filePath, kind, id = randomUUID()) {
  const parsed = path.parse(filePath)
  return path.join(parsed.dir, `${parsed.name}.cr20kb-${kind}-${id}${parsed.ext}`)
}

function buildTranscodeArgs(inputPath, outputPath, profile) {
  const extension = path.extname(outputPath).toLowerCase()
  const args = [
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--format",
    extension === ".mkv" ? "av_mkv" : "av_mp4",
    "--encoder",
    "x265",
    "--encoder-preset",
    "medium",
    "--quality",
    String(profile.quality),
    "--maxWidth",
    String(profile.width),
    "--maxHeight",
    String(profile.height),
    "--crop-mode",
    "none",
    "--non-anamorphic",
    "--modulus",
    "2",
    "--vfr",
    "--audio",
    "1",
    "--aencoder",
    "av_aac",
    "--ab",
    String(profile.audioBitrate),
    "--mixdown",
    "stereo",
    "--keep-metadata"
  ]

  // HandBrake's optimize flag moves the MP4 index to the front (fast start).
  if (extension === ".mp4" || extension === ".mov") {
    args.push("--optimize")
  }

  return args
}

function buildVerifyArgs(filePath) {
  // The transcode's zero exit code proves it reached the end. Decode the first
  // second as a separate read to prove the resulting container and HEVC stream
  // can be opened before it is allowed to replace anything.
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-xerror",
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-t",
    "1",
    "-f",
    "null",
    "-"
  ]
}

function runTool(executablePath, args, { spawnFn = spawn, onProcess = () => {} } = {}) {
  return new Promise((resolve) => {
    let child

    try {
      child = spawnFn(executablePath, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
      })
    } catch (error) {
      resolve({ code: null, error, stderr: "" })
      return
    }

    onProcess(child)

    let stderr = ""
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-MAX_STDERR)
      })
    }

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve({ ...result, stderr })
    }

    child.once("error", (error) => finish({ code: null, error }))
    child.once("close", (code, signal) => finish({ code, signal }))
  })
}

async function statNonEmpty(filePath) {
  const stat = await fs.stat(filePath)
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("The media tool did not produce a non-empty file")
  }
  return stat
}

async function removeIfPresent(filePath) {
  if (!filePath) return
  await fs.unlink(filePath).catch(() => {})
}

async function replaceWithRollback(originalPath, compactPath, backupPath) {
  await fs.rename(originalPath, backupPath)

  try {
    await fs.rename(compactPath, originalPath)
  } catch (error) {
    try {
      await fs.rename(backupPath, originalPath)
    } catch (rollbackError) {
      // Antivirus/file-indexing races can reject a rename on Windows. A copy
      // is a second chance to restore the original path while the untouched
      // backup remains available as the final safety net.
      try {
        await fs.copyFile(backupPath, originalPath)
      } catch (copyError) {
        error.rollbackError = rollbackError
        error.copyRollbackError = copyError
        error.backupPath = backupPath
      }
    }
    throw error
  }

  // The replacement is already complete. A leftover backup is untidy but is
  // safer than treating a successful replacement as a failed one.
  await fs.unlink(backupPath).catch(() => {})
}

/**
 * Compact one downloaded video without ever encoding over the source.
 *
 * Failures are deliberately returned as "kept original": a post-download
 * optimisation must not turn a completed download into data loss.
 */
async function compactDownloadedVideo({
  inputPath,
  mode = "original",
  handbrakePath,
  ffmpegPath,
  spawnFn = spawn,
  onProcess = () => {},
  isCancelled = () => false,
  id = randomUUID()
}) {
  if (!isCompactMode(mode)) {
    return { filePath: inputPath, replaced: false, mode, reason: "invalid_mode" }
  }

  if (mode === "original") {
    return { filePath: inputPath, replaced: false, mode, reason: "original" }
  }

  if (!inputPath) {
    return { filePath: inputPath, replaced: false, mode, reason: "input_unavailable" }
  }

  if (!handbrakePath || !ffmpegPath) {
    return {
      filePath: inputPath,
      replaced: false,
      mode,
      reason: !handbrakePath ? "handbrake_unavailable" : "ffmpeg_unavailable"
    }
  }

  const compactPath = siblingPath(inputPath, "compact", id)
  const backupPath = siblingPath(inputPath, "original", id)
  const profile = COMPACT_PROFILES[mode]

  try {
    const original = await statNonEmpty(inputPath)
    const transcode = await runTool(
      handbrakePath,
      buildTranscodeArgs(inputPath, compactPath, profile),
      { spawnFn, onProcess }
    )

    if (isCancelled()) {
      await removeIfPresent(compactPath)
      return {
        filePath: inputPath,
        replaced: false,
        mode,
        reason: "cancelled",
        originalSize: original.size
      }
    }

    if (transcode.code !== 0) {
      await removeIfPresent(compactPath)
      return {
        filePath: inputPath,
        replaced: false,
        mode,
        reason: "transcode_failed",
        originalSize: original.size,
        error: transcode.error,
        stderr: transcode.stderr
      }
    }

    const compact = await statNonEmpty(compactPath)
    if (compact.size >= original.size) {
      await removeIfPresent(compactPath)
      return {
        filePath: inputPath,
        replaced: false,
        mode,
        reason: "not_smaller",
        originalSize: original.size,
        compactSize: compact.size
      }
    }

    const verification = await runTool(
      ffmpegPath,
      buildVerifyArgs(compactPath),
      { spawnFn, onProcess }
    )

    if (isCancelled()) {
      await removeIfPresent(compactPath)
      return {
        filePath: inputPath,
        replaced: false,
        mode,
        reason: "cancelled",
        originalSize: original.size
      }
    }

    if (verification.code !== 0) {
      await removeIfPresent(compactPath)
      return {
        filePath: inputPath,
        replaced: false,
        mode,
        reason: "verification_failed",
        originalSize: original.size,
        compactSize: compact.size,
        error: verification.error,
        stderr: verification.stderr
      }
    }

    await replaceWithRollback(inputPath, compactPath, backupPath)

    return {
      filePath: inputPath,
      replaced: true,
      mode,
      reason: "replaced",
      originalSize: original.size,
      compactSize: compact.size
    }
  } catch (error) {
    await removeIfPresent(compactPath)

    return {
      filePath: inputPath,
      replaced: false,
      mode,
      reason: "compact_failed",
      error,
      ...(error && error.backupPath ? { backupPath: error.backupPath } : {})
    }
  }
}

module.exports = {
  COMPACT_PROFILES,
  COMPACT_MODE_LABELS,
  isCompactMode,
  compactModeLabel,
  buildTranscodeArgs,
  buildVerifyArgs,
  compactDownloadedVideo,
  replaceWithRollback
}

