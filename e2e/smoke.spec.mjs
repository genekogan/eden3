import { expect, test } from '@playwright/test';

test('web shell loads without a fatal browser error', async ({ page }) => {
  const fatal = [];
  page.on('pageerror', (error) => fatal.push(error.message));
  const response = await page.goto('/');
  expect(response?.ok()).toBe(true);
  await expect(page.locator('body')).toBeVisible();
  expect(fatal).toEqual([]);
});
