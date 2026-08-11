import { expect, type Page } from "@playwright/test";

export const FOUNDER_EMAIL = "founder@acme.local";
export const FOUNDER_PASSWORD = process.env.SEED_FOUNDER_PASSWORD ?? "founder-dev-password";

export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', FOUNDER_EMAIL);
  await page.fill('input[name="password"]', FOUNDER_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page.getByTestId("company-list")).toBeVisible({ timeout: 15_000 });
}

export async function openCompany(page: Page, name: string): Promise<void> {
  await page.getByTestId("company-list").getByText(name, { exact: false }).first().click();
  await expect(page.getByTestId("me-name")).toBeVisible();
}
