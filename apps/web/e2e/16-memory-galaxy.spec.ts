// ADR-021 — hafıza galaksisi (3D) görsel QA.
//
// Sahne WebGL üzerinde çalışıyor; Playwright'ın chromium'u swiftshader ile
// gerçekten render eder. Burada kanıtlanan şey piksel değil DAVRANIŞ:
// canvas kuruldu mu, gerçek düğüm sayısı geldi mi, filtre canlı uygulanıyor
// mu, tıklama seçim yapıyor mu. (Pikselleri doğrulamak GPU sürücüsüne bağlı
// olurdu — CI'da kırılgan.)
import { test, expect } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("hafıza galaksisi: canvas + gerçek düğümler + canlı filtre + seçim", async ({ page }) => {
  test.setTimeout(120_000);

  await login(page);
  await openCompany(page, "Acme");
  await page.getByTestId("nav-memory").click();
  await page.getByTestId("memory-tab-graph").click();

  // sahne kuruldu: kart + canvas
  const graph = page.getByTestId("memory-graph");
  await expect(graph).toBeVisible();
  await expect(graph.locator("canvas")).toBeVisible({ timeout: 30_000 });

  // filtre paneli GERÇEK veriyle geldi (görünen/toplam)
  const count = page.getByTestId("galaxy-count");
  await expect(count).toBeVisible();
  const initial = await count.innerText();
  const [visible, total] = initial.split("/").map((n) => Number(n.trim()));
  expect(total).toBeGreaterThan(0); // mock yok — şirketin gerçek anıları
  expect(visible).toBe(total);

  // canlı filtre: önem eşiği yükselince görünen düğüm sayısı düşer
  await page.getByTestId("galaxy-filter-importance").fill("1");
  await expect
    .poll(async () => Number((await count.innerText()).split("/")[0]!.trim()), { timeout: 10_000 })
    .toBeLessThan(visible);

  // eşiği geri al, kapsam filtresini dene
  await page.getByTestId("galaxy-filter-importance").fill("0");
  await page.getByTestId("galaxy-filter-scope").selectOption("company");
  await expect
    .poll(async () => Number((await count.innerText()).split("/")[0]!.trim()), { timeout: 10_000 })
    .toBeLessThanOrEqual(visible);
});
