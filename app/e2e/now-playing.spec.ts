import { expect, Page, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// Receiver is fully mocked from fixtures: these tests never touch the real amp.
const fixture = (name: string) =>
  readFileSync(`${import.meta.dirname}/../../docs/fixtures/${name}.json`, "utf8");

const READS: Record<string, string> = {
  "main/getStatus": "main_getStatus?zone=main",
  "netusb/getPlayInfo": "netusb_getPlayInfo",
  "system/getFeatures": "system_getFeatures",
  "system/getNameText": "system_getNameText",
  "netusb/getRecentInfo": "netusb_getRecentInfo",
  "netusb/getPresetInfo": "netusb_getPresetInfo",
};

// Answers reads from fixtures, records every write command
async function mockReceiver(page: Page) {
  const sent: string[] = [];
  await page.route("**/YamahaExtendedControl/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname.replace("/YamahaExtendedControl/v1/", "");
    if (READS[path]) return route.fulfill({ body: fixture(READS[path]) });
    sent.push(path + new URL(route.request().url()).search);
    return route.fulfill({ body: '{"response_code":0}' });
  });
  await page.route("**/YamahaRemoteControl/**", (route) => route.fulfill({ status: 404 }));
  await page.route("http://static.airable.io/**", (route) => route.fulfill({ status: 404 }));
  return sent;
}

test("shows what is playing and controls volume, transport and mute", async ({ page }) => {
  const sent = await mockReceiver(page);
  await page.goto("/");
  await expect(page.getByTestId("track")).toContainText("Siraba");
  await expect(page.getByTestId("artist")).toContainText("Radio Pulsar");
  await expect(page.getByText("NET RADIO")).toBeVisible();
  await expect(page.getByTestId("volume-db")).toHaveText("-43.0 dB");

  await page.getByRole("slider", { name: "Volume" }).press("ArrowRight");
  await expect.poll(() => sent).toContain("main/setVolume?volume=76");

  // net radio: stop only, no pause or skip
  await expect(page.getByRole("button", { name: "next" })).toHaveCount(0);
  await page.getByRole("button", { name: "stop" }).click();
  await expect.poll(() => sent).toContain("netusb/setPlayback?playback=stop");

  await page.getByRole("button", { name: "Mute" }).click();
  await expect.poll(() => sent).toContain("main/setMute?enable=true");
});

test("pin an input, hide another, replay a station", async ({ page }) => {
  const sent = await mockReceiver(page);
  await page.goto("/");

  // stations row: no favorites yet, so recently played stations fill it
  await page.getByRole("button", { name: "Rinse France", exact: true }).click();
  await expect.poll(() => sent).toContain("netusb/recallRecentItem?zone=main&num=2");

  await page.getByRole("button", { name: "Inputs ▾" }).click();
  const sheet = page.getByRole("dialog", { name: "Inputs" });
  await sheet.getByRole("button", { name: "Edit" }).click();
  await sheet.getByRole("button", { name: "Pin AUDIO1" }).click();
  await sheet.getByRole("button", { name: "Show AV2" }).click();
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet.getByText("AV2")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "AUDIO1" }).click();
  await expect.poll(() => sent).toEqual(
    expect.arrayContaining(["main/prepareInputChange?input=audio1", "main/setInput?input=audio1"]),
  );
});
