const fs = require("fs/promises")
const os = require("os")
const path = require("path")
const { EventEmitter } = require("events")

const {
  buildTranscodeArgs,
  compactDownloadedVideo,
  isCompactMode,
  replaceWithRollback
} = require("../src/main/services/compact-mode")

let directories = []

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cliply-compact-"))
  directories.push(directory)
  const inputPath = path.join(directory, "video.mp4")
  await fs.writeFile(inputPath, Buffer.alloc(1000, "o"))
  return { directory, inputPath }
}

afterEach(async () => {
  await Promise.all(
    directories.map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  )
  directories = []
})

function fakeTools(steps) {
  const calls = []
  const spawnFn = (_binary, args) => {
    const child = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = false
    child.kill = () => {
      child.killed = true
      queueMicrotask(() => child.emit("close", 1, "SIGTERM"))
      return true
    }

    const step = steps[calls.length]
    calls.push(args)
    queueMicrotask(async () => {
      try {
        if (step.outputSize !== undefined) {
          const outputIndex = args.indexOf("--output")
          const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : null
          await fs.writeFile(outputPath, Buffer.alloc(step.outputSize, "c"))
        }
        if (step.stderr) child.stderr.emit("data", step.stderr)
        child.emit("close", step.code ?? 0, null)
      } catch (error) {
        child.emit("error", error)
      }
    })
    return child
  }

  return { spawnFn, calls }
}

test("accepts only the four public compact modes", () => {
  expect(isCompactMode("original")).toBe(true)
  expect(isCompactMode("h265-1080p")).toBe(true)
  expect(isCompactMode("h265-720p")).toBe(true)
  expect(isCompactMode("h265-480p")).toBe(true)
  expect(isCompactMode("h264-720p")).toBe(false)
})

test("reports a missing downloaded path instead of silently blaming a tool", async () => {
  await expect(
    compactDownloadedVideo({
      inputPath: null,
      mode: "h265-720p",
      handbrakePath: "HandBrakeCLI",
      ffmpegPath: "ffmpeg"
    })
  ).resolves.toMatchObject({ replaced: false, reason: "input_unavailable" })
})

test("a verified smaller H.265 file replaces the original path", async () => {
  const { directory, inputPath } = await fixture()
  const tools = fakeTools([
    { code: 0, outputSize: 400 },
    { code: 0 }
  ])

  const result = await compactDownloadedVideo({
    inputPath,
    mode: "h265-720p",
    handbrakePath: "HandBrakeCLI",
    ffmpegPath: "ffmpeg",
    spawnFn: tools.spawnFn,
    id: "success"
  })

  expect(result).toMatchObject({
    replaced: true,
    reason: "replaced",
    originalSize: 1000,
    compactSize: 400
  })
  expect((await fs.stat(inputPath)).size).toBe(400)
  expect(tools.calls).toHaveLength(2)
  expect(tools.calls[0]).toContain("x265")
  expect(tools.calls[1]).toContain("-xerror")
  expect(await fs.readdir(directory)).toEqual(["video.mp4"])
})

test("a larger result is discarded before verification", async () => {
  const { directory, inputPath } = await fixture()
  const tools = fakeTools([{ code: 0, outputSize: 1200 }])

  const result = await compactDownloadedVideo({
    inputPath,
    mode: "h265-1080p",
    handbrakePath: "HandBrakeCLI",
    ffmpegPath: "ffmpeg",
    spawnFn: tools.spawnFn,
    id: "larger"
  })

  expect(result.reason).toBe("not_smaller")
  expect(result.replaced).toBe(false)
  expect(tools.calls).toHaveLength(1)
  expect((await fs.stat(inputPath)).size).toBe(1000)
  expect(await fs.readdir(directory)).toEqual(["video.mp4"])
})

test("a smaller result that fails verification never replaces the source", async () => {
  const { directory, inputPath } = await fixture()
  const tools = fakeTools([
    { code: 0, outputSize: 350 },
    { code: 1, stderr: "Invalid data found" }
  ])

  const result = await compactDownloadedVideo({
    inputPath,
    mode: "h265-480p",
    handbrakePath: "HandBrakeCLI",
    ffmpegPath: "ffmpeg",
    spawnFn: tools.spawnFn,
    id: "invalid"
  })

  expect(result.reason).toBe("verification_failed")
  expect(result.stderr).toMatch(/Invalid data/)
  expect((await fs.stat(inputPath)).size).toBe(1000)
  expect(await fs.readdir(directory)).toEqual(["video.mp4"])
})

test("the HandBrake H.265 profile caps dimensions and uses constant quality", () => {
  const args = buildTranscodeArgs("in.mp4", "out.mp4", {
    width: 1280,
    height: 720,
    quality: 25,
    audioBitrate: 112
  })

  expect(args[args.indexOf("--encoder") + 1]).toBe("x265")
  expect(args[args.indexOf("--quality") + 1]).toBe("25")
  expect(args[args.indexOf("--maxWidth") + 1]).toBe("1280")
  expect(args[args.indexOf("--maxHeight") + 1]).toBe("720")
  expect(args).toContain("--optimize")
})

test("a failed swap restores the original from its backup", async () => {
  const { directory, inputPath } = await fixture()
  const missingCompact = path.join(directory, "missing.mp4")
  const backup = path.join(directory, "backup.mp4")

  await expect(
    replaceWithRollback(inputPath, missingCompact, backup)
  ).rejects.toBeDefined()

  expect((await fs.stat(inputPath)).size).toBe(1000)
  await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" })
})

