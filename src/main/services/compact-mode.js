/**
 * Safe post-download H.265 compaction for CR20KB.
 *
 * The downloaded file is never encoded in place. A temporary sibling is
 * transcoded and verified first, then it must also be strictly smaller before
 * the original is swapped out. The swap keeps a backup until the new file is
 * in the original path so a failed rename can be rolled back.
 */

const path = require("path")
const { randomUUID } = require("crypto")
const fs = require("fs/promises")
const { spawn } = require("child_process")

const COMPACT_PROFILES = Object.freeze({
  original: null,
  "h265-1080p": Object.freeze({ height: 1080, crf: 27, audioBitrate: "128k" }),
  "h265-720p": Object.freeze({ height: 720, crf: 28, audioBitrate: "112k" }),
  "h265-480p": Object.freeze({ height: 480, crf: 29, audioBitrate: "96k" })
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
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-sn",
    "-dn",
    "-map_metadata",
    "0",
    "-vf",
    `scale=-2:trunc(min(${profile.height}\\,ih)/2)*2`,
    "-c:v",
    "libx265",
    "-preset",
    "medium",
    "-crf",
    String(profile.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    profile.audioBitrate
  ]

  // hvc1 makes HEVC more widely recognised by Apple/Windows players, while
  // faststart keeps an MP4 usable before the whole file has been transferred.
  if (extension === ".mp4" || extension === ".mov") {
    args.push("-tag:v", "hvc1", "-movflags", "+faststart")
  }

  args.push(outputPath)
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

function runFfmpeg(ffmpegPath, args, { spawnFn = spawn, onProcess = () => {} } = {}) {
  return new Promise((resolve) => {
    let child

    try {
      child = spawnFn(ffmpegPath, args, {
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
    throw new Error("FFmpeg did not produce a non-empty file")
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

  if (!inputPath || !ffmpegPath) {
    return { filePath: inputPath, replaced: false, mode, reason: "ffmpeg_unavailable" }
  }

  const compactPath = siblingPath(inputPath, "compact", id)
  const backupPath = siblingPath(inputPath, "original", id)
  const profile = COMPACT_PROFILES[mode]

  try {
    const original = await statNonEmpty(inputPath)
    const transcode = await runFfmpeg(
      ffmpegPath,
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

    const verification = await runFfmpeg(
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
