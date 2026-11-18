import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  adjustWindowsCheckpointDirectory,
  assertWindowsCheckpointDirectoryPrivate,
  foreignWritersOf,
  readWindowsDirectoryAcl,
} from "./WindowsCheckpointDirectory.js";

const execFileAsync = promisify(execFile);

const grantAuthenticatedUsers = async (directory: string): Promise<void> => {
  await execFileAsync("icacls.exe", [
    directory,
    "/grant:r",
    "*S-1-5-11:(OI)(CI)M",
  ]);
};

describe.skipIf(process.platform !== "win32")(
  "Windows checkpoint directory privacy",
  () => {
    it("hardens a cache directory to this account and reports foreign writers", async () => {
      const root = await mkdtemp(join(tmpdir(), "rea-checkpoint-acl-"));
      const directory = join(root, "key");
      try {
        await mkdir(directory);
        await adjustWindowsCheckpointDirectory(directory);
        const acl = await readWindowsDirectoryAcl(directory);
        expect(foreignWritersOf(acl)).toEqual([]);
        await expect(
          assertWindowsCheckpointDirectoryPrivate(directory),
        ).resolves.toBeUndefined();

        await grantAuthenticatedUsers(directory);
        const widened = await readWindowsDirectoryAcl(directory);
        expect(foreignWritersOf(widened)).toContain("S-1-5-11");
        await expect(
          assertWindowsCheckpointDirectoryPrivate(directory),
        ).rejects.toThrow(/writable by/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);

    it("ignores read-only access granted to other accounts", async () => {
      const root = await mkdtemp(join(tmpdir(), "rea-checkpoint-acl-"));
      const directory = join(root, "key");
      try {
        await mkdir(directory);
        await adjustWindowsCheckpointDirectory(directory);
        await execFileAsync("icacls.exe", [
          directory,
          "/grant:r",
          "*S-1-5-32-545:(OI)(CI)RX",
        ]);
        const acl = await readWindowsDirectoryAcl(directory);
        expect(foreignWritersOf(acl)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);

    it("refuses an unreadable probe instead of assuming privacy", async () => {
      await expect(
        readWindowsDirectoryAcl("relative", async () => {
          throw new Error("powershell unavailable");
        }),
      ).rejects.toThrow(/powershell unavailable/u);
    });
  },
);
