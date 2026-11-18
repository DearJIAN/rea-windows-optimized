// Real-Ghidra acceptance run for Windows persistent analysis checkpoints.
//
// Starts independent MCP server processes from this checkout (never the globally
// installed REA), drives them over stdio, and records wall-clock latency plus a
// normalized analysis fingerprint for equivalence checks.
//
// Usage:
//   node scripts/verify-real-ghidra-windows-checkpoints.mjs --binary <path> [options]
//     --binary-b <path>     second binary for the DLL-switch scenario
//     --checkpoint <dir>    checkpoint root (default: %TEMP%\rea-windows-checkpoints)
//     --report <dir>        report directory (default: reports/windows-checkpoints)
//     --scenarios a,b,c     subset of cold,restart,switch,same-sha,mutation,
//                           corruption,concurrent,crash,crash-pool,mcp,pool-experiment,alias-switch
//     --probe <address>     function address in --binary (repeat for two probes)
//     --probe-b <address>   function address in --binary-b
import { execFileSync, spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";

const REPO = resolve(import.meta.dirname, "..");
const CLI = join(REPO, "scripts", "rea.mjs");
const GHIDRA_HOME = process.env.GHIDRA_INSTALL_DIR;
const JAVA_HOME = process.env.JAVA_HOME;

const argv = process.argv.slice(2);
const valueFlags = new Set([
  "--binary",
  "--binary-b",
  "--checkpoint",
  "--report",
  "--scenarios",
  "--probe",
  "--probe-b",
]);
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index];
  if (arg === "--without-checkpoint") continue;
  if (
    !valueFlags.has(arg) ||
    !argv[index + 1] ||
    argv[index + 1].startsWith("--")
  )
    throw new Error(`Unknown option or missing value: ${arg}`);
  index++;
}
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const BINARY = flag("binary");
const BINARY_B = flag("binary-b");
let CHECKPOINT_ROOT = resolve(
  flag("checkpoint", join(tmpdir(), "rea-windows-checkpoints")),
);
const REPORT = resolve(
  flag("report", join(REPO, "reports", "windows-checkpoints")),
);
const SCENARIOS = new Set(
  flag(
    "scenarios",
    "cold,restart,switch,same-sha,mutation,corruption,concurrent,crash,mcp",
  ).split(","),
);
/** Control run: same build with the persistent cache disabled. */
const WITHOUT_CHECKPOINT = argv.includes("--without-checkpoint");

if (!BINARY) {
  console.error("--binary <path> is required");
  process.exit(2);
}
if (!GHIDRA_HOME || !JAVA_HOME) {
  console.error(
    "GHIDRA_INSTALL_DIR and JAVA_HOME must point at the local tools",
  );
  process.exit(2);
}

const sha256File = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const normalize = (text) => {
  // Evidence envelopes carry volatile ids, links and checkpoint-state
  // limitations; compare the normalized analysis payload only.
  let payload = text;
  try {
    const envelope = JSON.parse(text);
    if (
      envelope &&
      typeof envelope === "object" &&
      "normalized_result" in envelope
    )
      payload = JSON.stringify(envelope.normalized_result);
  } catch {}
  return createHash("sha256").update(payload).digest("hex");
};

const probes = argv.flatMap((arg, index) =>
  arg === "--probe" ? [argv[index + 1]] : [],
);
const PROBE_FUNCTIONS = probes.length ? probes : ["0x10041eb0", "0x1004fa00"];
const PROBE_ADDRESSES = PROBE_FUNCTIONS;
const PROBE_B = flag("probe-b", "0x10001000");
const validScenarios = new Set([
  "cold",
  "restart",
  "switch",
  "pool-experiment",
  "alias-switch",
  "same-sha",
  "mutation",
  "corruption",
  "concurrent",
  "crash",
  "crash-pool",
  "mcp",
]);
if ([...SCENARIOS].some((item) => !validScenarios.has(item)))
  throw new Error("Unknown or unsupported scenario");
if (
  PROBE_FUNCTIONS.some((value) => !/^0x[0-9a-f]+$/i.test(value)) ||
  !/^0x[0-9a-f]+$/i.test(PROBE_B)
)
  throw new Error("Probe addresses must be hexadecimal (e.g. 0x10001000)");
if (
  (SCENARIOS.has("switch") ||
    SCENARIOS.has("pool-experiment") ||
    SCENARIOS.has("crash-pool")) &&
  !BINARY_B
)
  throw new Error("switch requires --binary-b and its --probe-b");
if (WITHOUT_CHECKPOINT)
  throw new Error(
    "--without-checkpoint is not supported by this checkpoint acceptance harness",
  );

class Session {
  #child;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;
  #stderr = [];
  records = [];

  constructor(label) {
    this.label = label;
  }

  get pid() {
    return this.#child?.pid;
  }

  async start(extraEnv = {}) {
    this.#child = spawn(process.execPath, [CLI, "--mcp"], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GHIDRA_INSTALL_DIR: GHIDRA_HOME,
        JAVA_HOME,
        ...(WITHOUT_CHECKPOINT
          ? {}
          : { REA_GHIDRA_CHECKPOINT_DIR: CHECKPOINT_ROOT }),
        REA_LOG_LEVEL: process.env.REA_LOG_LEVEL ?? "info",
        ...extraEnv,
      },
    });
    this.#child.on("error", (error) => this.#failPending(error));
    this.#child.on("exit", (code, signal) =>
      this.#failPending(
        new Error(`MCP process exited (code ${code}, signal ${signal})`),
      ),
    );
    this.#child.stderr.on("data", (chunk) =>
      this.#stderr.push(chunk.toString("utf8")),
    );
    this.#child.stdout.on("data", (chunk) => {
      this.#buffer += chunk.toString("utf8");
      let index;
      while ((index = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const settle = this.#pending.get(message.id);
        if (!settle) continue;
        this.#pending.delete(message.id);
        settle.settle(message);
      }
    });
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "rea-windows-checkpoints-verify", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  #failPending(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  request(method, params, timeoutMs = 900_000) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        settle: (message) => {
          clearTimeout(timer);
          if (message.error)
            reject(new Error(JSON.stringify(message.error).slice(0, 400)));
          else resolvePromise(message.result);
        },
      });
      this.#child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  notify(method, params) {
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  async call(label, name, args = {}) {
    const started = process.hrtime.bigint();
    let result;
    let error;
    try {
      result = await this.request("tools/call", { name, arguments: args });
    } catch (cause) {
      error = cause.message ?? String(cause);
      result = { content: [], isError: true };
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const text = (result.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const record = {
      label,
      tool: name,
      args,
      ms: Math.round(ms),
      bytes: text.length,
      isError: result.isError === true || error !== undefined,
      error,
      text,
    };
    this.records.push(record);
    console.log(
      `[${this.label}] ${label.padEnd(28)} ${String(record.ms).padStart(7)}ms ${record.isError ? "ERROR" : ""}`,
    );
    return record;
  }

  async kill(signal = "SIGKILL") {
    try {
      this.#child.kill(signal);
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  }

  async stop() {
    try {
      this.#child.stdin.end();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1200));
      this.#child.kill();
    } catch {}
  }

  stderr() {
    return this.#stderr.join("");
  }
}

const requireOk = (record, what) => {
  if (record.isError)
    throw new Error(
      `${what} failed: ${record.error ?? record.text.slice(-300)}`,
    );
};

const fingerprint = async (session) => {
  const procedures = await session.call(
    "fingerprint_procedures",
    "list_procedures",
    {},
  );
  requireOk(procedures, "list_procedures");
  const addresses = [...procedures.text.matchAll(/0x[0-9a-fA-F]+/gu)].map(
    (match) => match[0].toLowerCase(),
  );
  const unique = [...new Set(addresses)].sort();
  const overview = await session.call(
    "fingerprint_overview",
    "binary_overview",
    {},
  );
  requireOk(overview, "binary_overview");
  const xrefs = [];
  for (const address of PROBE_ADDRESSES) {
    const record = await session.call(`fingerprint_xrefs_${address}`, "xrefs", {
      address,
    });
    requireOk(record, `xrefs ${address}`);
    xrefs.push({
      address,
      digest: normalize(record.text),
      text: record.text,
      count: (record.text.match(/0x[0-9a-fA-F]+/gu) ?? []).length,
    });
  }
  const code = [];
  for (const procedure of PROBE_FUNCTIONS) {
    const record = await session.call(
      `fingerprint_pseudo_${procedure}`,
      "procedure_pseudo_code",
      { procedure },
    );
    requireOk(record, `pseudo ${procedure}`);
    code.push({ procedure, digest: normalize(record.text), text: record.text });
  }
  const symbols = await session.call("fingerprint_names", "list_names", {
    address: PROBE_ADDRESSES[0],
    detail: "complete",
  });
  requireOk(symbols, "list_names");
  const instructions = await session.call(
    "fingerprint_instructions",
    "read_function_instructions",
    { procedure: PROBE_FUNCTIONS[0] },
  );
  requireOk(instructions, "read_function_instructions");
  const dossier = await session.call(
    "fingerprint_analysis",
    "analyze_function",
    { procedure: PROBE_FUNCTIONS[0], detail: "complete" },
  );
  requireOk(dossier, "analyze_function");
  const countMatch = overview.text.match(
    /(?:functions?|procedures?)\D{0,12}(\d+)/iu,
  );
  return {
    overviewText: overview.text,
    symbolsDigest: normalize(symbols.text),
    symbolCount: (symbols.text.match(/0x[0-9a-fA-F]+/gu) ?? []).length,
    instructionsDigest: normalize(instructions.text),
    dossierDigest: normalize(dossier.text),
    functionCount: unique.length,
    functionCountHint: countMatch ? Number(countMatch[1]) : null,
    addressDigest: createHash("sha256").update(unique.join(",")).digest("hex"),
    overviewDigest: normalize(overview.text),
    xrefs,
    code,
  };
};

const listCache = async () => {
  const entries = [];
  try {
    for (const key of await readdir(CHECKPOINT_ROOT)) {
      const manifestPath = join(CHECKPOINT_ROOT, key, "current.json");
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const file = manifest.source?.file;
        entries.push({
          key,
          target_sha256: manifest.target_sha256,
          base_profile_digest: manifest.base_profile_digest,
          program: file,
          path:
            file === undefined ? undefined : join(CHECKPOINT_ROOT, key, file),
        });
      } catch {
        entries.push({ key, unreadable: true });
      }
    }
  } catch {}
  return entries;
};

const ensureCheckpointRoot = async () => {
  await mkdir(CHECKPOINT_ROOT, { recursive: true });
  const entries = await readdir(CHECKPOINT_ROOT);
  return entries.length;
};

const openBinary = async (session, label, path) => {
  const record = await session.call(label, "open_binary", {
    path,
    provider_id: "ghidra",
  });
  requireOk(record, label);
  return record;
};

const runCold = async (targetSha, results) => {
  if (!SCENARIOS.has("cold")) return;
  const session = new Session("cold");
  await session.start();
  try {
    const opened = await openBinary(session, "cold_open", BINARY);
    const probe = await session.call("cold_pseudo", "procedure_pseudo_code", {
      procedure: PROBE_FUNCTIONS[0],
    });
    requireOk(probe, "cold pseudo");
    results.cold = {
      openMs: opened.ms,
      fingerprint: await fingerprint(session),
      firstAnalysisTotalMs: opened.ms + probe.ms,
    };
  } finally {
    await session.call("cold_close", "close_binary", {});
    await session.stop();
  }
  const cache = await listCache();
  results.cacheAfterCold = cache;
  if (!cache.some((entry) => entry.target_sha256 === targetSha))
    throw new Error("cold analysis did not publish a checkpoint");
};

const runRestart = async (results) => {
  if (!SCENARIOS.has("restart")) return;
  const session = new Session("restart");
  await session.start();
  try {
    const opened = await openBinary(session, "restart_open", BINARY);
    const probe = await session.call(
      "restart_pseudo",
      "procedure_pseudo_code",
      {
        procedure: PROBE_FUNCTIONS[0],
      },
    );
    requireOk(probe, "restart pseudo");
    results.restart = {
      openMs: opened.ms,
      restoreTotalMs: opened.ms + probe.ms,
      fingerprint: await fingerprint(session),
    };
  } finally {
    results.restartLog = session.stderr().slice(-300_000);
    await session.call("restart_close", "close_binary", {});
    await session.stop();
  }
};

const runSwitch = async (results) => {
  if (!SCENARIOS.has("switch") || !BINARY_B) return;
  const session = new Session("switch");
  await session.start();
  try {
    const firstOpened = await openBinary(
      session,
      "switch_open_a_initial",
      BINARY,
    );
    const firstProbe = await session.call(
      "switch_pseudo_a_initial",
      "procedure_pseudo_code",
      {
        procedure: PROBE_FUNCTIONS[0],
      },
    );
    requireOk(firstProbe, "switch initial pseudo A");
    const initialFingerprint = await fingerprint(session);
    const bOpened = await openBinary(session, "switch_open_b", BINARY_B);
    const bProbe = await session.call(
      "switch_pseudo_b",
      "procedure_pseudo_code",
      {
        procedure: PROBE_B,
      },
    );
    requireOk(bProbe, "switch pseudo B");
    const aOpened = await openBinary(session, "switch_open_a", BINARY);
    const aProbe = await session.call(
      "switch_pseudo_a",
      "procedure_pseudo_code",
      {
        procedure: PROBE_FUNCTIONS[0],
      },
    );
    requireOk(aProbe, "switch pseudo");
    const initialDigest = normalize(firstProbe.text);
    const returnDigest = normalize(aProbe.text);
    if (initialDigest !== returnDigest)
      throw new Error("A pseudocode changed across A/B/A switch");
    const returnFingerprint = await fingerprint(session);
    const equivalence = compareFingerprints(
      initialFingerprint,
      returnFingerprint,
    );
    if (!equivalence.equal)
      throw new Error("A analysis fingerprint changed across A/B/A switch");
    results.switch = {
      equivalence,
      initialAMs: firstOpened.ms + firstProbe.ms,
      initialDigest,
      returnDigest,
      openBMs: bOpened.ms,
      analyseBMs: bProbe.ms,
      backToAMs: aOpened.ms + aProbe.ms,
    };
  } finally {
    results.switchLog = session.stderr().slice(-300_000);
    try {
      requireOk(
        await session.call("switch_close", "close_binary", {}),
        "switch close",
      );
    } finally {
      await session.stop();
    }
  }
};

// Measurement control: independent MCP runtimes, not a production session pool.
const runPoolExperiment = async (results) => {
  if (!SCENARIOS.has("pool-experiment")) return;
  const first = new Session("pool-a");
  const second = new Session("pool-b");
  await first.start();
  try {
    await second.start();
    try {
      const aOpen = await openBinary(first, "pool_open_a", BINARY);
      const a = await first.call("pool_pseudo_a", "procedure_pseudo_code", {
        procedure: PROBE_FUNCTIONS[0],
      });
      requireOk(a, "pool initial pseudo A");
      const bOpen = await openBinary(second, "pool_open_b", BINARY_B);
      const b = await second.call("pool_pseudo_b", "procedure_pseudo_code", {
        procedure: PROBE_B,
      });
      requireOk(b, "pool pseudo B");
      const again = await first.call(
        "pool_pseudo_a_again",
        "procedure_pseudo_code",
        { procedure: PROBE_FUNCTIONS[0] },
      );
      requireOk(again, "pool return pseudo A");
      if (normalize(a.text) !== normalize(again.text))
        throw new Error("A pseudocode changed in independent sessions");
      results.poolExperiment = {
        initialAMs: aOpen.ms + a.ms,
        initialBMs: bOpen.ms + b.ms,
        returnQueryMs: again.ms,
        digest: normalize(again.text),
        note: "Independent MCP runtimes; does not include a production target-switch operation.",
      };
    } finally {
      await second.call("pool_close_b", "close_binary", {});
      await second.stop();
    }
  } finally {
    await first.call("pool_close_a", "close_binary", {});
    await first.stop();
  }
};

// The same checkpoint key must not be leased twice by two paths in one session.
const runAliasSwitch = async (results) => {
  if (!SCENARIOS.has("alias-switch")) return;
  const fixture = await VerifierFixture.open({
    prefix: "rea-alias-",
    private: false,
  });
  const alias = join(fixture.path, "renamed.dll");
  const session = new Session("alias-switch");
  let started = false;
  try {
    await copyFile(BINARY, alias);
    if ((await sha256File(alias)) !== (await sha256File(BINARY)))
      throw new Error("alias bytes do not match the original target");
    await session.start();
    started = true;
    await openBinary(session, "alias_open_original", BINARY);
    const original = await session.call(
      "alias_pseudo_original",
      "procedure_pseudo_code",
      { procedure: PROBE_FUNCTIONS[0] },
    );
    requireOk(original, "alias original pseudo");
    const opened = await openBinary(session, "alias_open_copy", alias);
    const copy = await session.call(
      "alias_pseudo_copy",
      "procedure_pseudo_code",
      { procedure: PROBE_FUNCTIONS[0] },
    );
    requireOk(copy, "alias copy pseudo");
    if (normalize(original.text) !== normalize(copy.text))
      throw new Error("same-SHA alias changed pseudocode");
    results.aliasSwitch = { restoreTotalMs: opened.ms + copy.ms, equal: true };
  } finally {
    try {
      if (started)
        requireOk(
          await session.call("alias_close", "close_binary", {}),
          "alias close",
        );
    } finally {
      await session.stop();
      await fixture.release();
    }
  }
};

const runSameSha = async (results) => {
  if (!SCENARIOS.has("same-sha")) return;
  const copy = join(tmpdir(), `rea-same-sha-${Date.now()}`, "renamed.dll");
  await mkdir(dirname(copy), { recursive: true });
  await copyFile(BINARY, copy);
  const session = new Session("same-sha");
  await session.start();
  try {
    const opened = await openBinary(session, "same_sha_open", copy);
    const probe = await session.call(
      "same_sha_pseudo",
      "procedure_pseudo_code",
      {
        procedure: PROBE_FUNCTIONS[0],
      },
    );
    requireOk(probe, "same-sha pseudo");
    results.sameSha = { restoreTotalMs: opened.ms + probe.ms };
  } finally {
    await session.call("same_sha_close", "close_binary", {});
    await session.stop();
    await rm(dirname(copy), { recursive: true, force: true });
  }
};

const runMutation = async (results) => {
  if (!SCENARIOS.has("mutation")) return;
  const mutated = join(tmpdir(), `rea-mutated-${Date.now()}.dll`);
  const bytes = await readFile(BINARY);
  bytes[bytes.length - 1] ^= 0xff;
  await writeFile(mutated, bytes);
  const before = await listCache();
  const session = new Session("mutation");
  await session.start();
  try {
    const opened = await openBinary(session, "mutation_open", mutated);
    const probe = await session.call(
      "mutation_pseudo",
      "procedure_pseudo_code",
      {
        procedure: PROBE_FUNCTIONS[0],
      },
    );
    requireOk(probe, "mutation pseudo");
    const mutatedSha = await sha256File(mutated);
    const keys = await listCache();
    if (!keys.some((entry) => entry.target_sha256 === mutatedSha))
      throw new Error("mutated target did not publish its own checkpoint");
    results.mutation = {
      totalMs: opened.ms + probe.ms,
      cacheBefore: before.length,
      cacheAfter: keys.length,
      separateKey: keys.some((entry) => entry.target_sha256 === mutatedSha),
      reusedOldKey: keys.length === before.length,
    };
  } finally {
    await session.call("mutation_close", "close_binary", {});
    await session.stop();
    await rm(mutated, { force: true });
  }
};

const runCorruption = async (results) => {
  if (!SCENARIOS.has("corruption")) return;
  const targetSha = await sha256File(BINARY);
  const entry = (await listCache()).find(
    (item) => item.target_sha256 === targetSha,
  );
  if (!entry || entry.path === undefined)
    throw new Error("no checkpoint to corrupt");
  await writeFile(entry.path, "not-a-packed-program");
  const session = new Session("corruption");
  await session.start();
  try {
    const opened = await openBinary(session, "corruption_open", BINARY);
    const probe = await session.call(
      "corruption_pseudo",
      "procedure_pseudo_code",
      { procedure: PROBE_FUNCTIONS[0] },
    );
    requireOk(probe, "corruption recovery");
    if (
      !(await readdir(join(CHECKPOINT_ROOT, entry.key))).some((name) =>
        name.startsWith("current.invalid-"),
      )
    )
      throw new Error("damaged checkpoint was not quarantined");
    results.corruption = {
      totalMs: opened.ms + probe.ms,
      recovered: !probe.isError,
      message: probe.isError
        ? (probe.error ?? probe.text).slice(0, 300)
        : "quarantined the damaged checkpoint and re-analysed",
      quarantined: (await readdir(join(CHECKPOINT_ROOT, entry.key))).some(
        (name) => name.startsWith("current.invalid-"),
      ),
    };
  } finally {
    await session.call("corruption_close", "close_binary", {});
    await session.stop();
  }
};

const runConcurrent = async (results) => {
  if (!SCENARIOS.has("concurrent")) return;
  const first = new Session("concurrent-a");
  const second = new Session("concurrent-b");
  await first.start();
  await second.start();
  try {
    const a = await first.call("concurrent_open_a", "open_binary", {
      path: BINARY,
      provider_id: "ghidra",
    });
    const b = await second.call("concurrent_open_b", "open_binary", {
      path: BINARY,
      provider_id: "ghidra",
    });
    // open_binary is lazy; force both sessions to claim the checkpoint lease.
    const [aAnalysis, bAnalysis] = await Promise.all([
      first.call("concurrent_analyse_a", "procedure_pseudo_code", {
        procedure: PROBE_FUNCTIONS[0],
      }),
      second.call("concurrent_analyse_b", "procedure_pseudo_code", {
        procedure: PROBE_FUNCTIONS[0],
      }),
    ]);
    requireOk(a, "concurrent open A");
    requireOk(b, "concurrent open B");
    if (aAnalysis.isError === bAnalysis.isError)
      throw new Error("expected exactly one checkpoint lease owner");
    const refused = aAnalysis.isError ? aAnalysis : bAnalysis;
    if (
      !/another REA session owns this checkpoint/i.test(
        refused.error ?? refused.text,
      )
    )
      throw new Error(
        "competing session did not report checkpoint lease contention",
      );
    results.concurrent = {
      firstMs: a.ms + aAnalysis.ms,
      firstError: aAnalysis.isError,
      firstMessage: aAnalysis.isError
        ? (aAnalysis.error ?? aAnalysis.text).slice(0, 300)
        : "first session owns the lease",
      secondMs: b.ms + bAnalysis.ms,
      secondError: bAnalysis.isError,
      secondMessage: bAnalysis.isError
        ? (bAnalysis.error ?? bAnalysis.text).slice(0, 300)
        : "second session owns the lease",
    };
  } finally {
    await first.stop();
    await second.stop();
  }
};

const runCrash = async (results) => {
  if (!SCENARIOS.has("crash")) return;
  const session = new Session("crash");
  await session.start();
  await openBinary(session, "crash_open", BINARY);
  const analysed = session.call("crash_analyse", "procedure_pseudo_code", {
    procedure: PROBE_FUNCTIONS[0],
  });
  // Kill mid-analysis/warm-up, then prove a later owner is not blocked.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  await session.kill();
  const interrupted = await analysed;
  if (!interrupted.isError)
    throw new Error(
      "analysis completed before the crash; crash recovery was not exercised",
    );
  const recovery = new Session("crash-recovery");
  await recovery.start();
  try {
    const record = await recovery.call("crash_recovery_open", "open_binary", {
      path: BINARY,
      provider_id: "ghidra",
    });
    const probe = await recovery.call(
      "crash_recovery_pseudo",
      "procedure_pseudo_code",
      { procedure: PROBE_FUNCTIONS[0] },
    );
    requireOk(record, "crash recovery open");
    requireOk(probe, "crash recovery pseudo");
    results.crash = {
      recoveryMs: record.ms + probe.ms,
      recovered: !probe.isError,
      message: probe.isError
        ? (probe.error ?? probe.text).slice(0, 300)
        : "lease released after the crashed owner",
    };
  } finally {
    await recovery.stop();
  }
};

// Record process identity for observation only. Never signal an observed PID.
const windowsProcessSnapshot = () => {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [PSCustomObject]@{ id=$_.ProcessId; parent=$_.ParentProcessId; name=$_.Name; created=$_.CreationDate.ToUniversalTime().ToString('o') } } | ConvertTo-Json -Compress";
  return JSON.parse(
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    ),
  );
};
const ownedFamily = (processes, root) => {
  const ids = new Set([root]);
  let count;
  do {
    count = ids.size;
    for (const item of processes) if (ids.has(item.parent)) ids.add(item.id);
  } while (count !== ids.size);
  return processes.filter((item) => ids.has(item.id));
};

const runCrashPool = async (results) => {
  if (!SCENARIOS.has("crash-pool")) return;
  if (process.platform !== "win32")
    throw new Error("crash-pool process identity check requires Windows");
  const owner = new Session("crash-pool");
  await owner.start();
  try {
    await openBinary(owner, "crash_pool_open_a", BINARY);
    requireOk(
      await owner.call("crash_pool_pseudo_a", "procedure_pseudo_code", {
        procedure: PROBE_FUNCTIONS[0],
      }),
      "crash-pool A",
    );
    await openBinary(owner, "crash_pool_open_b", BINARY_B);
    requireOk(
      await owner.call("crash_pool_pseudo_b", "procedure_pseudo_code", {
        procedure: PROBE_B,
      }),
      "crash-pool B",
    );
    const family = ownedFamily(windowsProcessSnapshot(), owner.pid);
    if (
      family.filter((item) => /^java(?:w)?\.exe$/i.test(item.name)).length < 2
    )
      throw new Error("could not observe both Ghidra JVMs before crash");
    await owner.kill();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));
    const current = windowsProcessSnapshot();
    const survivors = family.filter((old) =>
      current.some(
        (item) => item.id === old.id && item.created === old.created,
      ),
    );
    if (survivors.length)
      throw new Error(
        `owned processes survived MCP crash: ${JSON.stringify(survivors)}`,
      );
    const recovery = new Session("crash-pool-recovery");
    await recovery.start();
    try {
      await openBinary(recovery, "crash_pool_recovery_a", BINARY);
      requireOk(
        await recovery.call(
          "crash_pool_recovery_pseudo_a",
          "procedure_pseudo_code",
          { procedure: PROBE_FUNCTIONS[0] },
        ),
        "crash-pool recovery A",
      );
      await openBinary(recovery, "crash_pool_recovery_b", BINARY_B);
      requireOk(
        await recovery.call(
          "crash_pool_recovery_pseudo_b",
          "procedure_pseudo_code",
          { procedure: PROBE_B },
        ),
        "crash-pool recovery B",
      );
      requireOk(
        await recovery.call("crash_pool_recovery_close", "close_binary", {}),
        "crash-pool recovery close",
      );
    } finally {
      await recovery.stop();
    }
    results.crashPool = {
      observedProcesses: family.length,
      survivors: survivors.length,
      recoveredBothTargets: true,
    };
  } finally {
    await owner.stop();
  }
};

const runMcp = async (results) => {
  if (!SCENARIOS.has("mcp")) return;
  const session = new Session("mcp");
  await session.start();
  try {
    const tools = await session.request("tools/list", {});
    const prompts = await session.request("prompts/list", {});
    if (!(tools.tools ?? []).some((tool) => tool.name === "open_binary"))
      throw new Error("MCP catalog lacks open_binary");
    results.mcp = {
      tools: (tools.tools ?? []).length,
      prompts: (prompts.prompts ?? []).length,
      toolNames: (tools.tools ?? []).map((tool) => tool.name).sort(),
    };
  } finally {
    await session.stop();
  }
};

const compareFingerprints = (cold, cached) => {
  if (!cold || !cached) return { compared: false };
  const fields = {
    functionCount: [cold.functionCount, cached.functionCount],
    addressDigest: [cold.addressDigest, cached.addressDigest],
    overviewDigest: [cold.overviewDigest, cached.overviewDigest],
    xrefs: [
      JSON.stringify(cold.xrefs.map((item) => item.digest)),
      JSON.stringify(cached.xrefs.map((item) => item.digest)),
    ],
    code: [
      JSON.stringify(cold.code.map((item) => item.digest)),
      JSON.stringify(cached.code.map((item) => item.digest)),
    ],
    symbols: [cold.symbolsDigest, cached.symbolsDigest],
    instructions: [cold.instructionsDigest, cached.instructionsDigest],
    dossier: [cold.dossierDigest, cached.dossierDigest],
  };
  const all = Object.values(fields);
  return {
    compared: true,
    equal: all.every(([left, right]) => left === right),
    functionCount: fields.functionCount,
    addressDigest: fields.addressDigest,
    overviewDigest: fields.overviewDigest,
    xrefs: fields.xrefs,
    code: fields.code,
    symbols: fields.symbols,
    instructions: fields.instructions,
    dossier: fields.dossier,
  };
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const targetSha = await sha256File(BINARY);
  const size = (await stat(BINARY)).size;
  console.log(`target ${BINARY} sha256=${targetSha} bytes=${size}`);
  console.log(`checkpoint root ${CHECKPOINT_ROOT}`);
  await ensureCheckpointRoot();
  if (SCENARIOS.has("cold")) {
    CHECKPOINT_ROOT = (
      await VerifierFixture.keepArtifacts({
        parent: CHECKPOINT_ROOT,
        prefix: "acceptance-",
      })
    ).path;
    console.log(`isolated cold checkpoint root ${CHECKPOINT_ROOT}`);
  }

  const results = {
    startedAt,
    binary: BINARY,
    targetSha,
    size,
    checkpointRoot: CHECKPOINT_ROOT,
  };
  await runCold(targetSha, results);
  await runRestart(results);
  await runSwitch(results);
  await runPoolExperiment(results);
  await runAliasSwitch(results);
  await runSameSha(results);
  await runMutation(results);
  await runCorruption(results);
  await runConcurrent(results);
  await runCrash(results);
  await runCrashPool(results);
  await runMcp(results);

  results.equivalence = {
    coldVsRestart: compareFingerprints(
      results.cold?.fingerprint,
      results.restart?.fingerprint,
    ),
  };

  if (
    SCENARIOS.has("cold") &&
    SCENARIOS.has("restart") &&
    !results.equivalence.coldVsRestart.equal
  )
    throw new Error("cold and restored fingerprints differ");
  results.finishedAt = new Date().toISOString();
  await mkdir(REPORT, { recursive: true });
  const reportPath = join(REPORT, `verify-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`report ${reportPath}`);
  const summary = [
    `cold open ${results.cold?.openMs ?? "n/a"}ms`,
    `restart restore ${results.restart?.restoreTotalMs ?? "n/a"}ms`,
    `switch back ${results.switch?.backToAMs ?? "n/a"}ms`,
    `same-sha restore ${results.sameSha?.restoreTotalMs ?? "n/a"}ms`,
    `equivalence ${results.equivalence.coldVsRestart.equal ?? "n/a"}`,
    `mcp tools ${results.mcp?.tools ?? "n/a"}`,
  ];
  console.log(summary.join(" | "));
};

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
