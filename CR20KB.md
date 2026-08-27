# CR20KB Compact Mode

This repository is a modified fork of `Cliply/Cliply`. The Compact Mode changes
were made by `cr20kb-commits` on 2026-08-27 and remain licensed under GPL-3.0
with the rest of the project.

## Storage profiles

- **Original** — keep the downloaded file without another FFmpeg pass.
- **1080p H.265** — H.265/HEVC, capped at 1080p without upscaling.
- **720p H.265** — H.265/HEVC, capped at 720p without upscaling.
- **480p H.265** — H.265/HEVC, capped at 480p without upscaling.

Compact Mode uses Cliply's existing bundled FFmpeg and `libx265`. It writes to
a temporary sibling file and never transcodes over the download in place.

## Replacement guarantee

The downloaded original is replaced only after all of these conditions pass:

1. FFmpeg finishes the H.265 transcode successfully.
2. The temporary output exists and is non-empty.
3. The temporary output is strictly smaller than the original.
4. A separate FFmpeg verification pass can open and decode the result.

The final swap keeps a temporary backup and rolls back if the new file cannot
be moved into the original path. A failed conversion, failed verification, or
larger output leaves the completed original in place.
