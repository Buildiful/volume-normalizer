# Volume Normalizer

**Volume Normalizer by Buildiful®** is a free, open-source browser tool that measures integrated loudness and creates normalized copies of your audio files. Original files are never edited.

It is built for static hosting, including GitHub Pages. No build step, backend, account, or API key is required.

## Use the tool

1. Open the app in a current version of Chrome or Edge. Choose a source folder, with or without subfolders. Chrome's directory picker works best; browsers without this API can use the fallback folder-file picker.
2. Select a target loudness in LUFS (default **−14 LUFS**) and a sample peak ceiling (default **−2 dBFS**).
3. Choose a format: **WAV 16-bit**, **WAV 24-bit**, **WAV 32-bit float**, or **MP3 320 kbps**. MP3 uses an optional externally loaded encoder.
4. Choose an output folder or use ZIP download. You can preserve the source subfolder structure.
5. Click **Analyze selected**. Review the measured loudness, planned gain, and peak-limited warning for each file.
6. Click **Export normalized files**. The output filename gets ` [normalized]`, and a numbered suffix is added if a file already exists in the destination.

Audio is decoded, analyzed, and encoded **locally in the browser**; no audio content is transmitted to a server.

## Important technical details

- **Metering:** The JavaScript engine implements BS.1770 K-weighting and the EBU R128 integrated loudness gating scheme (400 ms overlapping blocks at 100 ms intervals, −70 LUFS absolute gate and −10 LU relative gate). Clips shorter than 400 ms use ungated full-clip K-weighted measurement, shown as an estimate. Metering is designed for mono and stereo recordings, not surround audio.
- **Normalization:** One constant gain value is applied to an entire track to preserve its relative dynamics. This tool does not compress, limit, or equalize frequency content.
- **Peak safety:** The chosen ceiling controls the **sample peak (dBFS)**, not a certified oversampled **true peak (dBTP)**. Intersample peaks or lossy encoding can exceed the selected sample-peak ceiling. A lower ceiling leaves a useful safety margin. Peak-limited tracks cannot always attain the requested LUFS target; this is expected, and the app indicates it.
- **Input formats:** Whatever the browser can decode, commonly MP3, WAV, FLAC, M4A/AAC, OGG and WebM. Browser/codec compatibility varies. Unsupported and corrupted audio files are reported as errors.
- **Output formats:** WAV PCM 16-bit, WAV PCM 24-bit, WAV 32-bit float, or MP3 CBR 320 kbps. WAV files can be much larger than the originals. Re-encoding MP3 is lossy, even at 320 kbps. For lossless preservation, export to WAV and retain the original files.
- **Metadata:** MP3-to-MP3 exports retain an existing ID3v2 tag when present; WAV and conversions from other formats do not copy embedded artwork or music metadata in this release. Files retain their names with a suffix.
- **Folder structure:** Preserved by default. You can switch to a flat output directory; duplicate paths get unique names within a batch. Folder destination writes also avoid overwriting existing filenames.
- **Batch handling:** One file is decoded at a time and released before processing the next. Analysis and export are separate passes. For very large libraries, start with a smaller batch. Browser memory and file-system permissions can limit processing; ZIP mode keeps the output data in browser memory until the archive is downloaded.
- **Offline use:** After the page has loaded, local WAV processing works without network access. MP3 encoding needs a network request to fetch its separate JavaScript encoder if it has not been loaded.
- **No album normalization:** Track-by-track normalization is the supported mode in this version.

## Publish on GitHub Pages

1. Create an empty public GitHub repository (for example, `volume-normalizer`).
2. Upload **the contents of this directory to the repository root** (including the hidden `.nojekyll` file and the `assets/` and `js/` folders).
3. In the repository, open **Settings → Pages → Build and deployment → Deploy from a branch**.
4. Select **main**, **/(root)**, then save. For the Buildiful organization, the app becomes available at `https://buildiful.github.io/volume-normalizer/` once GitHub finishes deployment.
5. Verify source/destination folder permissions in Chrome, test a small audio batch, and confirm `about.html` and `privacy.html` work.

All paths are relative, so no homepage URL or build-tool base path needs to be edited. You may also serve the folder locally using `python3 -m http.server 8000` and open `http://localhost:8000/`.

## Analytics and privacy

Optional Google Analytics 4 is integrated using the shared Buildiful tool measurement ID. The GA4 script is **not loaded** until the visitor chooses **Allow analytics**. Choosing **No thanks** or dismissing the banner leaves the app fully usable without the analytics script. Visitors can reopen the banner using **Analytics settings** in the footer. The local-storage preference persists in that browser.

With opt-in, the app tracks limited feature usage: `folder_selected`, `analysis_started`, `analysis_completed`, `export_started`, and `export_completed`. Parameters are counts, broad format/destination choices, and whether a task was cancelled. No filenames, paths, audio content, tags, or file sizes are transmitted via custom events. Ad storage, ad user data, and advertising personalization remain denied. The [privacy policy](./privacy.html) explains external requests.

## Third-party encoder notice

Optional MP3 output uses [lamejs 1.2.1](https://github.com/zhuker/lamejs), separately fetched from jsDelivr on MP3 export only. lamejs is distributed under **LGPL-3.0** and uses LAME technology. We acknowledge the [LAME project](https://lame.sourceforge.net/); the [encoder source](https://github.com/zhuker/lamejs) and [license](https://github.com/zhuker/lamejs/blob/master/LICENSE) remain available from the original maintainers. The encoder is not included or modified in this repository. Without network access to the CDN, choose WAV output instead.

## Development and testing

- No `npm install` required.
- Run `npm test` for the dependency-free audio/ZIP unit tests.
- Test folder permissions, audio decoding, file export, and optional MP3 encoding in a supported browser before publishing changes.

## License

The tool's original source code is MIT licensed; see [LICENSE](./LICENSE). The supplied Buildiful® logo and favicon are brand assets, not licensed for independent trademark or brand use by the MIT software license. Third-party components retain their respective licenses. “Buildiful” is a trademark of its owner.

Built by [Buildiful®](https://buildiful.com).
