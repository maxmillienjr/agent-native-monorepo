import { test, expect } from '@playwright/test';

test.describe('Console smoke test', () => {
  test('renders the main page with form elements', async ({ page }) => {
    await page.goto('/');

    // Check header
    await expect(page.locator('h1')).toContainText('Agent Console');

    // Check form elements
    await expect(page.locator('#session-id')).toBeVisible();
    await expect(page.locator('#query')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText('Submit Run');
  });

  test('submit button is disabled with empty query', async ({ page }) => {
    await page.goto('/');

    const submitButton = page.locator('button[type="submit"]');
    await expect(submitButton).toBeDisabled();
  });

  test('submit button becomes enabled when query is entered', async ({ page }) => {
    await page.goto('/');

    await page.fill('#query', 'What is LangGraph?');
    const submitButton = page.locator('button[type="submit"]');
    await expect(submitButton).toBeEnabled();
  });

  test('shows streaming state when form is submitted', async ({ page }) => {
    await page.goto('/');

    await page.fill('#query', 'What is LangGraph?');
    await page.click('button[type="submit"]');

    // Submit button should show running state
    await expect(page.locator('button[type="submit"]')).toContainText('Running...');
  });

  test('a submitted run streams through to done on the authenticated stack', async ({ page }) => {
    // The service enforces a credential on the compose stack (P5-A), and the
    // console's nginx adds it. Without this, a token that never arrived would
    // still pass every test above: each one stops before a response is read.
    test.skip(
      !process.env['E2E_BASE_URL'],
      'needs the compose stack; the dev server has no backend',
    );

    await page.goto('/');
    await page.fill('#query', 'What is LangGraph?');
    await page.click('button[type="submit"]');

    await expect(page.getByText('[done]')).toBeVisible({ timeout: 30_000 });
  });

  test('displays stream viewer and run inspector panels', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText('Stream')).toBeVisible();
    await expect(page.getByText('Run Inspector')).toBeVisible();
    await expect(page.getByText('Waiting for events...')).toBeVisible();
    await expect(page.getByText('No run data yet')).toBeVisible();
  });
});
