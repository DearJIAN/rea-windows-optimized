# Windows persistent Ghidra checkpoints

This fork (`DearJIAN/rea-windows-optimized`) keeps upstream REA's owned-Program
checkpoint design and enables it on Windows x64. Nothing is re-implemented: the
same `REA_GHIDRA_CHECKPOINT_DIR`, manifest v2, SHA-256 binding, packed Program
`.gzf`, `-noanalysis` restore, atomic publication and lease are reused.

## Relationship to upstream

- Upstream: <https://github.com/morluto/rea>, `main` here is the untouched
  upstream baseline, `upstream` names the original remote.
- Development happens on `feat/windows-ghidra-checkpoint`; `origin` is the
  private fork. Upstream licence, notices and Git history are preserved.
- The Windows work is a bounded patch set: configuration path validation,
  provider admission, a Windows ACL gate for the cache directory, a lease
  directory that is no longer hard-coded to `/tmp`, and an explicit
  `checkpoint_authority` field in the Java bridge session descriptor.

## What Windows support adds

| Upstream gate                                              | Fork behaviour                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `REA_GHIDRA_CHECKPOINT_DIR` had to start with `/`          | any absolute path, including `D:\rea-checkpoints`                                                                                          |
| `GhidraProvider` rejected `platform === "win32"`           | stock PE imports are admitted (other pinned/override profiles stay excluded)                                                               |
| directory privacy used POSIX `mode & 0o077`                | ACL probe via `DirectoryInfo.GetAccessControl`; write-capable ACEs are limited to the current account, SYSTEM and `BUILTIN\Administrators` |
| lease directory pinned to `/tmp`                           | `%TEMP%` on Windows; the Windows lease itself is the named pipe `\\.\pipe\rea-lease-<key>`                                                 |
| `checkpoint_program` required `transport == "unix-socket"` | requires `checkpoint_authority` in the session descriptor, which REA writes only for sessions that own a checkpoint                        |

Cache directories created by REA get `/inheritance:r` plus grants for the
current user, SYSTEM and administrators. A caller-selected root is only
inspected; an empty root is hardened, a populated one that other accounts can
write is refused with a clear error instead of being re-permissioned.

Windows checkpoint sessions remain **read-only for database edits**
(`set_address_name`, `annotate_native_function`). The cached Program carries the
completed auto-analysis; caller renames and comments are not admitted.

## Build

Prerequisites: Node.js 24.22.1 or newer, JDK 21, Ghidra 12.x, and for the native
Windows authority artifact the MSYS2 UCRT64 MinGW toolchain
(`C:\msys64\ucrt64\bin`).

```powershell
npm ci
npm run compile
# Rebuild the Node-API addon from this checkout's sources (not a copied binary):
$env:PATH = 'C:\msys64\ucrt64\bin;C:\Windows\System32;C:\msys64\usr\bin;' + $env:PATH
npm run build:windows-native
npm run verify:windows-native:artifact
```

The addon build lane now also accepts a Windows host; it still targets the
Node-API level recorded in `native/windows/build/manifest.json`.

## Run and verify

```powershell
$env:GHIDRA_INSTALL_DIR = 'D:\TOOLS\ghidra\ghidra_12.1.4_PUBLIC'
$env:JAVA_HOME = 'D:\TOOLS\jdk\jdk-21.0.13+9'
$env:REA_GHIDRA_CHECKPOINT_DIR = 'D:\rea-checkpoints'
node scripts/rea.mjs --mcp
```

The acceptance harness starts independent MCP processes from this checkout and
covers cold analysis, cross-process restore, DLL switching, same-SHA copies,
mutated targets, quarantine/recovery, concurrency, crash recovery, MCP catalog
compatibility and analysis equivalence:

```powershell
npm run verify:ghidra:checkpoints:windows -- `
  --binary D:\samples\app.dll --binary-b D:\samples\other.dll `
  --checkpoint D:\rea-checkpoints `
  --probe 0x10041eb0 --probe 0x1004fa00 --probe-b 0x10001000
```

A run including `cold` creates a fresh child directory under the selected
checkpoint root and prints its path; existing entries are retained. Set `--probe`
(repeatable) to valid function addresses in the first binary and `--probe-b` to
a valid function in the second. The defaults are specific to the reference DLLs.
Reports land in `reports/windows-checkpoints/` (git-ignored) and may contain
sample-derived analysis; review them before sharing. The harness fails on a
failed required operation, failed comparison, incorrect lease outcome, missing
quarantine, or missing mutation checkpoint. `profile` and cache-disabled control
runs are not implemented by this harness. A subset run without `cold` uses the
specified existing root; equivalence is only checked when both cold and restart
are selected. Crash recovery checks recovery after terminating the MCP process;
it does not establish exactly which Ghidra startup stage had been reached.

## Enable, disable, clear

- Enable: set `REA_GHIDRA_CHECKPOINT_DIR` in the environment that launches REA,
  restart the MCP server, then reopen the binary.
- Disable: unset the variable and restart; the ephemeral temporary-project
  workflow is unchanged.
- Clear one target: delete its key directory under the checkpoint root.
- Clear everything: delete the root's contents (keep the hardened root).
- Damaged cache: REA renames the bad manifest to `current.invalid-*.json` and
  re-analyses automatically; the stale `.gzf` is left for inspection.

## Equivalence checks

`scripts/verify-real-ghidra-windows-checkpoints.mjs` compares the semantic
payload (`normalized_result`) of `binary_overview`, `xrefs` for fixed addresses
and `procedure_pseudo_code` for fixed functions, plus the sorted function entry
address digest from `list_procedures`. Envelope fields that legitimately change
between fresh analysis and restore (evidence ids, links, checkpoint caveats) are
excluded; pseudocode is not compared by length or raw text.

## Measured on the reference machine

Windows 11 x64, i9-13900HX (24C/32T), 39.8 GB RAM, NVMe, Ghidra 12.1.4,
JDK 21.0.13, target `vl3vpn.dll` (1,144,896 bytes, 3,635 functions):

| Scenario                                      | Wall clock                                               |
| --------------------------------------------- | -------------------------------------------------------- |
| First analysis (cold, creates the checkpoint) | 75–97 s                                                  |
| New REA process, same target                  | 13.3–21.1 s                                              |
| Same SHA-256 at another path                  | 13.3–21.1 s                                              |
| Open another DLL, then return                 | 14.4–18.7 s                                              |
| Mutation of one byte                          | full cold analysis, separate cache key                   |
| Damaged `.gzf`                                | quarantined, then full cold analysis                     |
| Competing second REA process                  | first owner keeps the lease, second tool call reports it |

Restore breakdown from the debug timings: checkpoint admission 0.9 s (ACL probe
and digest verification), process spawn 0.3 s, Ghidra headless startup + bridge
script + `.gzf` import 14–17 s, first decompile afterwards 0.1–1.5 s. The 15 s
target is met on fast runs but not consistently; the dominant cost is Ghidra's
own headless startup and bridge initialisation, not REA's request handling.

Equivalence for the same target: identical function count (3,635), identical
sorted entry-address digest, identical `list_names` symbol payload, identical
`read_function_instructions` stream and `analyze_function` dossier (signature,
references, value flow) for the probe function, and identical
`normalized_result` payloads for `binary_overview`, the probed `xrefs`
addresses and the probed pseudocode.

## Connecting Trae CN (manual, opt-in)

Do not replace the installed `rea-agents` package or edit a working MCP entry in
place. Register the checkout as a second, clearly named server and keep the old
one until the fork has been exercised:

```jsonc
{
  "mcpServers": {
    "rea-windows-optimized": {
      "command": "node",
      "args": ["D:\\TOOLS\\rea-windows-optimized\\scripts\\rea.mjs", "--mcp"],
      "env": {
        "GHIDRA_INSTALL_DIR": "D:\\TOOLS\\ghidra\\ghidra_12.1.4_PUBLIC",
        "JAVA_HOME": "D:\\TOOLS\\jdk\\jdk-21.0.13+9",
        "REA_GHIDRA_CHECKPOINT_DIR": "D:\\rea-checkpoints",
      },
    },
  },
}
```

Restart the client after editing `mcp.json`, then verify with a harmless call
(`list_providers`, `open_binary`, one decompile). Roll back by deleting the
entry; the globally installed REA 6.7.0 entry is untouched.

## Sync upstream and roll back

```powershell
git fetch upstream
git switch main
git merge --ff-only upstream/main     # keep the baseline honest
git switch feat/windows-ghidra-checkpoint
git merge main                        # resolve conflicts here
```

To roll back to stock REA, use a clean clone of `morluto/rea` (or
`git switch main` in this repository) and leave the checkpoint directory
unconfigured. The cache never touches the target binary and is not read by stock
REA.

## Not supported

- Windows sessions remain read-only for database mutations.
- One checkpoint owner per target: a competing REA process reports the owning
  session and exits that tool call.
- First-time auto-analysis cannot resume midway; only completed analyses are
  reusable.
- Pinned languages, analyzer overrides, seeds, extra analysis extensions and
  caller-selected `.gpr` projects stay on their existing workflows.
- A parent directory writable by other accounts can still delete the hardened
  cache directory itself; point the setting at a dedicated folder.
