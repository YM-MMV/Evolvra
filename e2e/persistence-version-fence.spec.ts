import { expect, test } from "@playwright/test";

const DATABASE_NAME = "evolvra-persistence";
const LEGACY_DATABASE_VERSION = 3;
const CURRENT_DATABASE_VERSION = 4;

test("a v4 app fences an open v3 tab and assigns ownership to preserved live evidence", async ({ context, page }) => {
  const legacyPage = await context.newPage();
  await legacyPage.goto("/icon.svg");

  await legacyPage.evaluate(async ({ databaseName, legacyVersion }) => {
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase(databaseName);
      deletion.onerror = () => reject(deletion.error ?? new Error("The legacy database could not be cleared."));
      deletion.onblocked = () => reject(new Error("The legacy database deletion was blocked."));
      deletion.onsuccess = () => resolve();
    });

    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open(databaseName, legacyVersion);
      opening.onerror = () => reject(opening.error ?? new Error("The v3 database could not be opened."));
      opening.onupgradeneeded = () => {
        const database = opening.result;
        database.createObjectStore("workspaces", { keyPath: "accountId" });
        const evidence = database.createObjectStore("evidence", {
          keyPath: ["accountId", "goalId", "evidenceId"],
        });
        evidence.createIndex("by-account", "accountId", { unique: false });
        evidence.createIndex("by-account-goal", ["accountId", "goalId"], { unique: false });
        database.createObjectStore("account-scopes", { keyPath: "accountId" });
        database.createObjectStore("account-erasure-checkpoints", { keyPath: "accountId" });
        database.createObjectStore("account-reminders", { keyPath: "accountId" });
        database.createObjectStore("legacy-import-claims", { keyPath: "accountId" });
      };
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction("evidence", "readwrite");
        transaction.objectStore("evidence").put({
          accountId: "legacy-account",
          goalId: "legacy-goal",
          evidenceId: "legacy-evidence",
          bytes: new TextEncoder().encode("legacy v3 evidence bytes").buffer,
          mimeType: "text/plain",
          savedAt: "2026-08-02T00:00:00.000Z",
        });
        transaction.onerror = () => reject(
          transaction.error ?? new Error("The legacy evidence fixture could not be saved."),
        );
        transaction.onabort = () => reject(
          transaction.error ?? new Error("The legacy evidence fixture transaction was aborted."),
        );
        transaction.oncomplete = () => {
          const scopedWindow = window as typeof window & {
            __legacyPersistenceConnection?: IDBDatabase;
            __legacyPersistenceVersionChange?: { oldVersion: number; newVersion: number | null };
          };
          scopedWindow.__legacyPersistenceConnection = database;
          database.onversionchange = (event) => {
            scopedWindow.__legacyPersistenceVersionChange = {
              oldVersion: event.oldVersion,
              newVersion: event.newVersion,
            };
            database.close();
            delete scopedWindow.__legacyPersistenceConnection;
          };
          resolve();
        };
      };
    });
  }, { databaseName: DATABASE_NAME, legacyVersion: LEGACY_DATABASE_VERSION });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Build a life you can see evolving." })).toBeVisible();
  await expect.poll(() => legacyPage.evaluate(() => {
    const scopedWindow = window as typeof window & {
      __legacyPersistenceVersionChange?: { oldVersion: number; newVersion: number | null };
    };
    return scopedWindow.__legacyPersistenceVersionChange ?? null;
  }), {
    message: "the v3 tab should close its database connection when the v4 app opens",
  }).toEqual({ oldVersion: LEGACY_DATABASE_VERSION, newVersion: CURRENT_DATABASE_VERSION });

  const persistedLegacyEvidence = await page.evaluate(async ({ databaseName }) => {
    return await new Promise<{
      databaseVersion: number;
      text: string;
      type: string;
      size: number;
      writeId: string | null;
      stagingStoreExists: boolean;
    }>((resolve, reject) => {
      const opening = indexedDB.open(databaseName);
      opening.onerror = () => reject(opening.error ?? new Error("The upgraded database could not be opened."));
      opening.onsuccess = () => {
        const database = opening.result;
        const databaseVersion = database.version;
        const stagingStoreExists = database.objectStoreNames.contains("evidence-staging");
        const transaction = database.transaction("evidence", "readonly");
        const read = transaction.objectStore("evidence").get([
          "legacy-account",
          "legacy-goal",
          "legacy-evidence",
        ]);
        read.onerror = () => {
          database.close();
          reject(read.error ?? new Error("The legacy evidence record could not be read."));
        };
        read.onsuccess = () => {
          const bytes: unknown = read.result?.bytes;
          const mimeType: unknown = read.result?.mimeType;
          const writeId: unknown = read.result?.writeId;
          if (!(bytes instanceof ArrayBuffer) || typeof mimeType !== "string") {
            database.close();
            reject(new Error("The v3 live evidence record did not survive the v4 upgrade."));
            return;
          }
          const text = new TextDecoder().decode(bytes);
          database.close();
          resolve({
            databaseVersion,
            text,
            type: mimeType,
            size: bytes.byteLength,
            writeId: typeof writeId === "string" ? writeId : null,
            stagingStoreExists,
          });
        };
      };
    });
  }, { databaseName: DATABASE_NAME });

  expect(persistedLegacyEvidence).toEqual({
    databaseVersion: CURRENT_DATABASE_VERSION,
    text: "legacy v3 evidence bytes",
    type: "text/plain",
    size: 24,
    writeId: expect.any(String),
    stagingStoreExists: true,
  });

  const downgradeError = await page.evaluate(async ({ databaseName, legacyVersion }) => {
    return await new Promise<string | null>((resolve) => {
      const opening = indexedDB.open(databaseName, legacyVersion);
      opening.onerror = () => resolve(opening.error?.name ?? null);
      opening.onsuccess = () => {
        opening.result.close();
        resolve(null);
      };
    });
  }, { databaseName: DATABASE_NAME, legacyVersion: LEGACY_DATABASE_VERSION });

  expect(downgradeError).toBe("VersionError");
});
