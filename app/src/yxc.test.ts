import { afterEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { addFavorite, albumArtUrl, DEFAULT_MAX_VOLUME, setMaxVolume, getInputs, getRecents, getTunerPlayInfo, selectInput, getPlayInfo, getStatus, setMute, setPlayback, setVolume, transportCaps, volumeToDb } from "./yxc";

const fixture = (name: string) =>
  readFileSync(`${import.meta.dirname}/../../docs/fixtures/${name}.json`, "utf8");

function mockFetch(body: string) {
  const f = vi.fn(async (_url: string) => new Response(body));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

test("getStatus parses the real HTR-4072 response", async () => {
  mockFetch(fixture("main_getStatus?zone=main"));
  const s = await getStatus();
  expect(s.power).toBe("on");
  expect(s.input_text).toBe("NET RADIO");
  expect(s.volume).toBe(75);
});

test("volumeToDb matches the receiver's own actual_volume", () => {
  const s = JSON.parse(fixture("main_getStatus?zone=main"));
  expect(volumeToDb(s.volume)).toBe(s.actual_volume.value);
  expect(volumeToDb(68)).toBe(-46.5); // second live reading
});

test("getPlayInfo exposes track and album art", async () => {
  mockFetch(fixture("netusb_getPlayInfo"));
  const p = await getPlayInfo();
  expect(p.track).toContain("Siraba");
  expect(albumArtUrl(p)).toBe("/YamahaRemoteControl/AlbumART/AlbumART3576.png");
});

test("setVolume never exceeds the safety cap, which the user can move", async () => {
  const f = mockFetch('{"response_code":0}');
  await setVolume(161);
  await setVolume(-5);
  setMaxVolume(200); // can't go past the receiver's own max
  await setVolume(170);
  setMaxVolume(DEFAULT_MAX_VOLUME);
  expect(f.mock.calls.map((c) => c[0])).toEqual([
    "/YamahaExtendedControl/v1/main/setVolume?volume=130",
    "/YamahaExtendedControl/v1/main/setVolume?volume=0",
    "/YamahaExtendedControl/v1/main/setVolume?volume=161",
  ]);
});

test("non-zero response_code is an error", async () => {
  mockFetch('{"response_code":4}');
  await expect(getStatus()).rejects.toThrow("YXC error 4");
});

test("net radio can stop but not pause or skip", () => {
  const p = JSON.parse(fixture("netusb_getPlayInfo"));
  expect(transportCaps(p.attribute)).toEqual({ play: true, stop: true, pause: false, previous: false, next: false });
});

test("mute and transport send the documented commands", async () => {
  const f = mockFetch('{"response_code":0}');
  await setMute(true);
  await setPlayback("next");
  expect(f.mock.calls.map((c) => c[0])).toEqual([
    "/YamahaExtendedControl/v1/main/setMute?enable=true",
    "/YamahaExtendedControl/v1/netusb/setPlayback?playback=next",
  ]);
});

test("inputs carry the user's names and now-playing source", async () => {
  const f = vi.fn(async (url: string) =>
    new Response(fixture(url.includes("getFeatures") ? "system_getFeatures" : "system_getNameText")),
  );
  vi.stubGlobal("fetch", f);
  const inputs = await getInputs();
  expect(inputs).toHaveLength(24);
  expect(inputs.find((i) => i.id === "hdmi1")).toEqual({ id: "hdmi1", name: "MIBOX4", playInfoType: "none" });
  expect(inputs.find((i) => i.id === "tuner")?.playInfoType).toBe("tuner");
});

test("recents are numbered from 1 for recallRecentItem", async () => {
  mockFetch(fixture("netusb_getRecentInfo"));
  const recents = await getRecents();
  expect(recents[0]).toMatchObject({ num: 1, text: "Radio Pulsar (Poitiers/French)" });
  expect(recents).toHaveLength(5); // the other 35 slots are empty

});

test("selectInput wakes the input before switching", async () => {
  const f = mockFetch('{"response_code":0}');
  await selectInput("hdmi1");
  expect(f.mock.calls.map((c) => c[0])).toEqual([
    "/YamahaExtendedControl/v1/main/prepareInputChange?input=hdmi1",
    "/YamahaExtendedControl/v1/main/setInput?input=hdmi1",
  ]);
});

test("addFavorite stores into the first empty slot", async () => {
  const presets = JSON.parse(fixture("netusb_getPresetInfo"));
  presets.preset_info[0] = { input: "net_radio", text: "Rinse France" };
  const f = vi.fn(async (url: string) =>
    new Response(url.includes("getPresetInfo") ? JSON.stringify(presets) : '{"response_code":0}'),
  );
  vi.stubGlobal("fetch", f);
  expect(await addFavorite()).toBe(2);
  expect(f.mock.calls.at(-1)?.[0]).toBe("/YamahaExtendedControl/v1/netusb/storePreset?num=2");
});

test("tuner play info renders frequency when there is no RDS name", async () => {
  mockFetch(fixture("tuner_getPlayInfo"));
  expect(await getTunerPlayInfo()).toMatchObject({ track: "FM 98.30 MHz", attribute: 0 });
});
