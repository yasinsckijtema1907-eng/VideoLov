# Third-party components

VideoLov application code and interface: Copyright (c) 2026 M0904sha, GPL-3.0-or-later.
Video Hunter is a functional reference only. No code, assets, name or branding from that extension are included.

The installed application aggregates independent command-line tools. Their notices and licenses remain in `resources/tools` and Electron's `LICENSE.electron.txt` / `LICENSES.chromium.html`.

- Electron and Chromium: MIT and multiple third-party licenses. https://github.com/electron/electron ; https://www.electronjs.org
- yt-dlp: Unlicense source; official Windows executable includes GPLv3+ and other components. Full bundled notices: `tools/yt-dlp-LICENSES.txt`. Exact release and checksum: `tools/versions.json`. Source and releases: https://github.com/yt-dlp/yt-dlp ; https://github.com/yt-dlp/ejs
- FFmpeg / FFprobe: Gyan essentials build with GPLv3-enabled components. Full GPL text: `tools/ffmpeg-LICENSE`; build configuration and source references: `tools/ffmpeg-README.txt`. Exact release and checksum: `tools/versions.json`. Build source: https://github.com/GyanD/codexffmpeg ; FFmpeg source: https://git.ffmpeg.org/ffmpeg.git ; release source archives: https://ffmpeg.org/releases/
- Node.js: MIT and third-party licenses. Complete license: `tools/node-LICENSE.txt`. Exact runtime and checksum: `tools/versions.json`. Source: https://github.com/nodejs/node

Build-only dependencies are recorded in `package-lock.json`; their licenses remain in their respective packages. They are not claimed as M0904sha's work.
