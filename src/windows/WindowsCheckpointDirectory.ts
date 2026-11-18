import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

import { errorMessage } from "../kernel/errorMessage.js";

const execFileAsync = promisify(execFile);

/** SIDs whose write access cannot let another local account replace the cache. */
const TRUSTED_SIDS: ReadonlySet<string> = new Set([
  // NT AUTHORITY\SYSTEM
  "S-1-5-18",
  // BUILTIN\Administrators
  "S-1-5-32-544",
  // CREATOR OWNER (resolves to the creating account for children)
  "S-1-3-0",
  // OWNER RIGHTS (permissions granted to whoever owns the object)
  "S-1-3-4",
]);

/**
 * Rights that can replace, delete or re-permission a cache file. Read/execute
 * entries are harmless, so an ordinary shared folder with read-only access for
 * other accounts stays admissible.
 */
const WRITE_RIGHTS =
  0x2 | // FILE_WRITE_DATA / FILE_ADD_FILE
  0x4 | // FILE_APPEND_DATA / FILE_ADD_SUBDIRECTORY
  0x10 | // FILE_WRITE_EA
  0x40 | // FILE_DELETE_CHILD
  0x10000 | // DELETE
  0x40000 | // WRITE_DAC
  0x80000 | // WRITE_OWNER
  0x10000000 | // GENERIC_ALL
  0x40000000; // GENERIC_WRITE

const aclSchema = z
  .object({
    user_sid: z.string().regex(/^S-1-[0-9-]+$/u),
    entries: z.array(
      z
        .object({
          sid: z.string().min(1),
          rights: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export interface WindowsDirectoryAce {
  readonly sid: string;
  readonly rights: number;
}

export interface WindowsDirectoryAcl {
  readonly userSid: string;
  readonly entries: readonly WindowsDirectoryAce[];
}

/** Runs one PowerShell program, returning its standard output. */
export type WindowsPowerShellRunner = (
  script: string,
  environment: Readonly<Record<string, string>>,
) => Promise<string>;

const ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:REA_CHECKPOINT_DIRECTORY",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  // FileSystemRights is a signed enum; keep every access bit and report the
  // unsigned 32-bit mask so JSON consumers see a non-negative integer.
  "function Normalize-Rights([long] $value) { if ($value -lt 0) { return $value + 4294967296 } return $value }",
  // DirectoryInfo avoids the Microsoft.PowerShell.Security module, which a
  // constrained host may refuse to autoload.
  "$dirInfo = New-Object System.IO.DirectoryInfo($path)",
  "$acl = $dirInfo.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)",
  "$entries = @()",
  "foreach ($ace in $acl.Access) {",
  "  if ($ace.AccessControlType -ne 'Allow') { continue }",
  "  try {",
  "    $entrySid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
  "  } catch {",
  "    $entrySid = $ace.IdentityReference.Value",
  "  }",
  "  $entries += [pscustomobject]@{ sid = $entrySid; rights = (Normalize-Rights $ace.FileSystemRights) }",
  "}",
  "[pscustomobject]@{ user_sid = $sid; entries = $entries } | ConvertTo-Json -Compress -Depth 4",
].join("\n");

const HARDEN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:REA_CHECKPOINT_DIRECTORY",
  "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "& icacls $path /inheritance:r " +
    '"/grant:r" "*${sid}:(OI)(CI)F" ' +
    '"/grant:r" "*S-1-5-18:(OI)(CI)F" ' +
    '"/grant:r" "*S-1-5-32-544:(OI)(CI)F" | Out-Null',
  'if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }',
].join("\n");

const defaultRunner: WindowsPowerShellRunner = async (script, environment) => {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      env: { ...process.env, ...environment },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  return stdout;
};

/** Read the allow entries of one directory ACL as SIDs plus raw rights bits. */
export const readWindowsDirectoryAcl = async (
  directory: string,
  run: WindowsPowerShellRunner = defaultRunner,
): Promise<WindowsDirectoryAcl> => {
  const stdout = await run(ACL_SCRIPT, {
    REA_CHECKPOINT_DIRECTORY: directory,
  });
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause: unknown) {
    throw new Error(
      `Windows directory ACL probe returned unreadable JSON for ${JSON.stringify(directory)}: ${errorMessage(cause)}`,
      { cause },
    );
  }
  const parsed = aclSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `Windows directory ACL probe returned an unexpected record for ${JSON.stringify(directory)}`,
      { cause: parsed.error },
    );
  return { userSid: parsed.data.user_sid, entries: parsed.data.entries };
};

/** Roots already proven private during this process; ACL edits are rare mid-run. */
const verifiedRoots = new Set<string>();

/**
 * Throws unless only the current account, SYSTEM and administrators may write.
 * Roots verified once per process are skipped on later cache keys.
 */
export const assertWindowsCheckpointRootPrivate = async (
  directory: string,
  run: WindowsPowerShellRunner = defaultRunner,
): Promise<void> => {
  if (verifiedRoots.has(directory)) return;
  await assertWindowsCheckpointDirectoryPrivate(directory, run);
  verifiedRoots.add(directory);
};

/** Throws unless only the current account, SYSTEM and administrators may write. */
export const assertWindowsCheckpointDirectoryPrivate = async (
  directory: string,
  run: WindowsPowerShellRunner = defaultRunner,
): Promise<void> => {
  let acl: WindowsDirectoryAcl;
  try {
    acl = await readWindowsDirectoryAcl(directory, run);
  } catch (cause: unknown) {
    throw new Error(
      `Windows cannot verify the access control list of ${JSON.stringify(directory)}: ${errorMessage(cause)}`,
      { cause },
    );
  }
  const foreign = foreignWritersOf(acl);
  if (foreign.length > 0)
    throw new Error(
      `the directory is writable by ${foreign.join(", ")}; restrict it to ${acl.userSid}, SYSTEM and administrators`,
    );
};

/**
 * Install an owner/SYSTEM/administrators-only DACL on a cache directory REA
 * created, then prove the result. Caller-selected roots are inspected only.
 */
export const adjustWindowsCheckpointDirectory = async (
  directory: string,
  run: WindowsPowerShellRunner = defaultRunner,
): Promise<void> => {
  try {
    await hardenWindowsCheckpointDirectory(directory, run);
  } catch (cause: unknown) {
    throw new Error(
      `Windows cannot restrict ${JSON.stringify(directory)} to this user: ${errorMessage(cause)}`,
      { cause },
    );
  }
  await assertWindowsCheckpointDirectoryPrivate(directory, run);
  verifiedRoots.add(directory);
};

/** Accounts other than the owner, SYSTEM and administrators that may write. */
export const foreignWritersOf = (
  acl: WindowsDirectoryAcl,
): readonly string[] => {
  const seen = new Set<string>();
  for (const entry of acl.entries) {
    if ((entry.rights & WRITE_RIGHTS) === 0) continue;
    if (entry.sid === acl.userSid || TRUSTED_SIDS.has(entry.sid)) continue;
    seen.add(entry.sid);
  }
  return [...seen];
};

/**
 * Replace inherited permissions with an owner/SYSTEM/administrators-only DACL.
 * Used only on cache directories REA creates; caller-selected roots are left
 * untouched and merely inspected.
 */
export const hardenWindowsCheckpointDirectory = async (
  directory: string,
  run: WindowsPowerShellRunner = defaultRunner,
): Promise<void> => {
  await run(HARDEN_SCRIPT, { REA_CHECKPOINT_DIRECTORY: directory });
};
