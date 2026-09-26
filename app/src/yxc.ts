// Yamaha Extended Control (YXC) client: the receiver's local HTTP/JSON API. Recorded responses: ../../docs/fixtures
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// In Tauri, requests go through Rust (no CORS). In a browser, Vite's dev proxy forwards them.
export const inTauri = "__TAURI_INTERNALS__" in globalThis;

export type Receiver = { ip: string; model: string; name: string };

let receiverHost = "";
export const setReceiverHost = (ip: string) => void (receiverHost = ip);
const base = () => (inTauri ? `http://${receiverHost}` : "");

// SSDP search runs in Rust (src-tauri/src/lib.rs); a browser can't do UDP, dev uses the Vite proxy instead
export const discover = () => (inTauri ? invoke<Receiver[]>("discover") : Promise.resolve([]));

// What the Android media notification / lock screen / volume keys mirror (no-op elsewhere)
export type MediaState = {
  on: boolean;
  host: string;
  title: string;
  artist: string;
  art: string;
  volume: number;
  max: number;
  playing: boolean;
  pauseCmd: "pause" | "stop" | null;
  canPlay: boolean;
};
export const mediaUpdate = (state: MediaState) => (inTauri ? invoke("media_update", { state }) : Promise.resolve());

// Safety cap below the device max so a mis-drag can't blast the room. User-adjustable, per device.
export const VOLUME_CEILING = 161; // the receiver's own max (0 dB)
export const DEFAULT_MAX_VOLUME = 130; // -15.5 dB
let maxVolume = DEFAULT_MAX_VOLUME;
export const setMaxVolume = (v: number) => void (maxVolume = Math.round(Math.min(VOLUME_CEILING, Math.max(0, v))));

export type Status = {
  power: "on" | "standby";
  volume: number;
  max_volume: number;
  mute: boolean;
  input: string;
  input_text: string;
};

export type PlayInfo = {
  input: string;
  playback: string;
  artist: string;
  album: string;
  track: string;
  albumart_url: string;
  attribute: number;
};

export type Playback = "play" | "pause" | "stop" | "previous" | "next";

// UDP push (src-tauri/src/lib.rs): announcing our port on every request keeps the
// receiver's ~10 min subscription alive with no timer of our own
const eventsPort = inTauri ? invoke<number>("events_port") : Promise.resolve(0);
export const pushEnabled = inTauri;
export const onReceiverEvent = (cb: () => void) => (inTauri ? listen("yxc-event", cb) : Promise.resolve(() => {}));

async function yxc<T>(path: string): Promise<T> {
  const port = await eventsPort;
  const headers: Record<string, string> = port ? { "X-AppName": "MusicCast/1.0(yamaha-app)", "X-AppPort": String(port) } : {};
  const res = await (inTauri ? tauriFetch : fetch)(`${base()}/YamahaExtendedControl/v1/${path}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  const body = await res.json();
  if (body.response_code !== 0) throw new Error(`YXC error ${body.response_code} on ${path}`);
  return body;
}

export const clampVolume = (v: number) => Math.round(Math.min(maxVolume, Math.max(0, v)));

// ponytail: HTR-4072 scale (raw 0 = -80.5 dB, 0.5 dB/step); read range_step from getFeatures if other models differ
export const volumeToDb = (raw: number) => -80.5 + raw * 0.5;

export const getStatus = () => yxc<Status>("main/getStatus");
export const getPlayInfo = () => yxc<PlayInfo>("netusb/getPlayInfo");

type TunerInfo = {
  band: "am" | "fm" | "dab";
  am: { freq: number };
  fm: { freq: number };
  rds?: { program_service: string; radio_text_a: string };
};
// Tuner now-playing, shaped like netusb's so the same card renders it (attribute 0 = no transport)
export async function getTunerPlayInfo(): Promise<PlayInfo> {
  const t = await yxc<TunerInfo>("tuner/getPlayInfo");
  const freq = t.band === "fm" ? `FM ${(t.fm.freq / 1000).toFixed(2)} MHz` : `AM ${t.am.freq} kHz`;
  const station = t.rds?.program_service.trim();
  return {
    input: "tuner",
    playback: "play",
    track: station || freq,
    artist: station ? freq : "",
    album: t.rds?.radio_text_a.trim() ?? "",
    albumart_url: "",
    attribute: 0,
  };
}
export const setVolume = (v: number) => yxc(`main/setVolume?volume=${clampVolume(v)}`);
export const setMute = (on: boolean) => yxc(`main/setMute?enable=${on}`);
export const setPlayback = (p: Playback) => yxc(`netusb/setPlayback?playback=${p}`);
export const setPower = (on: boolean) => yxc(`main/setPower?power=${on ? "on" : "standby"}`);

export type Input = { id: string; name: string; playInfoType: "netusb" | "tuner" | "cd" | "none" };
// A favorite (device preset) or recent item; num is the 1-based slot the recall endpoints expect
export type Item = { num: number; input: string; text: string; albumart_url?: string };

type Features = { system: { input_list: { id: string; play_info_type: Input["playInfoType"] }[] } };
type NameText = { input_list: { id: string; text: string }[] };

export async function getInputs(): Promise<Input[]> {
  const [f, n] = await Promise.all([yxc<Features>("system/getFeatures"), yxc<NameText>("system/getNameText")]);
  const names = new Map(n.input_list.map((i) => [i.id, i.text]));
  return f.system.input_list.map((i) => ({ id: i.id, name: names.get(i.id) ?? i.id, playInfoType: i.play_info_type }));
}

// Number slots from 1 (what recall endpoints expect), then drop empty ones (input "unknown")
const filled = (list: Omit<Item, "num">[]) =>
  list.map((x, i) => ({ ...x, num: i + 1 })).filter((x) => x.input !== "unknown");

export const getFavorites = async () =>
  filled((await yxc<{ preset_info: Omit<Item, "num">[] }>("netusb/getPresetInfo")).preset_info);
export const getRecents = async () =>
  filled((await yxc<{ recent_info: Omit<Item, "num">[] }>("netusb/getRecentInfo")).recent_info);

export async function selectInput(id: string) {
  await yxc(`main/prepareInputChange?input=${id}`); // wakes the input first, as the official app does
  return yxc(`main/setInput?input=${id}`);
}
export const recallFavorite = (num: number) => yxc(`netusb/recallPreset?zone=main&num=${num}`);
export const recallRecent = (num: number) => yxc(`netusb/recallRecentItem?zone=main&num=${num}`);

// Stores what is playing now into the first empty preset slot; null when all 40 are taken
export async function addFavorite(): Promise<number | null> {
  const slots = (await yxc<{ preset_info: { input: string }[] }>("netusb/getPresetInfo")).preset_info;
  const free = slots.findIndex((s) => s.input === "unknown");
  if (free < 0) return null;
  await yxc(`netusb/storePreset?num=${free + 1}`);
  return free + 1;
}

// YXC spec, getPlayInfo.attribute bits: 0 playable, 1 stop, 2 pause, 3 prev skip, 4 next skip
export const transportCaps = (attr: number) => ({
  play: !!(attr & 1),
  stop: !!(attr & 2),
  pause: !!(attr & 4),
  previous: !!(attr & 8),
  next: !!(attr & 16),
});

export const albumArtUrl = (p: PlayInfo) =>
  !p.albumart_url || p.albumart_url.startsWith("http") ? p.albumart_url : base() + p.albumart_url;
