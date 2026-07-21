import { test, expect } from '@playwright/test';

// Baseline'y wizualne dla refaktoru CSS — porównanie pikselowe głównych widoków.
test('visual: library', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.lib-layout')).toBeVisible();
  await expect(page).toHaveScreenshot('library.png', { fullPage: true });
});

test('visual: settings modal', async ({ page }) => {
  await page.goto('/');
  await page.locator('button[title="Ustawienia"]').click();
  await expect(page.locator('.modal')).toBeVisible();
  await expect(page).toHaveScreenshot('settings.png', { fullPage: true });
});

test('visual: library mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.lib-layout')).toBeVisible();
  await expect(page).toHaveScreenshot('library-mobile.png', { fullPage: true });
});
