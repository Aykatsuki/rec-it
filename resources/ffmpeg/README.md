# Bundled FFmpeg

This folder is filled by `pnpm fetch-ffmpeg` and is not committed.

Rec-It uses the GPL static builds from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)
(libx264, NVENC, libass included). Each platform gets a subfolder such as `win32-x64/` containing
`ffmpeg(.exe)`, `ffprobe(.exe)`, the build's licence file and `BUILD-INFO.json` (download URL and SHA-256).

FFmpeg is GPL software. Its source code is available from https://ffmpeg.org and the build scripts
from the BtbN repository; release packages of Rec-It include a written source offer (ADR-007).

On macOS there are no BtbN builds: install FFmpeg with Homebrew (`brew install ffmpeg`) and Rec-It
will find it on your PATH.
