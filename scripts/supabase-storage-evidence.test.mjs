import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  assessRestoreTarget,
  objectStorageRelativePath,
  runBackup,
  runRestore,
  runVerify,
  stableStringify,
  validateNewPath,
} from "./supabase-storage-evidence.mjs";

const TEST_KEY = `service-role-${"x".repeat(40)}`;
const OBJECT_PATH = "account-a/goal-a/evidence-a/proof.txt";
const OBJECT_BYTES = Buffer.from("private evidence bytes\n", "utf8");

function mockStorage({ failDownload = false } = {}) {
  let restored;
  return {
    async fetch(input, init) {
      assert.equal(init.headers.apikey, TEST_KEY);
      assert.equal(init.headers.authorization, `Bearer ${TEST_KEY}`);
      const url = new URL(input);
      if (init.method === "POST" && url.pathname === "/storage/v1/object/list/evidence") {
        const body = JSON.parse(init.body);
        const rows = new Map([
          ["", [{ name: "account-a", id: null }]],
          ["account-a", [{ name: "goal-a", id: null }]],
          ["account-a/goal-a", [{ name: "evidence-a", id: null }]],
          ["account-a/goal-a/evidence-a", [{
            name: "proof.txt",
            id: "object-id",
            bucket_id: "evidence",
            created_at: "2026-07-29T00:00:00.000Z",
            updated_at: "2026-07-29T00:00:00.000Z",
            last_accessed_at: null,
            metadata: {
              size: OBJECT_BYTES.length,
              mimetype: "text/plain",
              cacheControl: "3600",
            },
          }]],
        ]);
        return Response.json(rows.get(body.prefix) ?? []);
      }
      if (
        url.pathname
        === `/storage/v1/object/evidence/${OBJECT_PATH}`
        && init.method === "GET"
      ) {
        if (failDownload) {
          return Response.json({ message: OBJECT_PATH }, { status: 403 });
        }
        return new Response(restored ?? OBJECT_BYTES, {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "content-length": String((restored ?? OBJECT_BYTES).length),
          },
        });
      }
      if (
        url.pathname
        === `/storage/v1/object/evidence/${OBJECT_PATH}`
        && init.method === "POST"
      ) {
        const chunks = [];
        for await (const chunk of init.body) chunks.push(chunk);
        restored = Buffer.concat(chunks);
        return Response.json({});
      }
      return Response.json({ message: "not found" }, { status: 404 });
    },
    restored: () => restored,
  };
}

test("stable metadata serialization and local object mapping are deterministic", () => {
  assert.equal(stableStringify({ z: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"z":1}');
  const mapped = objectStorageRelativePath(OBJECT_PATH);
  assert.match(mapped, /^objects\/[a-f0-9]{64}\.bin$/);
  assert.doesNotMatch(mapped, /\.\./);
  assert.throws(() => objectStorageRelativePath("../not/a/remote/path"), /unsafe/);
});

test("new output validation rejects relative, existing, and symlink paths", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "evolvra-storage-path-")));
  try {
    await assert.rejects(() => validateNewPath("relative"), /absolute/);
    await assert.rejects(() => validateNewPath(root), /already exists/);
    const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
    await symlink(root, link);
    await assert.rejects(
      () => validateNewPath(path.join(link, "backup")),
      /symlink/,
    );
    await rm(link);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore target classification excludes production from drills", () => {
  assert.throws(
    () => assessRestoreTarget({
      targetUrl: "https://production.supabase.co",
      targetKind: "drill",
      productionUrl: "https://production.supabase.co",
      allowRemoteDrill: true,
    }),
    /cannot target the production/,
  );
  assert.throws(
    () => assessRestoreTarget({
      targetUrl: "https://production.supabase.co",
      targetKind: "production",
      productionUrl: "https://production.supabase.co",
      allowProductionRestore: true,
    }),
    /EVOLVRA_CONFIRM_PRODUCTION_STORAGE_RESTORE/,
  );
  assert.deepEqual(
    assessRestoreTarget({
      targetUrl: "http://127.0.0.1:54321",
      targetKind: "drill",
    }),
    {
      targetOrigin: "http://127.0.0.1:54321",
      targetKind: "drill",
    },
  );
  assert.deepEqual(
    assessRestoreTarget({
      targetUrl: "https://production.supabase.co",
      targetKind: "production",
      productionUrl: "https://production.supabase.co",
      allowProductionRestore: true,
      productionConfirmation: "RESTORE_EVIDENCE_TO_PRODUCTION",
    }),
    {
      targetOrigin: "https://production.supabase.co",
      targetKind: "production",
    },
  );
});

test("a partial backup stays unpublished and records only a hashed object identity", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "evolvra-storage-failure-")));
  const source = mockStorage({ failDownload: true });
  const backupPath = path.join(root, "must-not-be-published");
  try {
    await assert.rejects(
      () => runBackup({
        output: backupPath,
        sourceUrl: "http://127.0.0.1:54321",
        sourceKey: TEST_KEY,
        fetchImpl: source.fetch,
      }),
      /could not be backed up/,
    );
    await assert.rejects(() => lstat(backupPath), { code: "ENOENT" });
    const incompleteName = (await readdir(root)).find((name) => name.includes(".incomplete-"));
    assert.ok(incompleteName);
    const failure = await readFile(path.join(root, incompleteName, "FAILURE.json"), "utf8");
    assert.equal(failure.includes(OBJECT_PATH), false);
    assert.match(failure, /objectPathSha256/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  {
    failure: "parent directory open",
    openDirectory: async () => {
      throw new Error("forced parent directory open failure");
    },
  },
  {
    failure: "parent directory fsync",
    openDirectory: async () => ({
      async sync() {
        throw new Error("forced parent directory fsync failure");
      },
      async close() {},
    }),
  },
])("a $failure failure after rename rolls publication back", async ({ openDirectory }) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "evolvra-storage-publish-")));
  const source = mockStorage();
  const backupPath = path.join(root, "must-not-be-published");
  try {
    await assert.rejects(
      () => runBackup({
        output: backupPath,
        sourceUrl: "http://127.0.0.1:54321",
        sourceKey: TEST_KEY,
        fetchImpl: source.fetch,
        publicationFileSystem: { openDirectory },
      }),
      /rolled back/,
    );
    await assert.rejects(() => lstat(backupPath), { code: "ENOENT" });
    const incompleteNames = (await readdir(root))
      .filter((name) => name.includes(".incomplete-"));
    assert.equal(incompleteNames.length, 1);
    const failure = await readFile(
      path.join(root, incompleteNames[0], "FAILURE.json"),
      "utf8",
    );
    assert.equal(failure.includes(OBJECT_PATH), false);
    assert.match(failure, /publication/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backup, offline verification, and verified drill restore preserve bytes", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "evolvra-storage-backup-")));
  const source = mockStorage();
  const target = mockStorage();
  try {
    const sourceUrl = "http://127.0.0.1:54321";
    const targetUrl = "http://127.0.0.1:54322";
    const backupPath = path.join(root, "fresh-backup");
    const reportPath = path.join(root, "restore-report.json");
    const backup = await runBackup({
      output: backupPath,
      sourceUrl,
      sourceKey: TEST_KEY,
      pageSize: 2,
      concurrency: 2,
      timeoutMs: 5_000,
      maxObjectBytes: 1_024,
      fetchImpl: source.fetch,
    });
    assert.equal(backup.objectCount, 1);
    assert.equal(backup.totalBytes, OBJECT_BYTES.length);
    assert.equal(
      (await readFile(path.join(backupPath, "manifest.json"), "utf8")).includes(TEST_KEY),
      false,
    );

    const verified = await runVerify({ input: backupPath, concurrency: 2 });
    assert.equal(verified.manifestSha256, backup.manifestSha256);

    const restore = await runRestore({
      input: backupPath,
      report: reportPath,
      targetUrl,
      targetKey: TEST_KEY,
      targetKind: "drill",
      concurrency: 2,
      timeoutMs: 5_000,
      maxObjectBytes: 1_024,
      fetchImpl: target.fetch,
    });
    assert.equal(restore.objectCount, 1);
    assert.deepEqual(target.restored(), OBJECT_BYTES);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.status, "complete");
    assert.equal(report.failureCount, 0);

    const objectFile = path.join(backupPath, objectStorageRelativePath(OBJECT_PATH));
    await writeFile(objectFile, "tampered");
    await assert.rejects(() => runVerify({ input: backupPath }), /(size|hash) does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
