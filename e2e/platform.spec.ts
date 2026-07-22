import { expect, test } from "@playwright/test";
import { completeOnboarding } from "./helpers";

test("the install prompt is explicit, dismissible, and invokes the browser prompt", async ({ page }) => {
  await completeOnboarding(page, { name: "Install Tester", starter: false });
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: async () => { (window as typeof window & { __installPrompted?: boolean }).__installPrompted = true; },
      userChoice: Promise.resolve({ outcome: "accepted", platform: "test" }),
    });
    window.dispatchEvent(event);
  });

  await expect(page.getByRole("button", { name: "Install app" })).toBeVisible();
  await page.getByRole("button", { name: "Install app" }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __installPrompted?: boolean }).__installPrompted))).toBe(true);
  await expect(page.getByRole("button", { name: "Install app" })).toBeHidden();
});

test("a granted local reminder schedules a privacy-safe notification", async ({ page }) => {
  await page.addInitScript(() => {
    const notifications: Array<{ title: string; body?: string; tag?: string }> = [];
    Object.defineProperty(window, "__scheduledNotifications", { value: notifications, configurable: true });
    class GrantedNotification {
      static readonly permission: NotificationPermission = "granted";
      static requestPermission = async (): Promise<NotificationPermission> => "granted";

      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, body: options?.body, tag: options?.tag });
      }
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: GrantedNotification,
    });
    if ("ServiceWorkerRegistration" in window) {
      ServiceWorkerRegistration.prototype.showNotification = async function showNotification(title, options) {
        notifications.push({ title, body: options?.body, tag: options?.tag });
      };
    }
  });

  await completeOnboarding(page, { name: "Reminder Tester", starter: true });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByLabel("Reminder time").fill("00:00");
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    Object.defineProperty(registration, "showNotification", {
      configurable: true,
      value: async (title: string, options?: NotificationOptions) => {
        const notifications = (window as typeof window & {
          __scheduledNotifications?: Array<{ title: string; body?: string; tag?: string }>;
        }).__scheduledNotifications;
        notifications?.push({ title, body: options?.body, tag: options?.tag });
      },
    });
  });
  await page.getByRole("button", { name: "Turn reminders on" }).click();
  await expect(page.getByText(/private daily reminder will run/i)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __scheduledNotifications?: unknown[] }).__scheduledNotifications?.length ?? 0), { timeout: 15_000 }).toBeGreaterThan(0);
  const notification = await page.evaluate(() => (window as typeof window & { __scheduledNotifications?: Array<{ title: string; body?: string; tag?: string }> }).__scheduledNotifications?.[0]);
  expect(notification?.title).toBe("A calm Evolvra check-in");
  expect(notification?.body).toMatch(/^\d+ actions? (is|are) ready when you are\.$/);
  expect(notification?.tag).toMatch(/^evolvra-reminder-\d{4}-\d{2}-\d{2}$/);
  expect(JSON.stringify(notification)).not.toContain("Reminder Tester");
});
