# Milestones

## Done
1. Now-playing screen + volume slider (safety cap raw 110), power
2. Controls & sources: mute, transport (per-source caps), pinned inputs, favorite/recent stations
3. LAN auto-detect (SSDP, Rust) + receiver chooser / manual IP
4. Tauri smoke tests on the real binary (`npm run e2e:tauri`, read-only)
5. UDP push: receiver events trigger a refresh; polling kept at 10 s as a safety net
6. App icon (Lucide "speaker", ISC)
7. Android build (minSdk 24) + media controls: phone volume keys, notification/lock-screen slider and play/pause, adjustable max volume
8. Cast phone/computer audio (Android 10+, Linux/PipeWire): MP3 over DLNA, ~1.4–2 s latency
9. Net radio browsing and search (Airable menu on the receiver), from the Stations sheet

## Next
- **F-Droid release**: signed release build, no proprietary dependencies, reproducible build metadata
- **Sound settings**: DSP program, tone, subwoofer, dialogue level… driven by `getFeatures`; copy the official app's grouping
