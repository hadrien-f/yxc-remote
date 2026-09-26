# Milestones

## Done
1. Now-playing screen + volume slider (safety cap raw 110), power
2. Controls & sources: mute, transport (per-source caps), pinned inputs, favorite/recent stations
3. LAN auto-detect (SSDP, Rust) + receiver chooser / manual IP
4. Tauri smoke tests on the real binary (`npm run e2e:tauri`, read-only)
5. UDP push: receiver events trigger a refresh; polling kept at 10 s as a safety net
6. App icon (Lucide "speaker", ISC)
7. Android build (minSdk 24) + media controls: phone volume keys, notification/lock-screen slider and play/pause, adjustable max volume

## Next
- **F-Droid release**: signed release build, no proprietary dependencies, reproducible build metadata
- **Sound settings**: DSP program, tone, subwoofer, dialogue level… driven by `getFeatures`; copy the official app's grouping
- **Net radio browsing/search** + "play URL" via the receiver's UPnP AVTransport (`:49154`) — same mechanism as "play from device"
- **Play from device**: phone serves files over HTTP, receiver pulls them (research spike first)
