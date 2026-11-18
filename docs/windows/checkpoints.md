# Windows persistent Ghidra checkpoints

This fork (`DearJIAN/rea-windows-optimized`) keeps upstream REA's owned-Program
checkpoint design and enables it on Windows x64. Nothing is re-implemented: the
same `REA_GHIDRA_CHECKPOINT_DIR`, manifest v2, SHA-256 binding, packed Program
`.gzf`, `-noanalysis` restore, atomic publication and lease are reused.

## Repository and history

`main` is the maintained branch of the private `DearJIAN/rea-windows-optimized`
repository. Its history includes the upstream REA baseline and the Windows
checkpoint and session-reuse changes. Upstream licence and notices remain in
place. The checkout does not require an upstream remote for normal use.

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
$env:REA_GHIDRA_JAVA_HOME = 'D:\TOOLS\jdk\jdk-21.0.13+9'
$env:REA_GHIDRA_CHECKPOINT_DIR = 'D:\rea-checkpoints'
node scripts/rea.mjs --mcp
```

`REA_GHIDRA_JAVA_HOME` selects a JDK for Ghidra only and takes precedence over
`JAVA_HOME` for that provider; other Java applications keep their own settings.
If it is unset, Ghidra continues to use `JAVA_HOME` as before.

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

## Reusing a loaded target

On Windows, a stock read-only Ghidra checkpoint session can keep one previous
loaded target alive while another is active. Returning to the same target path,
bytes and analysis profile reuses its live client after a health check; other
providers and non-checkpoint sessions keep their existing lifecycle. This is a
shared REA session behavior, independent of the MCP client; a new REA process
still restores from the checkpoint. `close_binary`, runtime disposal and
`reset_investigation` release the standby. Selecting a third target first evicts
the standby; a failed cleanup is retained and must be retried. Target/profile
changes or an unhealthy standby do not reuse it. Different paths sharing the
same checkpoint key cannot hold its exclusive lease concurrently; the previous
client is closed before opening that alias. If the current composite
session has instantiated another provider, the switch closes that composite
instead of retaining its other provider's resources.

A standby keeps its Ghidra process, memory, private files and checkpoint lease
until eviction or close. At most two Ghidra clients are owned by one REA session;
this is a process-count bound, not a hard memory limit. A competing REA process
cannot acquire a checkpoint while either of these clients owns its lease. Close
the binary session to release both. The target executable is still read-only.

## Measuring target switching

`--scenarios switch` runs A → B → A in one MCP session and checks the
normalized A pseudocode before and after the switch. `--scenarios
pool-experiment` instead opens two independent MCP sessions, one per target,
and queries the first again while both remain open. This second scenario is a
measurement control, not a shared REA session or a production switch API.
The `alias-switch` scenario tests a same-SHA path switch, and `crash-pool`
checks process-family termination and lease recovery after killing the MCP
owner with two loaded targets. The switch, pool and crash-pool scenarios require
`--binary-b` and the corresponding valid probes. Use a
previously populated checkpoint root to measure restoration rather than first
analysis; cache directories and reports are retained.

On the reference Windows machine, one 2026-11-18 run on `bef872c04` with this
measurement harness reported 13.0 s for A's initial load and 11.25 s to return
to A in a single session. An independent-session control reported 12.55 s and
12.50 s to load A and B, then 16 ms for another A query. The latter timing is
not an `open_binary` switch and excludes orchestration. A single process-family
working-set sample while both were running was approximately 1.4 GiB; it is not
a peak measurement. These observations do not establish a production speedup,
a complete memory bound, or stable latency across machines.

### Retained-session comparison (2026-11-18)

On the reference Windows 11 machine (i9-13900HX, Node 24.22.3, Ghidra
12.1.4, Temurin JDK 21.0.13), a single warm-OS-cache A → B → A MCP task
used the same prepopulated checkpoints and the same verifier on baseline
`72eb7bd09` and the subsequent retained-session build. A was `vl3vpn.dll`
(SHA-256 `166cbc188f25421654591ccb5feaa77806a92e45497212a93690f747c531223e`)
and B was `ArrayVPNApi.dll` (SHA-256
`f09252a67373480d910108ee53938978e8ff872394b0ad444cd7e983c2c90547`).
The baseline checkout was on C: and the new checkout on D:; both used the
same Ghidra installation, target files, checkpoint root and native addon.

| Measurement                              |  Baseline |    Retained |
| ---------------------------------------- | --------: | ----------: |
| Open A again and decompile after B       |  26.364 s |     0.335 s |
| Whole task elapsed                       |   86.65 s |     77.63 s |
| Observed process-family CPU, lower bound |  114.38 s |    101.30 s |
| Sampled process-family peak working set  | 723.1 MiB | 1,162.4 MiB |

Sampling walked the process tree approximately every two seconds. Working-set
sums include shared pages; the CPU sum uses the largest observation per process
and can miss short-lived processes. Sampler CPU is excluded. This is one ordered
pair, not a statistical guarantee; loading the first two Programs varied
substantially, so it does not establish a stable whole-task speedup. Both runs
returned matching selected function inventory, overview, symbols, instruction,
reference, pseudocode and function-analysis fingerprints before and after the
switch, and the corresponding fingerprints matched across runs. Coverage is
limited to the selected probes and is not proof of complete analysis equivalence.

A separate instrumented fresh-cache run measured 151.6 s for the first A
analysis, 34.1 s for a new-process restore and 0.350 s to switch back after B.
The restore missed the 15 s target under that load; no stable cross-process
startup improvement is claimed. The run observed no survivors among 11 recorded
owner-process identities after killing a session with two loaded targets, and
both targets subsequently recovered. The target-switch cache stays local to its
own REA session; it does not share live clients across processes.

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

## Roll back

The installed package and its previous user configuration should be backed up
before replacement. To revert, restore that backup and the previous environment
settings; do not delete the checkpoint directory as part of rollback. The Git
history on `main` also retains the original baseline and the Windows changes.

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
