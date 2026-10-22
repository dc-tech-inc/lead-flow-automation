import type { AddressInfo } from "node:net";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { seedStore } from "../../src/seed.js";
import { MemoryStore } from "../../src/store.js";

// Headless browser test. Also regenerates docs/dashboard.png, the screenshot used in the README.
// Locally: PW_CHANNEL=msedge pnpm test:e2e   (CI installs Playwright's chromium instead).
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base: string;

beforeAll(async () => {
  const store = new MemoryStore();
  await seedStore(store, { count: 400, days: 30, seed: 42, now: new Date() });
  const crm = { createContact: async () => ({ id: "unused" }) };
  const enrichment = { lookup: async () => ({ company: null }) };
  server = createApp({ secret: "e2e-secret-0123456789", store, crm, enrichment }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("dashboard in a real browser", () => {
  it("renders labelled synthetic metrics and saves a screenshot", async () => {
    const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: "light" });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

      await page.goto(base);
      await page.locator("#content").waitFor({ state: "visible" });

      expect(await page.locator("#dataset-badge").textContent()).toBe("Synthetic data");
      expect(await page.locator("#footnote").textContent()).toContain("Synthetic data");
      expect(await page.locator("#hero-value").textContent()).toMatch(/\d+[smh]/);
      expect(await page.locator("#src-table tbody tr").count()).toBe(3);
      expect(await page.locator("#daily rect.bar").count()).toBeGreaterThan(10);

      // Switching the window re-queries the API and keeps the label.
      await page.selectOption("#window", "7");
      await page.waitForResponse((r) => r.url().includes("days=7"));
      expect(await page.locator("#dataset-badge").isVisible()).toBe(true);

      await page.selectOption("#window", "30");
      await page.waitForResponse((r) => r.url().includes("days=30"));
      await page.locator("#content").waitFor({ state: "visible" });
      await mkdir("docs", { recursive: true });
      await page.screenshot({ path: "docs/dashboard.png", fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
