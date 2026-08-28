// Fetch the official Windows x64 HandBrakeCLI used by Compact Mode.
// The archive is accepted only when it matches HandBrake's published SHA-256.

const fs = require("fs")
const fsp = fs.promises
const path = require("path")
const https = require("https")
const { extractZip, sha256File } = require("../src/main/utils/archive")

const VERSION = "1.11.2"
const ASSET = `HandBrakeCLI-${VERSION}-win-x86_64.zip`
const URL = `https://github.com/HandBrake/HandBrake/releases/download/${VERSION}/${ASSET}`
const ARCHIVE_SHA256 = "80bfe8d5f5d11cc3ef76b834add3ed4e82dee6523ffeb435c283f88b1a21f09d"

const destination = path.join(__dirname, "..", "binaries", "windows", "handbrake")
const executable = path.join(destination, "HandBrakeCLI.exe")

function request(url, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error("too many redirects"))

  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "Cliply-Build", accept: "*/*" } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          resolve(request(new URL(response.headers.location, url).toString(), redirects + 1))
          return
        }

        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`HandBrake download returned HTTP ${response.statusCode}`))
          return
        }

        resolve(response)
      }
    )
    req.on("error", reject)
    req.setTimeout(120000, () => req.destroy(new Error("HandBrake download timed out")))
  })
}

async function download(url, output) {
  const response = await request(url)
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(output)
    response.pipe(file)
    response.once("error", reject)
    file.once("error", reject)
    file.once("finish", () => file.close(resolve))
  })
}

async function main() {
  if (!process.env.BUILD_ALL_PLATFORMS && process.env.BUILD_TARGET_PLATFORM && !process.env.BUILD_TARGET_PLATFORM.startsWith("win32")) {
    console.log("HandBrakeCLI is only bundled in Windows builds - skipping")
    return
  }

  if (!process.argv.includes("--force")) {
    try {
      if ((await fsp.stat(executable)).size > 0) {
        console.log(`HandBrakeCLI ${VERSION} is already present`)
        return
      }
    } catch {}
  }

  const workDir = path.join(destination, ".download")
  const archive = path.join(workDir, ASSET)
  await fsp.rm(workDir, { recursive: true, force: true })
  await fsp.mkdir(workDir, { recursive: true })

  try {
    console.log(`downloading official HandBrakeCLI ${VERSION}...`)
    await download(URL, archive)
    const actual = await sha256File(archive)
    if (actual.toLowerCase() !== ARCHIVE_SHA256) {
      throw new Error(`HandBrake archive checksum mismatch: ${actual}`)
    }

    await extractZip(archive, destination)
    if ((await fsp.stat(executable)).size <= 0) {
      throw new Error("HandBrakeCLI.exe was not found after extraction")
    }
    console.log(`HandBrakeCLI ${VERSION} verified and ready`)
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`HandBrake fetch failed: ${error.message}`)
  process.exitCode = 1
})

