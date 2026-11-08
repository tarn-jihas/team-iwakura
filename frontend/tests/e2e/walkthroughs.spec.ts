import { expect, test, type Page } from '@playwright/test';

const action = (page: Page, name: string) => page.locator(`[data-action="${name}"]:not([disabled])`).first();
const dialog = (page: Page) => page.getByRole('dialog');

test('Case 1 · analytics reconciliation: USD +21.97 / EUR +989.01 → USD +11.98 / EUR 0.00', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-page="lab"]').click();
  await action(page, 'reset-preview').click();
  await dialog(page).locator('[data-action="reset"]').click();
  await expect(page.getByText('Fixed seed restored. Six groups, seven findings.')).toBeVisible();

  const gaps = page.locator('.currency-card .currency-gap');
  await expect(gaps.nth(0)).toContainText('+21.97');
  await expect(gaps.nth(1)).toContainText('+989.01');
  await expect(page.locator('article.mock-group')).toHaveCount(6);

  // Evidence for the price mismatch: 9.99 at source, 999.00 downstream.
  await page.locator('[data-action="evidence"][data-txn="txn_price"]').first().click();
  await expect(dialog(page)).toContainText('999.00');
  await dialog(page).locator('footer [data-action="close-modal"]').click();

  // Local mapping for the renamed event: zero destination writes.
  await action(page, 'map-preview').click();
  await dialog(page).locator('#mapping-ack').check();
  await dialog(page).locator('[data-action="map"]').click();
  await expect(page.getByText('Local mapping accepted. Zero destination events imported.')).toBeVisible();

  // Preview → approve → apply the three repair groups.
  await action(page, 'preview').click();
  const d = dialog(page);
  const groups = d.locator('input[data-select]');
  await expect(groups).toHaveCount(3);
  for (const box of await groups.all()) await box.check();
  await expect(d.locator('[data-action="apply"]')).toBeDisabled();
  await d.locator('#approval-ack').check();
  await d.locator('[data-action="approve"]').click();
  await expect(d.getByText('Approval saved')).toBeVisible();
  await d.locator('[data-action="apply"]').click();
  await expect(page.locator('#toast-root')).toContainText('4 writes accepted locally');

  // Pending until the mock clock advances, then a fresh verify.
  await action(page, 'advance').click();
  await expect(page.getByText('Mock clock advanced. Run Verify to save a fresh readback.')).toBeVisible();
  await action(page, 'verify').click();
  await expect(gaps.nth(0)).toContainText('+11.98');
  await expect(gaps.nth(1)).toContainText('0.00');
  await expect(gaps.nth(1)).not.toContainText('+');
});

test('Case 2 · paid access recovery: 403 → 100/94/24/6 → 23/1 → 24/0 → 200', async ({ page }) => {
  await page.goto('/access.html#lumen');
  await action(page, 'reset-preview').click();
  await dialog(page).locator('[data-action="reset"]').click();
  await expect(page.getByText('Synthetic 100-account access scenario reset.')).toBeVisible();

  // Detect the blast radius.
  await page.locator('[data-view="incident"]').click();
  await page.getByRole('button', { name: 'Detect blast radius' }).click();
  const stats = page.locator('.access-stat strong');
  await expect(stats.nth(0)).toHaveText('100');
  await expect(stats.nth(1)).toHaveText('94');
  await expect(stats.nth(2)).toHaveText('24');
  await expect(stats.nth(3)).toHaveText('6');

  // A confirmed paying customer is denied at the real premium gate.
  await page.locator('#account-filter').selectOption('confirmed');
  const user = (await page.locator('.access-account-table [data-action="evidence"]').first().innerText()).replace(' ↗', '').trim();
  await page.locator('#account-filter').selectOption('all');
  await page.locator('[data-view="lumen"]').click();
  await page.locator('#lumen-user').selectOption(user);
  await action(page, 'lumen-export').click();
  await expect(page.locator('.lumen-gate-result')).toContainText('403 · Premium export denied');
  await page.locator('[data-view="incident"]').click();

  // Preview → approve → apply all 24 eligible accounts.
  await action(page, 'select-eligible').click();
  await action(page, 'preview').click();
  await expect(dialog(page)).toContainText('24 accounts selected');
  await expect(dialog(page).locator('[data-action="apply"]')).toBeDisabled();
  await dialog(page).locator('#access-ack').check();
  await dialog(page).locator('[data-action="approve"]').click();
  await expect(dialog(page).getByText('Human approval saved')).toBeVisible();
  await dialog(page).locator('[data-action="apply"]').click();
  await expect(page.getByText(/24 local resyncs accepted/)).toBeVisible();

  // Verify the actual gates: one stale cache remains.
  await action(page, 'verify').click();
  await expect(page.locator('.access-recovery-card')).toContainText('23 verified / 1 unresolved');

  // A repeated apply writes nothing new and does not hide the failure.
  await action(page, 'repeat').click();
  await expect(page.getByText(/^0 local resyncs accepted/)).toBeVisible();

  // Fresh bounded retry for the unresolved account.
  await action(page, 'retry-preview').click();
  await expect(dialog(page)).toContainText('1 accounts selected');
  await dialog(page).locator('#access-ack').check();
  await dialog(page).locator('[data-action="approve"]').click();
  await expect(dialog(page).getByText('Human approval saved')).toBeVisible();
  await dialog(page).locator('[data-action="apply"]').click();
  await action(page, 'verify').click();
  await expect(page.locator('.access-recovery-card')).toContainText('Access restored · root cause separate');

  // The same customer can export again.
  await page.locator('[data-view="lumen"]').click();
  await page.locator('#lumen-user').selectOption(user);
  await action(page, 'lumen-export').click();
  await expect(page.locator('.lumen-gate-result')).toContainText('200 · Premium export allowed');
});
