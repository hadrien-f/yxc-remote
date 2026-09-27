# Implementation details

## Stack

| Layer | Choice |
|---|---|
| UI | React 19 + TypeScript, Mantine 9 (mobile-first, auto dark mode) |
| Receiver API | Yamaha Extended Control (YXC): unauthenticated HTTP/JSON on the LAN |
| Shell | Tauri 2 (desktop now, Android planned) |
| Tests | Vitest, Playwright, `cargo test`, Selenium + tauri-driver |

## Layout

```
app/
  src/yxc.ts           the only module that talks to the receiver
  src/components.tsx   reusable UI: NowPlaying, VolumeSlider, Transport, QuickRow, sheets
  src/App.tsx          screen state: refresh loop, receiver choice, per-device preferences
  src-tauri/src/lib.rs Rust: SSDP discovery, UDP event listener
  e2e/                 Playwright tests (browser, receiver mocked from fixtures)
  e2e-tauri/           smoke tests on the real binary + real receiver (read-only)
docs/fixtures/        real responses recorded from an HTR-4072 (identifiers replaced), used by the tests
```

## Talking to the receiver

- **Tauri:** requests go through `@tauri-apps/plugin-http`, so they're sent from Rust and CORS doesn't apply. The allowed URLs are set in `src-tauri/capabilities/default.json`: `http://*/YamahaExtendedControl/*`.
  - Don't write partial IP wildcards like `192.168.*.*`: the URL-pattern matcher never matches them.
- **Browser (`npm run dev`):** Vite's `server.proxy` forwards `/YamahaExtendedControl` and `/YamahaRemoteControl` (album art) to the receiver set by `RECEIVER_IP` in `app/.env.local` (git-ignored).
- **Errors:** any `response_code` other than 0 is thrown as an error.
- **Volume:** the UI shows dB and sends the raw 0–161 value. On the HTR-4072, dB = −80.5 + 0.5 × raw. The user's max-volume setting (default 130) is enforced in the service, not just the slider.
- **Input switch:** always `prepareInputChange` then `setInput`, as the official app does.
- **Transport buttons:** chosen from the `getPlayInfo.attribute` bitmask (bit 0 play, 1 stop, 2 pause, 3 prev, 4 next).
- **Favorites and recents:** favorites are the receiver's own presets (40 slots, network sources only). Slots are numbered from 1; empty slots have `input: "unknown"`.
- **Pinned and hidden inputs:** stored in the app's localStorage, per device. The receiver can't store input favorites.

## Discovery (SSDP)

The webview can't do UDP, so discovery is a Rust command, `discover`:
- It sends the SSDP `M-SEARCH` for `MediaRenderer` twice (UDP is lossy) and collects replies for 2 s.
- It keeps replies that carry Yamaha's `X-ModelName: <model>:<mac>:<room name>` header.
- **Startup:** use the saved receiver. If there's none, scan: one result is picked automatically, several open a chooser. A manual IP is also possible. If the saved receiver stops responding, the app rescans once per session.

## Live updates (UDP push)

- **Subscribing:** every YXC request carries the headers `X-AppName` and `X-AppPort: <port>`. The receiver then pushes JSON datagrams to that port. The subscription lasts about 10 minutes, and normal traffic keeps renewing it.
- **Rust:** listens on a random port (41100 may be taken by the official app). It drops the 1 Hz `netusb.play_time` ticks and emits a `yxc-event` to the webview for everything else.
- **UI:** refreshes 200 ms after the last event, because an input switch sends a burst of events lasting about 3 s. Most events are "changed, re-fetch" flags anyway.
- **Polling:** kept as a safety net against lost datagrams, every 10 s in Tauri. In a plain browser there's no UDP, so it polls every 2 s.

## Tests

| Command | What | Receiver |
|---|---|---|
| `npm test` | service calls against recorded fixtures | none |
| `npm run e2e` | Playwright, Pixel 7 viewport; runs its own Vite on port 1430 | mocked |
| `cd src-tauri && cargo test` | SSDP reply parsing, event filter | none |
| `cargo test -- --ignored` | live SSDP scan | read-only |
| `npm run e2e:tauri` | real binary via tauri-driver + WebKitWebDriver | read-only |

Fixtures were recorded from a real HTR-4072; identifiers (MAC, serial, UUIDs, SSID, IPs) are replaced with placeholders (`00A0DE…`, zeros, `192.0.2.x`).

- The `e2e:tauri` suite shares localStorage with `tauri dev`. Its first-launch test clears the saved receiver and relaunches the app, because reloading the page in WebKitGTK sometimes leaves it blank.
- The browser tests can't catch problems in the Tauri layer (URL permissions, Rust). That's what the smoke tests are for.
- `npm run showcase` regenerates the README screenshots and `docs/media/demo.gif` with Playwright, against a fake receiver that reacts to commands (`app/showcase/`). Album art is generated placeholders, and ffmpeg turns the recording into the GIF.

## Desktop integration (Linux)

- On Wayland, GNOME finds the window icon through a `.desktop` file whose name matches the app ID, which here is the binary name `yxc-remote`. A bundled install (`npm run tauri build`) creates that file.
- For dev builds, create `~/.local/share/applications/yxc-remote.desktop` with `Icon=<repo>/app/src-tauri/icons/icon.png`.
  - Create it only after the binary exists: GNOME ignores a `.desktop` file whose `Exec` program is missing, and doesn't re-read it later. If the icon stays generic, delete and re-create the file, then restart the app.
- The icon source is `app/app-icon.svg`: the Lucide "speaker" glyph (ISC license). Regenerate all sizes with `npx tauri icon app-icon.svg`.

## Android

- Project: `app/src-tauri/gen/android` (generated by `tauri android init`, committed because it's customized). minSdk 24 (Android 7.0), targetSdk 36.
- Toolchain: JDK 21 (`openjdk-21-jdk-headless`; the JRE alone fails with "does not provide JAVA_COMPILER"), Google's command-line tools + NDK 27 LTS, `adb` from Ubuntu. Env: `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`.
- Build + install: `npx tauri android build --debug --target aarch64 --apk`, then `adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
- Cleartext HTTP is enabled in release too (`app/build.gradle.kts`): API calls go through Rust and aren't affected, but album-art `<img>` loads from the receiver are.
- Edge-to-edge (Android 15): `viewport-fit=cover` plus `env(safe-area-inset-*)` body padding in `index.html`.
- Transport icons are inline SVG: unicode media glyphs render as colour emoji on Android.
- Icons: rerun `npx tauri icon app-icon.svg` after `tauri android init`, or the launcher keeps Tauri's default icon.
- SSDP discovery and UDP push work without a Wi-Fi multicast lock (tested on Android 15).

### Media notification, lock screen, volume keys

- `gen/android/.../MediaPlugin.kt`: a Tauri plugin class inside the app module, registered from Rust (`register_android_plugin`). The webview pushes what's playing through the Rust command `media_update`.
  - That command must be `async`. Sync commands run on the main thread, and `run_mobile_plugin` waits on Kotlin, which needs that thread too, so the app deadlocks.
  - Pushes only happen when the state changes.
- `MediaService.kt`: a `connectedDevice` foreground service with `MediaSessionCompat`.
  - **Phone volume keys:** a remote `VolumeProviderCompat` with the range 0..cap, set with `setPlaybackToRemote`. Each key press arrives as ±1 and then 0; the 0 is ignored.
  - **Volume slider:** Android can't put a custom slider in a notification, so the progress bar is repurposed. Duration is 100 s, position is the volume in % of the cap, speed is 0 so it never advances, and seeking sets the volume. Android labels it as a time.
  - **Android 7–12:** the notification's own −/+ and play/pause actions are shown instead.
  - **Commands:** sent straight from Kotlin with fire-and-forget GETs. The UI re-syncs on the next UDP event.
- **Hardware media keys** (headset, Bluetooth) don't reach the app: Android only routes them to apps that play audio themselves.
- **Max volume:** a per-device setting (receiver sheet, default 130, i.e. −15.5 dB). It's enforced in `yxc.ts` and in `MediaService` (clamping, and the volume provider's range).

## Release

- **Linux:** `npx tauri build` (in `app/`) produces `.deb`, `.rpm` and `.AppImage` in `src-tauri/target/release/bundle/`.
- **Android:** `npx tauri android build --apk` produces an unsigned universal APK (arm64, armv7, x86, x86_64). Sign it interactively, so no password is ever stored:
  ```sh
  ~/Android/Sdk/build-tools/36.1.0/apksigner sign --ks ~/.android-keys/yxc-remote.jks --ks-key-alias yxc-remote \
    --out yxc-remote_<version>_universal.apk app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
  ```
  Every update must be signed with the same key. Release builds are shrunk by R8, and `proguard-rules.pro` keeps `MediaPlugin`, which Rust loads by name.
- Signed-APK certificate SHA-256: `6a992377b10b7ac474eac0184ffc6affd2d7935512e4b00ca4d8f3802c82fe64`

## Casting phone audio (research, not built yet)

The receiver is a standard DLNA renderer (UPnP AVTransport on port 49154). Any HTTP audio URL can be played with `SetAVTransportURI` then `Play`; the input switches to `server` by itself, and `netusb/getPlayInfo` keeps reporting `play_time`. An endless live stream (no `Content-Length`) is accepted.

**Latency depends on the format, not the network.** Measured acoustically (laptop mic, beeps at known send times, ±0.05 s across runs) on an HTR-4072 over Wi-Fi:

| Stream | Starts after Play | Latency |
|---|---|---|
| `audio/L16` PCM, 48 or 96 kHz | 13 s | 11 s |
| WAV (PCM, endless header) | 13 s | 10 s |
| AAC ADTS 256 kbps | 30 s | 28 s |
| MP3 128 kbps | 7 s | 5.6 s |
| MP3 320 kbps | 4 s | 2.45 s |
| MP3 320 kbps, 120 KB ID3 padding first | 3 s | **1.6 s** |

- PCM gets a time-based buffer (~11 s), MP3 a byte-based one (~90 KB), so a higher MP3 bitrate means lower latency. This is also why net radio (typically 128 kbps) takes ~5 s to start.
- An ID3v2 tag made of padding fills the start threshold instantly and is skipped by the decoder. What remains is ~1 s fixed plus a small bitrate-dependent part.
- AAC ADTS at 512 kbps never played.
- Android's `MediaCodec` encodes AAC but not MP3, so a phone cast needs a bundled MP3 encoder (LAME, LGPL).
- Planned pipeline: `AudioPlaybackCapture` (Android 10+, consent per session) → MP3 320 kbps → phone HTTP server (ID3 padding first) → `SetAVTransportURI` + `Play`.
- In the app: "Phone audio" is the first input (Android 10+). Choosing it shows a short explanation (pick **Entire screen** so the user can switch apps), then `MediaPlugin.cast` starts `CastActivity` (RECORD_AUDIO + capture consent) and `CastService`, which sends PCM over loopback to `src/cast.rs` (LAME MP3 + HTTP + AVTransport).
- The UI counts it as casting while the receiver is on `server`, playing the "Phone audio" title. When that stops (another input, stop on the receiver), the service is stopped and sends a media pause key, so the phone's player doesn't carry on through the speaker.
- Tested on Android 15 with VLC and NewPipe; capture keeps working with the phone muted.
- Bluetooth input is the low-latency alternative (sub-second, any app, lower quality).
