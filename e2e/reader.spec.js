import { test, expect } from '@playwright/test';

test('import EPUB and open reader', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.locator('input[type="file"][accept=".epub"]').setInputFiles('e2e/fixtures/test-book.epub');

  // Dialog importu z metadanymi
  const importDialog = page.getByRole('dialog');
  await expect(importDialog).toBeVisible();
  await expect(importDialog.getByLabel('Tytuł')).toHaveValue('Książka testowa');
  await importDialog.getByRole('button', { name: 'Dodaj książkę' }).click();

  // Książka w bibliotece
  const bookCard = page.getByText('Książka testowa').first();
  await expect(bookCard).toBeVisible();

  // Otwarcie czytnika
  await bookCard.click();
  await expect(page.locator('.ch-body')).toBeVisible();
  await expect(page.locator('.ch-body')).toContainText('Ala ma kota');

  // Czytnik startuje w trybie bez rozproszeń — tap w środek pokazuje paski
  await page.locator('.ch-scroll').click({ position: { x: 640, y: 360 } });
  await expect(page.locator('.reader-layout')).not.toHaveClass(/distraction-free/);

  // Menu ustawień czytnika
  await page.locator('.topbar button[title="Ustawienia"]').click();
  await expect(page.locator('.reader-float-menu')).toBeVisible();
  await expect(page.locator('.reader-float-menu')).toContainText('Rozmiar');
  await page.keyboard.press('Escape');

  // Sidebar (spis treści)
  await page.locator('button[title="Spis treści"]').click();
  await expect(page.getByRole('dialog')).toContainText('Rozdział drugi');

  expect(errors).toEqual([]);
});
