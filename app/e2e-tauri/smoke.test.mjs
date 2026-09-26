// Read-only smoke test on the real Tauri binary + real receiver: catches what the browser e2e can't
// (plugin-http scope, Rust discovery). Only GET requests happen: nothing is clicked.
// Run: npm run e2e:tauri   (needs tauri-driver + WebKitWebDriver)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { Builder, By, until } from "selenium-webdriver";

const APP = new URL("../src-tauri/target/debug/yxc-remote", import.meta.url).pathname;
let driverProc, driver;

before(async () => {
  execSync("npx tauri build --debug --no-bundle", { stdio: "inherit" });
  driverProc = spawn(`${process.env.HOME}/.cargo/bin/tauri-driver`, [], { stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 1000));
  driver = await launch();
});

const launch = () =>
  new Builder()
    .usingServer("http://127.0.0.1:4444/")
    .withCapabilities({ browserName: "wry", "tauri:options": { application: APP } })
    .build();

after(async () => {
  await driver?.quit();
  driverProc?.kill();
});

// Header shows a discovered receiver's name instead of "Find receiver".
// (WebKit's getText skips button labels, so read textContent.)
const receiverNamed = (ms) =>
  driver.wait(async () => {
    const [header] = await driver.findElements(By.css('[data-testid="receiver"]'));
    const text = header && (await driver.executeScript("return arguments[0].textContent", header));
    return text && !text.startsWith("Find receiver");
  }, ms);

// Power button appears once getStatus succeeded, whether the receiver is on or in standby
const statusLoaded = (ms) => driver.wait(until.elementLocated(By.css('[data-testid="power"]')), ms);

test("finds the receiver on the LAN and reads its status", async () => {
  await statusLoaded(15000);
  const body = await driver.findElement(By.css("body")).getText();
  assert.doesNotMatch(body, /Receiver unreachable/);
  await receiverNamed(5000);
});

test("first launch: discovers the receiver over SSDP", async () => {
  // Forget the saved receiver (shared with `tauri dev`) and relaunch; discovery picks it again on its own.
  // (A page reload instead sometimes leaves WebKitGTK on a blank page.)
  await driver.executeScript('localStorage.removeItem("receiver")');
  await driver.quit();
  driver = await launch();
  await receiverNamed(15000);
  await statusLoaded(10000);
});
