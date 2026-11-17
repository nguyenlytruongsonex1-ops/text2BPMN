// Real browser QA. No key is read by this script; paid calls require --live.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
const live = process.argv.includes("--live");
const url = process.env.CHECKER_SMOKE_URL || "http://127.0.0.1:8080";
assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Local pilot only");
await mkdir("screenshots", { recursive: true });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole("button", { name: "Xem ví dụ", exact: true }).click();
  await page.locator(".djs-element[data-element-id]").first().waitFor({ timeout: 30000 });
  const panel = page.locator('[aria-labelledby="checker-heading"]');
  await panel.waitFor();
  await page.getByRole("button", { name: "Thêm yêu cầu thủ công", exact: true }).click();
  await panel.locator('textarea[id^="req-assert-"]').first().fill("Có hoạt động nhân viên gửi đơn nghỉ phép.");
  await panel.locator('textarea[id^="req-source-"]').first().fill("Nhân viên gửi đơn nghỉ phép.");
  assert.equal(await page.locator("#checker-strategy").inputValue(), "strong", "Strong checker must be the benchmark-backed default");
  if (live) {
    // Keep this UI regression deterministic: manual requirement, real paid checker.
    // Source-only LLM extraction is separately unit-tested and can reject invented quotes.
    await page.getByRole("button", { name: "Kiểm tra sơ đồ hiện tại", exact: true }).click();
    await Promise.race([
      page.getByRole("heading", { name: "Kết quả đánh giá LLM", exact: true }).waitFor({ timeout: 65000 }),
      panel.getByRole("alert").waitFor({ timeout: 65000 }).then(async () => { throw new Error(await panel.getByRole("alert").innerText()); }),
    ]);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "Xuất bản ghi JSON", exact: true }).click();
    const download = await downloadEvent;
    await download.saveAs("screenshots/checker-ui-live-run.json");
    const record = JSON.parse(await readFile("screenshots/checker-ui-live-run.json", "utf8"));
    assert.equal(record.stale, false);
    assert.equal(record.reports.length, 1);
    const run = record.reports[0].runs[0];
    assert.equal(run.provider, "DeepInfra");
    assert(run.inputTokens > 0, "A real model response was received");
    if (run.error) assert.equal(record.reports[0].status, "unknown", "Protocol errors must fail closed");
    assert(record.snapshot.xml.includes("definitions"));
    assert(!JSON.stringify(record).includes("sk-or-"));
    // Edit the actual canvas, not the source/IR, then require stale detection.
    const shape = page.locator('.djs-shape[data-element-id$="_UserTask_n1"] .djs-visual').first();
    await shape.dblclick({ force: true });
    const editor = page.locator(".djs-direct-editing-content");
    await editor.waitFor();
    await editor.fill("Sửa tên bước để kiểm tra snapshot");
    await page.locator("#checker-heading").click();
    await panel.getByRole("status").filter({ hasText: "Kết quả cũ:" }).waitFor({ timeout: 8000 });
  }
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "screenshots/checker-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "screenshots/checker-mobile.png" });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "Mobile horizontal overflow");
  assert.deepEqual(errors, [], "Uncaught browser errors");
  await writeFile("screenshots/checker-ui-verdict.json", JSON.stringify({ ok: true, live, desktop: true, mobile: true, errors, actualCanvasEditStale: live }, null, 2));
  console.log(JSON.stringify({ ok: true, live, desktop: true, mobile: true, actualCanvasEditStale: live }));
} finally {
  await browser.close();
}
