import { appendCallerPath } from "../filesystem/callerPath.js";
import { classifyProviderFailure } from "../providers/classifyProviderFailure.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  adjustWindowsCheckpointDirectory,
  assertWindowsCheckpointDirectoryPrivate,
  assertWindowsCheckpointRootPrivate,
} from "../windows/WindowsCheckpointDirectory.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { z } from "zod";
import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { AnalysisCleanupRelease } from "../domain/analysisCleanupRelease.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  type ArtifactResourceScope,
  withArtifactFileHandle,
  withArtifactRegularFile,
  assertArtifactReadActive,
  artifactFilePrimaryFacts,
  mapArtifactFileFailure,
} from "../resources/index.js";
import {
  sameRegularFileState,
  RegularFileChangedError,
} from "../filesystem/RegularFile.js";
import { acquireOwnedLease, type OwnedLease } from "../process/OwnedLease.js";
import {
  ghidraFileDialect,
  readGhidraProfileArtifact,
} from "./GhidraFileArtifacts.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z
  .object({
    file: z.string().regex(/^program-[a-f0-9-]{36}\.gzf$/),
    sha256: digest,
    kind: z.enum(["initial-analysis", "retained"]),
  })
  .strict();
type CheckpointSource = z.infer<typeof sourceSchema>;
const manifestSchema = z
  .object({
    version: z.literal(2),
    target_sha256: digest,
    base_profile_digest: digest,
    source: sourceSchema,
  })
  .strict();
const stateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initial-analysis") }).strict(),
  z.object({ kind: z.literal("retained"), sha256: digest }).strict(),
]);
const checkpointState = (
  source: CheckpointSource | null,
): z.infer<typeof stateSchema> =>
  source === null || source.kind === "initial-analysis"
    ? { kind: "initial-analysis" }
    : { kind: "retained", sha256: source.sha256 };

/** Semantic generation is stable through the first save; edited states bind their digest. */
export const ghidraCheckpointSelectionSchema = z
  .object({
    directory: z.string().min(1),
    key: digest,
    target_sha256: digest,
    base_profile_digest: digest,
    state: stateSchema,
  })
  .strict();
export type GhidraCheckpointSelection = z.infer<
  typeof ghidraCheckpointSelectionSchema
>;
export interface GhidraPackedProgram {
  readonly path: string;
  readonly sha256: string;
}

const missing = (cause: unknown): boolean => {
  const primary = artifactFilePrimaryFacts(cause).cause;
  return (
    primary instanceof Error && "code" in primary && primary.code === "ENOENT"
  );
};
const failure = (directory: string, reason: string, cause?: unknown) =>
  new ConfigurationError(
    `Ghidra checkpoint at ${JSON.stringify(directory)}: ${reason}. Preserve this directory; correct its contents or select a new REA_GHIDRA_CHECKPOINT_DIR, then reopen the target.`,
    {
      cause,
      settings: [{ setting: "REA_GHIDRA_CHECKPOINT_DIR", constraint: reason }],
    },
  );

/** Hash large packed Programs with one 64 KiB buffer and stable descriptor identity. */
export const hashGhidraPackedProgram = (
  path: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<string> =>
  withArtifactRegularFile(
    path,
    resources,
    signal,
    async ({ handle, initial }) => {
      const hash = createHash("sha256"),
        buffer = Buffer.allocUnsafe(64 * 1024);
      for (let offset = 0; offset < initial.size;) {
        assertArtifactReadActive(signal);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, initial.size - offset),
          offset,
        );
        if (bytesRead === 0) throw new RegularFileChangedError(path);
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (!sameRegularFileState(initial, await handle.stat()))
        throw new RegularFileChangedError(path);
      return hash.digest("hex");
    },
  );

async function readSource(
  selection: Omit<GhidraCheckpointSelection, "state">,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) {
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = await readGhidraProfileArtifact(
      appendCallerPath(selection.directory, "current.json"),
      64 * 1024,
      resources,
      signal,
      (bytes) => manifestSchema.parse(JSON.parse(bytes.toString("utf8"))),
    );
  } catch (cause: unknown) {
    if (missing(cause) && !resources.hasPending) return null;
    let primary: unknown = cause;
    try {
      primary = artifactFilePrimaryFacts(cause).cause;
    } catch {}
    if (
      (primary instanceof SyntaxError || primary instanceof z.ZodError) &&
      (await quarantineManifest(selection.directory))
    )
      return null;
    throw classifyProviderFailure(
      mapArtifactFileFailure(cause, (primary) =>
        primary instanceof SyntaxError || primary instanceof z.ZodError
          ? failure(selection.directory, "the manifest is malformed", primary)
          : primary,
      ),
      ghidraFileDialect("resolve_analysis_profile", {
        path: appendCallerPath(selection.directory, "current.json"),
      }),
    );
  }
  if (
    manifest.target_sha256 !== selection.target_sha256 ||
    manifest.base_profile_digest !== selection.base_profile_digest
  )
    throw failure(
      selection.directory,
      "the manifest belongs to a different target or analysis profile",
    );
  const path = appendCallerPath(selection.directory, manifest.source.file);
  let actual: string;
  try {
    actual = await hashGhidraPackedProgram(path, resources, signal);
  } catch (cause: unknown) {
    // A vanished blob is a damaged cache, not a broken profile: quarantine the
    // manifest so the caller performs a fresh analysis instead of failing.
    if (missing(cause) && (await quarantineManifest(selection.directory)))
      return null;
    throw classifyProviderFailure(
      cause,
      ghidraFileDialect("resolve_analysis_profile", { path }),
    );
  }
  if (actual !== manifest.source.sha256) {
    await quarantineManifest(selection.directory);
    return null;
  }
  return manifest.source;
}

/** Rename a damaged manifest out of the way; the integrity check never admits it. */
async function quarantineManifest(directory: string): Promise<boolean> {
  try {
    await rename(
      appendCallerPath(directory, "current.json"),
      appendCallerPath(directory, `current.invalid-${randomUUID()}.json`),
    );
    return true;
  } catch {
    return false;
  }
}

/** Resolve storage and content identity once for the shared CLI/MCP analysis profile. */
export async function resolveGhidraCheckpoint(
  root: string,
  targetSha256: string,
  profile: AnalysisProfileCommitment,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<GhidraCheckpointSelection> {
  const key = sha256Hex(JSON.stringify([targetSha256, profile.digest]));
  const selection = {
    directory: appendCallerPath(root, key),
    key,
    target_sha256: targetSha256,
    base_profile_digest: profile.digest,
  };
  return {
    ...selection,
    state: checkpointState(await readSource(selection, resources, signal)),
  };
}

const directoryExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause: unknown) {
    if (missing(cause)) return false;
    throw cause;
  }
};

/**
 * Establish a private cache directory once per session.
 *
 * POSIX keeps the upstream owner-only mode check. Windows has no POSIX mode:
 * REA hardens every cache directory it creates (removing inherited ACEs) and
 * proves the result, while a caller-selected root is inspected only so an
 * explicitly configured directory is never re-permissioned behind the user.
 */
const ensurePrivateCheckpointDirectory = async (
  directory: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (HOST_PLATFORM.platform !== "win32") {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const state = await lstat(directory);
    if (
      !state.isDirectory() ||
      (state.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && state.uid !== process.getuid())
    )
      throw failure(
        directory,
        "the checkpoint directory must be a private directory owned by this user",
      );
    return;
  }
  const root = dirname(directory);
  const rootExisted = await directoryExists(root);
  const keyExisted = await directoryExists(directory);
  try {
    if (!rootExisted) {
      await mkdir(root, { recursive: true });
      await adjustWindowsCheckpointDirectory(root);
    } else {
      let privateRoot = true;
      try {
        await assertWindowsCheckpointRootPrivate(root);
      } catch {
        privateRoot = false;
      }
      if (!privateRoot) {
        // An empty caller-selected root is dedicated to this cache, so REA may
        // replace its inherited DACL. A populated one belongs to the user and
        // is refused rather than re-permissioned behind their back.
        if ((await readdir(root)).length > 0)
          throw new Error(
            `the checkpoint root ${JSON.stringify(root)} is writable by other accounts; choose a dedicated empty directory or remove their write access`,
          );
        await adjustWindowsCheckpointDirectory(root);
      }
    }
    if (keyExisted) await assertWindowsCheckpointDirectoryPrivate(directory);
    else {
      await mkdir(directory, { recursive: true });
      await adjustWindowsCheckpointDirectory(directory);
    }
  } catch (cause: unknown) {
    throw failure(
      directory,
      `the checkpoint directory must stay private to this user: ${errorMessage(cause)}`,
      cause,
    );
  }
  assertArtifactReadActive(signal);
  const state = await lstat(directory);
  if (!state.isDirectory() || state.isSymbolicLink())
    throw failure(
      directory,
      "the checkpoint directory must be a real directory, not a link or reparse point",
    );
};

/** One session owns publication, the socket lease, and any failed staging cleanup. */
export class GhidraCheckpoint {
  #lease: OwnedLease | undefined;
  #source: CheckpointSource | null | undefined;
  #state: GhidraCheckpointSelection["state"];
  readonly #pendingRemoval = new Set<string>();
  /** Reported by every removal failure until a retry removes every file. */
  #cleanupRelease = new AnalysisCleanupRelease();
  #publishedInput: string | undefined;
  constructor(
    readonly selection: GhidraCheckpointSelection,
    private readonly resources: ArtifactResourceScope,
  ) {
    this.#state = selection.state;
  }
  get hasResources(): boolean {
    return this.#lease !== undefined || this.#pendingRemoval.size > 0;
  }
  get cleanupResources(): readonly string[] {
    return [
      ...(this.#lease === undefined
        ? []
        : [this.#lease.socketPath ?? this.selection.directory]),
      ...this.#pendingRemoval,
    ];
  }
  get observation() {
    return {
      directory: this.selection.directory,
      source: this.#source ?? null,
      source_verified: this.#source !== undefined,
      state: this.#state,
      pending_cleanup: [...this.#pendingRemoval],
    };
  }

  async acquire(
    runId: string,
    signal?: AbortSignal,
  ): Promise<GhidraPackedProgram | undefined> {
    assertArtifactReadActive(signal);
    await ensurePrivateCheckpointDirectory(this.selection.directory, signal);
    const directory = await realpath(this.selection.directory);
    const acquired = await acquireOwnedLease({
      identity: { kind: "ghidra-checkpoint-v1", directory },
      runId,
      directory: join(
        HOST_PLATFORM.platform === "win32" ? tmpdir() : "/tmp",
        `rea-ghidra-checkpoint-leases-${process.getuid?.() ?? "user"}`,
      ),
      resources: this.resources,
      failure: (reason, cause) =>
        failure(
          directory,
          `lease ${reason.kind}${cause instanceof Error ? `: ${cause.message}` : ""}`,
          cause,
        ),
    });
    if (!acquired.acquired)
      throw failure(
        directory,
        `another REA session owns this checkpoint (run ${acquired.owner.runId}, process ${acquired.owner.processId}); close that session before retrying`,
      );
    this.#lease = acquired.lease;
    this.#source = undefined;
    const current = await readSource(this.selection, this.resources, signal);
    const generation = checkpointState(current);
    const aligned =
      generation.kind === "initial-analysis"
        ? this.#state.kind === "initial-analysis"
        : this.#state.kind === "retained" &&
          this.#state.sha256 === generation.sha256;
    if (!aligned)
      throw failure(
        directory,
        "the checkpoint changed after profile selection; reopen the target",
      );
    assertArtifactReadActive(signal);
    this.#source = current;
    return current === null
      ? undefined
      : { path: join(directory, current.file), sha256: current.sha256 };
  }

  /** Publish a new immutable blob, then atomically replace its manifest. */
  async publish(path: string, signal?: AbortSignal): Promise<void> {
    if (this.#lease === undefined || this.#source === undefined)
      throw failure(
        this.selection.directory,
        "publication has no admitted session lease",
      );
    const previous = this.#source;
    await this.retryCleanup();
    if (this.#publishedInput === path) return;
    const file = `program-${randomUUID()}.gzf`;
    const destination = appendCallerPath(this.selection.directory, file);
    const temporary = appendCallerPath(
      this.selection.directory,
      `.current-${randomUUID()}.json`,
    );
    this.#pendingRemoval.add(destination);
    this.#pendingRemoval.add(temporary);
    let primary: unknown;
    let failed = false;
    try {
      assertArtifactReadActive(signal);
      await copyFile(path, destination, constants.COPYFILE_EXCL);
      const sha256 = await hashGhidraPackedProgram(
        destination,
        this.resources,
        signal,
      );
      const source: CheckpointSource = {
        file,
        sha256,
        kind: previous === null ? "initial-analysis" : "retained",
      };
      for (const [output, bytes] of [
        [destination, undefined],
        [
          temporary,
          JSON.stringify({
            version: 2,
            target_sha256: this.selection.target_sha256,
            base_profile_digest: this.selection.base_profile_digest,
            source,
          }),
        ],
      ] as const) {
        const handle = await open(
          output,
          bytes === undefined ? "r+" : "wx",
          0o600,
        );
        await withArtifactFileHandle(
          output,
          handle,
          this.resources,
          signal,
          async (handle) => {
            if (bytes !== undefined) await handle.writeFile(bytes);
            await handle.sync();
          },
        );
      }
      assertArtifactReadActive(signal);
      await rename(
        temporary,
        appendCallerPath(this.selection.directory, "current.json"),
      );
      this.#source = source;
      this.#state = checkpointState(source);
      this.#publishedInput = path;
      this.#pendingRemoval.delete(destination);
      this.#pendingRemoval.delete(temporary);
      if (previous !== null)
        this.#pendingRemoval.add(
          appendCallerPath(this.selection.directory, previous.file),
        );
    } catch (cause: unknown) {
      primary = cause;
      failed = true;
    }
    try {
      await this.retryCleanup();
    } catch (cause: unknown) {
      if (failed)
        throw analysisErrorWithCleanupFailure(
          classifyProviderFailure(
            primary,
            ghidraFileDialect("checkpoint_program", {
              path: this.selection.directory,
            }),
          ),
          classifyProviderFailure(
            cause,
            ghidraFileDialect("checkpoint_program", {
              path: this.selection.directory,
            }),
          ),
        );
      throw cause;
    }
    if (failed)
      throw classifyProviderFailure(
        primary,
        ghidraFileDialect("checkpoint_program", {
          path: this.selection.directory,
        }),
      );
    assertArtifactReadActive(signal);
  }

  async retryCleanup(): Promise<void> {
    for (const path of this.#pendingRemoval) {
      try {
        await rm(path, { force: true });
        this.#pendingRemoval.delete(path);
      } catch (cause: unknown) {
        const error = new ProviderCleanupError(
          "ghidra",
          [...this.#pendingRemoval],
          {
            reason: `Checkpoint file cleanup failed: ${errorMessage(cause)}`,
            checkpoint: this.observation,
          },
          { cause },
        );
        throw this.#cleanupRelease.bind(error);
      }
    }
    this.#cleanupRelease.confirm();
    this.#cleanupRelease = new AnalysisCleanupRelease();
  }
  async close(): Promise<void> {
    await this.retryCleanup();
    await this.#lease?.release();
    this.#lease = undefined;
  }
}
