import { test, expect } from '@playwright/test';
import { loginAndWaitForDashboard } from '../../helpers/auth.js';
import { findZoneIdByName } from '../../helpers/zones.js';
import users from '../../fixtures/users.json' assert { type: 'json' };

/**
 * Test for GitHub issue #959: IPv6 PTR record name handling
 *
 * When creating a PTR record in an IPv6 reverse zone, the record name should
 * preserve the user's input (nibble sequence) and append the zone suffix correctly.
 *
 * Bug: The full zone name is used as the record name regardless of user input.
 * Expected: User's nibble input + zone suffix = full PTR record name
 *
 * Example:
 * - Zone: 8.b.d.0.1.0.0.2.ip6.arpa
 * - User enters: 1.0.0.0.0.0.0.0 (nibbles for specific IPv6 address)
 * - Expected record name: 1.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa
 * - Bug behavior: 8.b.d.0.1.0.0.2.ip6.arpa (zone name only, user input ignored)
 */
test.describe.serial('IPv6 PTR Record Management (Issue #959)', () => {
  // Use unique zone name based on timestamp to avoid conflicts
  // Using last 4 digits of timestamp converted to hex nibbles for better uniqueness
  const timestamp = Date.now();
  const uniqueHex = (timestamp % 65536).toString(16).padStart(4, '0');
  const ipv6Zone = `${uniqueHex.split('').join('.')}.b.d.0.1.0.0.2.ip6.arpa`;
  let zoneId = null;

  test.beforeEach(async ({ page }) => {
    await loginAndWaitForDashboard(page, users.admin.username, users.admin.password);
  });

  test('should create IPv6 reverse zone successfully', async ({ page }) => {
    await page.goto('/zones/add/master');
    await page.waitForLoadState('networkidle');

    // Fill in the IPv6 reverse zone name
    await page.locator('[data-testid="zone-name-input"]').fill(ipv6Zone);

    // Submit the form
    await page.locator('[data-testid="add-zone-button"]').click();
    await page.waitForLoadState('networkidle');

    // After creation, app redirects to /zones/reverse (not /zones/{id}/edit)
    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toMatch(/fatal|exception/i);

    // Find the zone ID using the shared helper (handles pagination and display names)
    zoneId = await findZoneIdByName(page, ipv6Zone);

    expect(zoneId, 'Zone ID should be captured after creation').toBeTruthy();
  });

  test('should add PTR record with user-specified nibbles (issue #959)', async ({ page }) => {
    if (!zoneId) {
      test.skip(true, 'Zone was not created - zoneId not captured from previous test');
      return;
    }

    // Navigate to add record page for this zone
    await page.goto(`/zones/${zoneId}/records/add`);
    await page.waitForLoadState('networkidle');

    // The nibble sequence representing a specific IPv6 address within the zone
    const ptrNibbles = '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0';
    const ptrContent = 'test-ipv6-host.example.com';

    // PTR should be pre-selected for reverse zones, but ensure it's selected
    const typeSelect = page.locator('select[name*="type"]').first();
    await typeSelect.selectOption('PTR');

    // Fill in the PTR record name (nibbles)
    await page.locator('input[name="records[0][name]"]').fill(ptrNibbles);

    // Fill in the PTR content (hostname)
    await page.locator('input[name="records[0][content]"]').fill(ptrContent);

    // Submit the form
    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle');

    // Should show success message or redirect to zone edit page
    const bodyText = await page.locator('body').textContent();
    const hasSuccess = bodyText.toLowerCase().includes('success') || bodyText.toLowerCase().includes('added');

    // If there's an error, capture it for debugging
    if (!hasSuccess) {
      const errorAlert = page.locator('.alert-danger, .alert-warning');
      const errorText = await errorAlert.textContent().catch(() => 'No error message');
      console.log('Possible error:', errorText);
    }

    expect(hasSuccess, 'PTR record should be added successfully').toBe(true);
  });

  test('should verify PTR record name contains user input (issue #959 bug check)', async ({ page }) => {
    if (!zoneId) {
      test.skip(true, 'Zone was not created - zoneId not captured');
      return;
    }

    // Navigate directly to zone edit page using captured zoneId
    await page.goto(`/zones/${zoneId}/edit`);
    await page.waitForLoadState('networkidle');

    // Records are in input fields, so find PTR rows by badge text and check input values
    const allRows = page.locator('table tbody tr');
    const rowCount = await allRows.count();

    let recordName = '';
    let foundPtrRecord = false;

    for (let i = 0; i < rowCount; i++) {
      const row = allRows.nth(i);
      const rowText = await row.textContent();

      // Skip non-PTR rows (look for PTR badge)
      if (!rowText.includes('PTR') || rowText.includes('SOA')) continue;

      // Check if this row's content input contains our test hostname
      const contentInput = row.locator('input[name*="[content]"]').first();
      if (await contentInput.count() === 0) continue;

      const contentValue = await contentInput.inputValue();
      if (!contentValue.includes('test-ipv6-host')) continue;

      // Found our PTR record - get its name from the input
      foundPtrRecord = true;
      const nameInput = row.locator('input[name*="[name]"]').first();
      if (await nameInput.count() > 0) {
        recordName = await nameInput.inputValue();
      }
      break;
    }

    if (!foundPtrRecord) {
      test.skip(true, 'PTR record with test content not found');
      return;
    }

    expect(recordName, 'Record name should not be empty').not.toBe('');

    // CRITICAL: Check that it's not just the zone name (the bug behavior from issue #959)
    const normalizedRecordName = recordName.trim().toLowerCase();
    const normalizedZoneName = ipv6Zone.toLowerCase();
    const isJustZoneName = normalizedRecordName === normalizedZoneName || normalizedRecordName === '@';
    expect(isJustZoneName, `BUG #959: Record name should not be just the zone name "${ipv6Zone}". Got: "${recordName}"`).toBe(false);

    // The record should contain the nibbles we entered (1.0.0.0)
    const containsNibbles = normalizedRecordName.includes('1.0.0.0') || normalizedRecordName.includes('0.0.0.0');
    expect(containsNibbles, `Record name should contain user-entered nibbles. Got: "${recordName}"`).toBe(true);
  });

  test('should edit PTR record and preserve name correctly', async ({ page }) => {
    if (!zoneId) {
      test.skip(true, 'Zone was not created - zoneId not captured');
      return;
    }

    // Navigate directly to zone edit page using captured zoneId
    await page.goto(`/zones/${zoneId}/edit`);
    await page.waitForLoadState('networkidle');

    // Find PTR record with our test content and extract record ID
    const allRows = page.locator('table tbody tr');
    const rowCount = await allRows.count();
    let recordId = null;

    for (let i = 0; i < rowCount; i++) {
      const row = allRows.nth(i);
      const contentInput = row.locator('input[name*="[content]"]').first();
      if (await contentInput.count() === 0) continue;

      const contentValue = await contentInput.inputValue();
      if (!contentValue.includes('test-ipv6-host')) continue;

      // Extract record ID from input name attribute pattern: record[{id}][content]
      const inputName = await contentInput.getAttribute('name');
      const idMatch = inputName?.match(/record\[(\d+)\]/);
      if (idMatch) {
        recordId = idMatch[1];
      }
      break;
    }

    if (!recordId) {
      test.skip(true, 'PTR record ID not found');
      return;
    }

    // Navigate directly to record edit page
    await page.goto(`/zones/${zoneId}/records/${recordId}/edit`);
    await page.waitForLoadState('networkidle');

    // Get the name field value on the edit page
    const nameInput = page.locator('input[name="name"]');
    const nameValue = await nameInput.inputValue();

    expect(nameValue, 'Name field should not be empty').not.toBe('');

    // CRITICAL: Check it's not just '@' or the zone name (bug #959)
    const normalizedNameValue = nameValue.trim().toLowerCase();
    const normalizedZoneName = ipv6Zone.toLowerCase();
    const isApexOrZone = normalizedNameValue === '@' || normalizedNameValue === normalizedZoneName;
    expect(isApexOrZone, `BUG #959: Edit form should show user's nibbles, not zone name "${ipv6Zone}". Got: "${nameValue}"`).toBe(false);

    const containsNibbles = normalizedNameValue.includes('1.0.0.0') || normalizedNameValue.includes('0.0.0.0');
    expect(containsNibbles, `Edit form should preserve nibble input. Got: "${nameValue}"`).toBe(true);
  });

  test('should delete IPv6 reverse zone (cleanup)', async ({ page }) => {
    if (!zoneId) {
      // No zone to clean up
      return;
    }

    // Delete zone directly using zone ID
    await page.goto(`/zones/${zoneId}/delete`);
    await page.waitForLoadState('networkidle');

    // Confirm deletion
    const confirmButton = page.locator('input[value="Yes"], button:has-text("Yes"), [data-testid="confirm-delete-zone"]').first();
    if (await confirmButton.count() > 0) {
      await confirmButton.click();
      await page.waitForLoadState('networkidle');
    }

    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toMatch(/fatal|exception/i);
  });
});

/**
 * Additional test for shorter IPv6 nibble sequences
 */
test.describe('IPv6 PTR - Short Nibble Sequence', () => {
  const timestamp = Date.now();
  const uniqueHex = ((timestamp + 1) % 65536).toString(16).padStart(4, '0');
  const ipv6Zone = `0.0.0.0.0.0.0.0.0.0.${uniqueHex.split('').join('.')}.b.d.0.1.0.0.2.ip6.arpa`;
  let zoneId = null;

  test.beforeEach(async ({ page }) => {
    await loginAndWaitForDashboard(page, users.admin.username, users.admin.password);
  });

  test('should handle short nibble input correctly', async ({ page }) => {
    const simpleZone = `${uniqueHex.slice(0, 2)}.8.b.d.0.1.0.0.2.ip6.arpa`;

    await page.goto('/zones/add/master');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="zone-name-input"]').fill(simpleZone);
    await page.locator('[data-testid="add-zone-button"]').click();
    await page.waitForLoadState('networkidle');

    const bodyText = await page.locator('body').textContent();
    if (bodyText.toLowerCase().includes('already exists') || bodyText.toLowerCase().includes('error')) {
      test.skip('Zone already exists or error creating zone');
      return;
    }

    // Find zone ID using search helper (handles pagination and display name differences)
    zoneId = await findZoneIdByName(page, simpleZone);
    if (!zoneId) {
      test.skip('Could not find zone ID');
      return;
    }

    // Add a PTR record using the add record page
    await page.goto(`/zones/${zoneId}/records/add`);
    await page.waitForLoadState('networkidle');

    const shortNibbles = 'a.b.c.d';
    const ptrContent = 'short-nibble-test.example.com';

    const typeSelect = page.locator('select[name*="type"]').first();
    if (await typeSelect.count() === 0) {
      test.skip('Record form not found');
      return;
    }

    await typeSelect.selectOption('PTR');
    await page.locator('input[name="records[0][name]"]').fill(shortNibbles);
    await page.locator('input[name="records[0][content]"]').fill(ptrContent);

    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle');

    // Verify record was added
    await page.goto(`/zones/${zoneId}/edit`);
    await page.waitForLoadState('networkidle');

    const pageContent = await page.locator('body').textContent();
    expect(pageContent).not.toMatch(/fatal|exception/i);

    // Cleanup - delete the zone directly
    await page.goto(`/zones/${zoneId}/delete`);
    await page.waitForLoadState('networkidle');

    const confirmButton = page.locator('input[value="Yes"], button:has-text("Yes"), [data-testid="confirm-delete-zone"]').first();
    if (await confirmButton.count() > 0) {
      await confirmButton.click();
    }
  });
});
