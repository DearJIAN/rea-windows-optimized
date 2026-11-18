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
//                           profile,corruption,concurrent,crash,mcp
//     --skip-cold-baseline  reuse the stored cold fingerprint from a prior run
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

const REPO = resolve(import.meta.dirname, "..");
const CLI = join(REPO, "scripts", "rea.mjs");
const GHIDRA_HOME = process.env.GHIDRA_INSTALL_DIR;
const JAVA_HOME = process.env.JAVA_HOME;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const BINARY = flag("binary");
const BINARY_B = flag("binary-b");
const CHECKPOINT_ROOT = resolve(
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

const PROBE_ADDRESSES = ["0x10041eb0", "0x1004fa00"];
const PROBE_FUNCTIONS = ["0x10041eb0", "0x1004fa00"];

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
        settle(message);
      }
    });
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "rea-windows-checkpoints-verify", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  request(method, params, timeoutMs = 900_000) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error)
          reject(new Error(JSON.stringify(message.error).slice(0, 400)));
        else resolvePromise(message.result);
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
  const countMatch = overview.text.match(
    /(?:functions?|procedures?)\D{0,12}(\d+)/iu,
  );
  return {
    overviewText: overview.text,
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
    const bOpened = await openBinary(session, "switch_open_b", BINARY_B);
    const bProbe = await session.call(
      "switch_pseudo_b",
      "procedure_pseudo_code",
      {
        procedure: "0x10001000",
      },
    );
    const aOpened = await openBinary(session, "switch_open_a", BINARY);
    const aProbe = await session.call(
      "switch_pseudo_a",
      "procedure_pseudo_code",
      {
        procedure: PROBE_FUNCTIONS[0],
      },
    );
    requireOk(aProbe, "switch pseudo");
    results.switch = {
      openBMs: bOpened.ms,
      analyseBMs: bProbe.ms,
      backToAMs: aOpened.ms + aProbe.ms,
    };
  } finally {
    await session.call("switch_close", "close_binary", {});
    await session.stop();
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
    results.concurrent = {
      firstMs: a.ms + aAnalysis.ms,
      firstError: aAnalysis.isError,
      secondMs: b.ms + bAnalysis.ms,
      secondError: bAnalysis.isError,
      secondMessage: bAnalysis.isError
        ? (bAnalysis.error ?? bAnalysis.text).slice(0, 300)
        : "second session shared the cache",
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
  const opened = session.call("crash_open", "open_binary", {
    path: BINARY,
    provider_id: "ghidra",
  });
  const analysed = session.call("crash_analyse", "procedure_pseudo_code", {
    procedure: PROBE_FUNCTIONS[0],
  });
  // Kill mid-analysis/warm-up, then prove a later owner is not blocked.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000));
  await session.kill();
  opened.catch(() => {});
  analysed.catch(() => {});
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

const runMcp = async (results) => {
  if (!SCENARIOS.has("mcp")) return;
  const session = new Session("mcp");
  await session.start();
  try {
    const tools = await session.request("tools/list", {});
    const prompts = await session.request("prompts/list", {});
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
  };
  return {
    compared: true,
    equal:
      fields.functionCount[0] === fields.functionCount[1] &&
      fields.addressDigest[0] === fields.addressDigest[1] &&
      fields.overviewDigest[0] === fields.overviewDigest[1] &&
      JSON.stringify(fields.xrefs[0]) === JSON.stringify(fields.xrefs[1]) &&
      JSON.stringify(fields.code[0]) === JSON.stringify(fields.code[1]),
    functionCount: fields.functionCount,
    addressDigest: fields.addressDigest,
    overviewDigest: fields.overviewDigest,
    xrefs: fields.xrefs,
    code: fields.code,
  };
};

const main = async () => {
  const startedAt = new Date().toISOString();
  const targetSha = await sha256File(BINARY);
  const size = (await stat(BINARY)).size;
  console.log(`target ${BINARY} sha256=${targetSha} bytes=${size}`);
  console.log(`checkpoint root ${CHECKPOINT_ROOT}`);
  const existing = await ensureCheckpointRoot();
  if (existing > 0 && (SCENARIOS.has("cold") || SCENARIOS.has("restart")))
    console.log(`checkpoint root already holds ${existing} entries`);

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
  await runSameSha(results);
  await runMutation(results);
  await runCorruption(results);
  await runConcurrent(results);
  await runCrash(results);
  await runMcp(results);

  results.equivalence = {
    coldVsRestart: compareFingerprints(
      results.cold?.fingerprint,
      results.restart?.fingerprint,
    ),
  };

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
