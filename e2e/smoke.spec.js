import { test, expect } from '@playwright/test';

test('app loads without page errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await expect(page.locator('.lib-layout')).toBeVisible();
  expect(errors).toEqual([]);
});

test('library renders topbar and toolbar', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.lib-topbar')).toBeVisible();
  await expect(page.locator('.lib-search')).toBeVisible();
});

test('settings modal opens and closes', async ({ page }) => {
  await page.goto('/');
  await page.locator('button[title="Ustawienia"]').click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  await expect(modal.locator('.modal-title')).toHaveText('Konto i synchronizacja');
  await modal.locator('.modal-close').click();
  await expect(modal).toBeHidden();
});
