import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { elf } from "../../domain/binaryTarget.fixture.js";
import { createTestBinarySession } from "../../../tests/fixtures/binarySession.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { releaseOwnedCleanup } from "../../../tests/support/cleanupRelease.js";
import { err, ok } from "../../domain/result.js";
import { createAnalysisExecution } from "../../ports/AnalysisProvider.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { BinarySession } from "./BinarySession.js";
import {
  SessionProviderRouter,
  type SessionProviderRoute,
} from "./SessionProviderRouter.js";

const identity = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
};

async function fixture(
  sharedExclusion: boolean | ((path: string) => string) = false,
  retainedTargetLimit: 2 | 3 | 4 | 5 = 2,
) {
  const dir = await createTestTempDirectory("rea-switch-retain-");
  const paths = ["a", "b", "c", "d", "e", "f"].map((name) =>
    join(dir, `${name}.elf`),
  );
  for (const path of paths) await writeFile(path, elf(2, 1, 62));
  const created: string[] = [];
  const closed: string[] = [];
  let failClose: string | undefined;
  let failedOwner: string | undefined;
  let onClose: ((path: string) => void) | undefined;
  let generation = 0;
  const blocked = new Set<string>();
  const failure = new ProviderCleanupError("fixture", ["client"], {
    reason: "controlled close",
  });
  const session = createTestBinarySession(
    (target) => {
      created.push(target.path);
      return {
        execute: async () => ok(createAnalysisExecution(target.path, identity)),
        reuseReadiness: () => (blocked.has(target.path) ? "blocked" : "ready"),
        close: async () => {
          closed.push(target.path);
          onClose?.(target.path);
          if (failClose === target.path) {
            failClose = undefined;
            failedOwner = target.path;
            return err(failure);
          }
          if (failedOwner === target.path) releaseOwnedCleanup(failure);
          return ok(null);
        },
      };
    },
    {
      retainedTargetLimit,
      resolveAnalysisProfile: async (target) =>
        ok({
          profile: createAnalysisProfile(identity, {
            fixture: true,
            generation,
          }),
          retainOnTargetSwitch: true,
          targetSwitchExclusionKey:
            typeof sharedExclusion === "function"
              ? sharedExclusion(target.path)
              : sharedExclusion
                ? "same-lease"
                : target.path,
        }),
    },
  );
  return {
    session,
    paths,
    created,
    closed,
    failNextClose: (path: string) => {
      failClose = path;
    },
    onClose: (callback: (path: string) => void) => {
      onClose = callback;
    },
    block: (path: string) => blocked.add(path),
    setGeneration: (value: number) => {
      generation = value;
    },
  };
}

it.each([3, 4, 5] as const)(
  "reuses %i targets and evicts the least recently used",
  async (capacity) => {
    const f = await fixture(false, capacity);
    const selected = f.paths.slice(0, capacity);
    const first = selected[0]!;
    const second = selected[1]!;
    const next = f.paths[capacity]!;
    try {
      for (const path of selected) {
        expect((await f.session.open(path)).ok).toBe(true);
        expect((await f.session.execute("address_name", {})).ok).toBe(true);
      }
      expect((await f.session.open(first)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
      expect(f.created).toEqual(selected);
      expect(f.closed).toEqual([]);
      expect((await f.session.open(next)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
      expect(f.closed).toEqual([second]);
      expect(f.created).toEqual([...selected, next]);
      expect((await f.session.close()).ok).toBe(true);
      expect(f.closed).toHaveLength(capacity + 1);
    } finally {
      await f.session.close();
    }
  },
);

it("releases a conflicting parked lease without evicting unrelated owners", async () => {
  const f = await fixture(
    (path) => (/[\\/][ac]\.elf$/u.test(path) ? "alias" : path),
    4,
  );
  const [a, b, c, d] = f.paths as [string, string, string, string];
  try {
    for (const path of [a, b, d, c]) {
      expect((await f.session.open(path)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
    }
    expect(f.closed).toEqual([a]);
    expect((await f.session.open(b)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect(f.created).toEqual([a, b, d, c]);
  } finally {
    await f.session.close();
  }
});

it("retains remaining parked owners when a multi-target final cleanup fails", async () => {
  const f = await fixture(false, 4);
  const [a, b, c, d] = f.paths as [string, string, string, string];
  try {
    for (const path of [a, b, c, d]) {
      expect((await f.session.open(path)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
    }
    f.failNextClose(b);
    const closed = await f.session.close();
    expect(closed.ok).toBe(false);
    expect(f.closed).toEqual([d, a, b]);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([d, a, b, b, c]);
    if (!closed.ok) expect(closed.error.cleanupIncomplete).toBe(false);
  } finally {
    await f.session.close();
  }
});

it("reset releases every parked target while keeping the active one", async () => {
  const f = await fixture(false, 4);
  const [a, b, c, d] = f.paths as [string, string, string, string];
  try {
    for (const path of [a, b, c, d]) {
      expect((await f.session.open(path)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
    }
    expect((await f.session.resetInvestigation()).ok).toBe(true);
    expect(f.closed).toEqual([a, b, c]);
    expect(f.session.activeTarget()?.path).toBe(d);
  } finally {
    await f.session.close();
  }
});

it("reset cancellation during parked cleanup retains the other owners", async () => {
  const f = await fixture(false, 4);
  const [a, b, c, d] = f.paths as [string, string, string, string];
  const controller = new AbortController();
  try {
    for (const path of [a, b, c, d]) {
      expect((await f.session.open(path)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
    }
    f.onClose((path) => {
      if (path === a) controller.abort("reset cancelled during cleanup");
    });
    const reset = await f.session.resetInvestigation({
      signal: controller.signal,
    });
    expect(reset.ok).toBe(false);
    if (reset.ok) throw new Error("expected cancellation");
    expect(reset.error._tag).toBe("AnalysisCancelledError");
    expect(reset.error.cause).toBe("reset cancelled during cleanup");
    expect(f.closed).toEqual([a]);
    expect(f.session.activeTarget()?.path).toBe(d);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([a, d, b, c]);
  } finally {
    await f.session.close();
  }
});

it("preserves other parked owners after cancellation and a failed multi-target eviction", async () => {
  const f = await fixture(false, 3);
  const [a, b, c, d] = f.paths as [string, string, string, string];
  const controller = new AbortController();
  try {
    for (const path of [a, b, c]) {
      expect((await f.session.open(path)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
    }
    f.failNextClose(a);
    f.onClose((path) => {
      if (path === a) controller.abort("eviction cancelled");
    });
    const switched = await f.session.open(d, { signal: controller.signal });
    expect(switched.ok).toBe(false);
    if (switched.ok) throw new Error("expected cancellation");
    expect(switched.error.cleanupIncomplete).toBe(true);
    expect(f.session.activeTarget()?.path).toBe(c);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([a, a, c, b]);
    expect(switched.error.cleanupIncomplete).toBe(false);
  } finally {
    await f.session.close();
  }
});

it("reuses A after A/B/A and closes both owners", async () => {
  const f = await fixture();
  const [a, b] = f.paths as [string, string];
  try {
    expect((await f.session.open(a)).ok).toBe(true);
    expect(
      (
        await f.session.execute("address_name", {
          document: "0",
          address: "0x1000",
        })
      ).ok,
    ).toBe(true);
    expect((await f.session.open(b)).ok).toBe(true);
    expect(
      (
        await f.session.execute("address_name", {
          document: "0",
          address: "0x1000",
        })
      ).ok,
    ).toBe(true);
    expect((await f.session.open(a)).ok).toBe(true);
    const result = await f.session.execute("address_name", {
      document: "0",
      address: "0x1000",
    });
    expect(result.ok && result.value.result).toBe(a);
    if (!result.ok) throw result.error;
    expect(result.value.subject).toMatchObject({ path: a });
    expect(f.session.exportEvidenceBundle().records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalized_result: a }),
        expect.objectContaining({ normalized_result: b }),
      ]),
    );
    expect(f.created).toEqual([a, b]);
    expect(f.closed).toEqual([]);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([a, b]);
  } finally {
    await f.session.close();
  }
});

it("retains failed eviction for retry while preserving the active target", async () => {
  const f = await fixture();
  const [a, b, c] = f.paths as [string, string, string];
  try {
    expect((await f.session.open(a)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect((await f.session.open(b)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    f.failNextClose(a);
    expect((await f.session.open(c)).ok).toBe(false);
    expect(f.session.activeTarget()?.path).toBe(b);
    expect((await f.session.open(c)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect(f.closed).toEqual([a, a]);
    expect(f.created).toEqual([a, b, c]);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([a, a, c, b]);
  } finally {
    await f.session.close();
  }
});

it("reset closes the standby but retains the active client", async () => {
  const f = await fixture();
  const [a, b] = f.paths as [string, string];
  try {
    expect((await f.session.open(a)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect((await f.session.open(b)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect((await f.session.resetInvestigation()).ok).toBe(true);
    expect(f.closed).toEqual([a]);
    expect(f.session.activeTarget()?.path).toBe(b);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([a, b]);
  } finally {
    await f.session.close();
  }
});

it("explicit close retries failed standby eviction before closing the active owner", async () => {
  const f = await fixture();
  const [a, b, c] = f.paths as [string, string, string];
  try {
    expect((await f.session.open(a)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect((await f.session.open(b)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    f.failNextClose(a);
    expect((await f.session.open(c)).ok).toBe(false);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([a, a, b]);
    expect(f.session.activeTarget()).toBeUndefined();
  } finally {
    await f.session.close();
  }
});

it.each([false, true])(
  "cancellation during standby eviction retains cleanup failure=%s",
  async (fail) => {
    const f = await fixture();
    const [a, b, c] = f.paths as [string, string, string];
    const controller = new AbortController();
    try {
      expect((await f.session.open(a)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
      expect((await f.session.open(b)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
      if (fail) f.failNextClose(a);
      f.onClose((path) => {
        if (path === a) controller.abort("cancel during eviction");
      });
      const switched = await f.session.open(c, { signal: controller.signal });
      expect(switched.ok).toBe(false);
      if (switched.ok) throw new Error("expected cancellation");
      const cancellation = fail
        ? switched.error.cleanupPrimary
        : switched.error;
      expect(cancellation?._tag).toBe("AnalysisCancelledError");
      expect(cancellation?.cause).toBe("cancel during eviction");
      expect(switched.error.cleanupIncomplete).toBe(fail);
      expect(f.session.activeTarget()?.path).toBe(b);
      expect((await f.session.close()).ok).toBe(true);
      expect(f.closed).toEqual(fail ? [a, a, b] : [a, b]);
    } finally {
      await f.session.close();
    }
  },
);

it.each(["blocked", "profile", "target"])(
  "does not reuse a stale standby: %s",
  async (changed) => {
    const f = await fixture();
    const [a, b] = f.paths as [string, string];
    try {
      expect((await f.session.open(a)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
      expect((await f.session.open(b)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
      if (changed === "blocked") f.block(a);
      if (changed === "profile") f.setGeneration(1);
      if (changed === "target")
        await writeFile(a, Buffer.concat([elf(2, 1, 62), Buffer.from([1])]));
      expect((await f.session.open(a)).ok).toBe(true);
      expect((await f.session.execute("address_name", {})).ok).toBe(true);
      expect(f.created).toEqual([a, b, a]);
      expect(f.closed).toEqual([a]);
    } finally {
      await f.session.close();
    }
  },
);

it("retains failed final standby cleanup and retries it on close", async () => {
  const f = await fixture();
  const [a, b] = f.paths as [string, string];
  try {
    expect((await f.session.open(a)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect((await f.session.open(b)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    f.failNextClose(a);
    const closed = await f.session.close();
    expect(closed.ok).toBe(false);
    if (closed.ok) throw new Error("expected cleanup failure");
    expect(closed.error.cleanupIncomplete).toBe(true);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([b, a, a]);
    expect(closed.error.cleanupIncomplete).toBe(false);
  } finally {
    await f.session.close();
  }
});

it.each([false, true])(
  "failed incoming health restores the previous client (previous dead: %s)",
  async (dead) => {
    const dir = await createTestTempDirectory("rea-switch-restore-");
    const a = join(dir, "a.elf");
    const b = join(dir, "b.elf");
    await writeFile(a, elf(2, 1, 62));
    await writeFile(b, elf(2, 1, 62));
    const session = new BinarySession(
      SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), []),
    );
    let aCreated = 0,
      aClosed = 0,
      bClosed = 0;
    let blockA = false;
    const failure = new AnalysisOutputError(
      "health",
      "controlled incoming failure",
    );
    const route: SessionProviderRoute = {
      identity,
      capabilities: new Map(),
      profile: createAnalysisProfile(identity, { fixture: true }),
      binding: {
        identity,
        retainOnTargetSwitch: true,
        targetSwitchExclusionKey: "first",
      } as NonNullable<SessionProviderRoute["binding"]>,
      selection: undefined,
      createClient: (target) => {
        if (target.path === a) {
          aCreated++;
          return {
            reuseReadiness: () => (blockA ? "blocked" : "ready"),
            canRetainOnTargetSwitch: () => true,
            execute: async () => ok(createAnalysisExecution(null, identity)),
            close: async () => {
              aClosed++;
              blockA = false;
              return ok(null);
            },
          };
        }
        return {
          execute: async () => {
            blockA = dead;
            return err(failure);
          },
          close: async () => {
            bClosed++;
            return ok(null);
          },
        };
      },
    };
    try {
      const first = await session.resolveTarget(a),
        second = await session.resolveTarget(b);
      if (!first.ok) throw first.error;
      if (!second.ok) throw second.error;
      expect(
        (await session.openResolvedTarget({ target: first.value, route })).ok,
      ).toBe(true);
      expect(
        (
          await session.openResolvedTarget({
            target: second.value,
            route: {
              ...route,
              binding: {
                ...route.binding!,
                targetSwitchExclusionKey: "second",
              },
            },
          })
        ).ok,
      ).toBe(false);
      expect(session.activeTarget()?.path).toBe(a);
      expect(aCreated).toBe(dead ? 2 : 1);
      expect(aClosed).toBe(dead ? 1 : 0);
      expect(bClosed).toBe(1);
    } finally {
      await session.close();
    }
  },
);

it("keeps the standby owned when active cleanup fails and retries both", async () => {
  const f = await fixture();
  const [a, b] = f.paths as [string, string];
  try {
    expect((await f.session.open(a)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect((await f.session.open(b)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    f.failNextClose(b);
    const first = await f.session.close();
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected failed active cleanup");
    expect(first.error.cleanupIncomplete).toBe(true);
    expect(f.closed).toEqual([b]);
    expect((await f.session.close()).ok).toBe(true);
    expect(f.closed).toEqual([b, b, a]);
    expect(first.error.cleanupIncomplete).toBe(false);
  } finally {
    await f.session.close();
  }
});

it("closes the active client before switching to another path with the same exclusive lease", async () => {
  const f = await fixture(true);
  const [a, b] = f.paths as [string, string];
  try {
    expect((await f.session.open(a)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect((await f.session.open(b)).ok).toBe(true);
    expect((await f.session.execute("address_name", {})).ok).toBe(true);
    expect(f.closed).toEqual([a]);
    expect(f.created).toEqual([a, b]);
  } finally {
    await f.session.close();
  }
});
