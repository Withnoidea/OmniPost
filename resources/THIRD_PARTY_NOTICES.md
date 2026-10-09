# Portable dependency notices

The OmniPost source license does not relicense its bundled dependencies.

- yt-dlp 2026.08.19: https://github.com/yt-dlp/yt-dlp/tree/2026.08.19
  The project source is Unlicense; its PyInstaller executable includes dependencies with additional licenses.
  Review https://github.com/yt-dlp/yt-dlp#license and the pinned release's third-party notices before distribution.
- Node.js 22.23.3: https://github.com/nodejs/node/tree/v22.23.3
  MIT plus bundled third-party licenses: https://github.com/nodejs/node/blob/v22.23.3/LICENSE
- FFmpeg 9.0.2, Gyan essentials build: https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
  This is a GPL-enabled build, not an LGPL-only build. The setup tool preserves the verified distribution
  archive and extracted LICENSE/docs. Consult those terms and supply corresponding source/build materials
  as required before distributing an application containing these binaries.
  Source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz

`setup:tools` is a developer/build-time command. End users must receive a prepared bundle and must not
be asked to install Python, FFmpeg, yt-dlp, Node.js or set PATH. No desktop installer is delivered yet.
