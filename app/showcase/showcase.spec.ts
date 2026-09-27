import { expect, Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// A fake receiver that reacts to commands, seeded from the recorded fixtures
const fixture = (name: string) =>
  JSON.parse(readFileSync(`${import.meta.dirname}/../../docs/fixtures/${name}.json`, "utf8"));
const MEDIA = `${import.meta.dirname}/../../docs/media`;

const TRACKS = ["Nova Lights - Night Drive", "The Quiet Ones - Late Bloom", "Sol Arena - Sunday Groove", "Mira K - Paper Boats"];

// Placeholder album art (the stations' real logos aren't ours to publish)
const art = (seed: number) => {
  const hue = (seed * 67) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${hue + 60},70%,30%)"/></linearGradient></defs>
<rect width="600" height="600" fill="url(#g)"/><text x="300" y="370" font-size="260" text-anchor="middle" fill="rgba(255,255,255,.85)">♪</text></svg>`;
};

async function fakeReceiver(page: Page) {
  const status = fixture("main_getStatus?zone=main");
  const play = { ...fixture("netusb_getPlayInfo"), albumart_url: "/YamahaRemoteControl/AlbumART/1.svg" };
  const recents = fixture("netusb_getRecentInfo");
  recents.recent_info.forEach((r: { albumart_url: string }, i: number) => (r.albumart_url = `http://art.example/${i + 2}.svg`));
  const names = fixture("system_getNameText");
  const nameOf = (id: string) => names.input_list.find((i: { id: string }) => i.id === id)?.text ?? id;
  const ok = { response_code: 0 };

  await page.route("**/YamahaExtendedControl/v1/**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace("/YamahaExtendedControl/v1/", "");
    const q = Object.fromEntries(url.searchParams);
    const json = (body: object) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    switch (path) {
      case "main/getStatus": return json(status);
      case "netusb/getPlayInfo": return json(play);
      case "system/getFeatures": return json(fixture("system_getFeatures"));
      case "system/getNameText": return json(names);
      case "netusb/getRecentInfo": return json(recents);
      case "netusb/getPresetInfo": return json(fixture("netusb_getPresetInfo"));
      case "main/setVolume":
        status.volume = Number(q.volume);
        return json(ok);
      case "main/setMute":
        status.mute = q.enable === "true";
        return json(ok);
      case "main/setInput":
        status.input = q.input;
        status.input_text = nameOf(q.input);
        play.input = q.input === "net_radio" ? "net_radio" : play.input;
        return json(ok);
      case "netusb/setPlayback":
        play.playback = q.playback;
        return json(ok);
      case "netusb/recallRecentItem": {
        const n = Number(q.num);
        Object.assign(play, {
          artist: recents.recent_info[n - 1].text,
          track: TRACKS[n % TRACKS.length],
          albumart_url: `/YamahaRemoteControl/AlbumART/${n + 1}.svg`,
          playback: "play",
        });
        return json(ok);
      }
      default: return json(ok);
    }
  });
  // the app's dev-only ?demo-cast mode: "casting" makes the receiver play our stream, as the real one does
  await page.route("**/demo/cast**", (route) => {
    if (new URL(route.request().url()).searchParams.get("on") === "true") {
      Object.assign(status, { input: "server", input_text: nameOf("server") });
      Object.assign(play, { input: "server", track: "Pixel 7", artist: "Phone audio", album: "", albumart_url: "", playback: "play" });
    }
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  const svg = (route: import("@playwright/test").Route) =>
    route.fulfill({ contentType: "image/svg+xml", body: art(Number(route.request().url().match(/(\d+)\.svg/)?.[1] ?? 1)) });
  await page.route("**/YamahaRemoteControl/**", svg);
  await page.route("http://art.example/**", svg);
}

const beat = (page: Page, ms = 1200) => page.waitForTimeout(ms);

test("showcase", async ({ page }) => {
  await fakeReceiver(page);
  await page.goto("/?demo-cast");
  await expect(page.getByTestId("track")).toContainText("Siraba");
  await beat(page, 1500);
  await page.screenshot({ path: `${MEDIA}/now-playing.png` });

  // volume: drag the slider a little
  const thumb = page.getByRole("slider", { name: "Volume" });
  const box = (await thumb.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  await beat(page);
  await page.getByRole("button", { name: "Mute" }).click();
  await beat(page);
  await page.getByRole("button", { name: "Muted" }).click();
  await beat(page);

  // one tap on a recently played station, then stop/play
  await page.getByRole("button", { name: "Rinse France", exact: true }).click();
  await beat(page, 1500);
  await page.getByRole("button", { name: "stop" }).click();
  await beat(page);
  await page.getByRole("button", { name: "play" }).click();
  await beat(page);

  // stations sheet
  await page.getByRole("button", { name: "Stations ▾" }).click();
  await beat(page);
  await page.screenshot({ path: `${MEDIA}/stations.png` });
  await page.getByRole("dialog", { name: "Stations" }).getByText("Radio Béton (Tours/French)").click();
  await beat(page, 1500);

  // pin the inputs you use
  await page.getByRole("button", { name: "Inputs ▾" }).click();
  const sheet = page.getByRole("dialog", { name: "Inputs" });
  await beat(page, 800);
  await sheet.getByRole("button", { name: "Edit" }).click();
  for (const name of ["Phone audio", "AUDIO1", "NET RADIO"]) {
    await sheet.getByRole("button", { name: `Pin ${name}`, exact: true }).click();
    await beat(page, 400);
  }
  await beat(page, 600);
  await page.screenshot({ path: `${MEDIA}/inputs.png` });
  await sheet.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Escape");
  await beat(page);

  // switch inputs from the pinned row
  await page.getByRole("button", { name: "AUDIO1", exact: true }).click();
  await beat(page, 1500);
  await page.getByRole("button", { name: "NET RADIO", exact: true }).click();
  await beat(page, 2000);

  // cast the phone's audio: short explanation, then Android's own prompt (not in a browser)
  await page.getByRole("button", { name: "Phone audio", exact: true }).click();
  await beat(page);
  await page.screenshot({ path: `${MEDIA}/cast.png` });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("track")).toContainText("Pixel 7");
  await beat(page, 2500);
});
