// ---------------------------------------------------------------------------
// Zephyr environment check — the shared detection behind `typecad-hal doctor`.
//
// Zephyr environment check: gather the impure
// environment facts once (west presence + version, Zephyr version, board
// existence), then reduce them to a structured result the doctor (and, later,
// the build/test gates) can present uniformly. The check is side-effect-free
// and never throws — it never installs or mutates anything.
//
// Two checks (mirroring the doctor contract):
//  1. west (the Zephyr build tool) is discoverable + responsive — the direct
//     toolchain presence. discoverWest() already confirms
//     responsiveness via `west --version`; we additionally capture the version
//     string to report it.
//  2. the configured board target exists in the Zephyr checkout
//     ($ZEPHYR_BASE/boards/) — the analog of "the required core is installed".
//
// The existing compat-range check (compat.ts) is folded in as a third check so
// the doctor reports everything through one entry point.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { activeBoardCatalog, lookupBoardTarget, ZEPHYR_INSTALL_CMD, type BoardDataEntry } from '@typecad/cuttlefish/board-catalog';
import { type WestInstall, discoverWest } from './west-discover.js';
import { westSpawn } from './west-spawn.js';
import {
  detectZephyrVersion,
  checkZephyrCompat,
  resolveBoardTarget,
  type CompatStatus,
} from './compat.js';

// ---- probe data (impure facts, injectable for tests) -----------------------

/**
 * Raw west facts gathered from discovery + a `west --version` probe. Mirrors
 * probe data: `westFound` is true when a usable west install was
 * discovered (discovery itself probes responsiveness).
 */
export interface WestProbeData {
  /** A usable west install was discovered. */
  westFound: boolean;
  /** west version string if the `--version` probe parsed one, e.g. "1.3.0". */
  westVersion: string | undefined;
  /** Which discovery strategy found west, for surfacing to the user. */
  source: WestInstall['source'] | undefined;
  /** Effective ZEPHYR_BASE (env var, else a base discovery surfaced). */
  zephyrBase: string | undefined;
}

/**
 * Test-injection seam for checkZephyrEnv. Mirrors the
 * fakeProbe option so tests never spawn a real west/python.
 */
export interface CheckZephyrEnvOptions {
  /** FOR TESTS ONLY: skip the real probe and use this data directly. */
  fakeWestProbe?: WestProbeData;
  /** FOR TESTS ONLY: override the board-existence lookup. */
  fakeBoardExists?: (boardId: string, zephyrBase: string | undefined) => boolean | undefined;
  /**
   * The board catalog to check the target against (defaults to the active
   * catalog). When it has entries it is authoritative — it knows every
   * qualified board/soc target and can suggest a close one; the boards/
   * directory scan is the fallback when there is no catalog.
   */
  boardCatalog?: Readonly<Record<string, BoardDataEntry>>;
}

// ---- result types ------------------------------------------------------------

export interface ZephyrEnvCheck {
  /** west (the Zephyr build tool) was discovered and responsive. */
  westFound: boolean;
  /** west version string if known, e.g. "1.3.0". */
  westVersion: string | undefined;
  /** Discovery strategy that found west, for display. */
  westSource: WestInstall['source'] | undefined;
  /** Effective ZEPHYR_BASE (env var, else a discovered base). */
  zephyrBase: string | undefined;
  /** Detected Zephyr RTOS version from $ZEPHYR_BASE/VERSION, if readable. */
  zephyrVersion: string | undefined;
  /** Declared supported range (manifest.compat.zephyr), if any. */
  compatRange: string | undefined;
  /** Result of the compat-range check against the detected version. */
  compatStatus: CompatStatus;
  /** Raw board target from typecad-hal.config.ts, if configured. */
  buildTarget: string | undefined;
  /** buildTarget normalized for the installed Zephyr version (may equal it). */
  resolvedBoardTarget: string | undefined;
  /** Does the resolved board exist in the checkout? undefined = undetermined. */
  boardTargetSupported: boolean | undefined;
  /** Closest known target when the board wasn't found (catalog lookups only). */
  boardSuggestion?: string;
  /** The catalog entry for the board, when the catalog knew it. */
  boardEntry?: BoardDataEntry;
}

export type ZephyrEnvOk = { ok: true; check: ZephyrEnvCheck };

export type ZephyrEnvFailure = {
  ok: false;
  reason: 'west-not-found' | 'zephyr-not-found' | 'zephyr-out-of-range' | 'board-not-supported';
  check: ZephyrEnvCheck;
  /** Human-readable lines ready to print. */
  messages: string[];
  /** Exact remediation hint, when applicable. */
  fixCommand: string | undefined;
};

export type ZephyrEnvResult = ZephyrEnvOk | ZephyrEnvFailure;

// ---- west probe (impure; isolated + cached + overridable) ------------------

let cachedProbe: WestProbeData | undefined;

/**
 * Gather west facts: discover a usable install, then run `west --version`
 * through it to capture the version. Memoized for the process lifetime (west
 * installs don't move). Never throws — returns westFound:false on any failure.
 */
export function probeWestEnv(): WestProbeData {
  if (cachedProbe) return cachedProbe;

  const install = discoverWest();
  const envBase = process.env.ZEPHYR_BASE || undefined;
  if (!install) {
    const data: WestProbeData = {
      westFound: false,
      westVersion: undefined,
      source: undefined,
      zephyrBase: envBase,
    };
    cachedProbe = data;
    return data;
  }

  // Run `west --version` through the discovered install to capture the version.
  // discoverWest() already confirmed responsiveness, so a parse failure here is
  // not "unresponsive" — it just means we couldn't read a version token.
  let westVersion: string | undefined;
  try {
    const inv = westSpawn(['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    const r = spawnSync(inv.command, inv.args, inv.options);
    if (r.status === 0) {
      // inv.options is a generic SpawnSyncOptions (no encoding literal), so
      // coerce stdout to a string before matching.
      const out = typeof r.stdout === 'string' ? r.stdout : '';
      const m = out.match(/v?(\d+\.\d+\.\d+)/);
      westVersion = m ? m[1] : undefined;
    }
  } catch {
    // westSpawn throws only when discovery fails — but discovery already
    // succeeded (install is non-null). Defensive: treat as no version read.
    westVersion = undefined;
  }

  const data: WestProbeData = {
    westFound: true,
    westVersion,
    source: install.source,
    zephyrBase: envBase ?? install.zephyrBase,
  };
  cachedProbe = data;
  return data;
}

// ---- board existence (pure-ish fs probe) -----------------------------------

/**
 * Does `boardId` exist as a board directory in the Zephyr checkout? Checks the
 * HWMv2 vendor layout used by Zephyr 4.x: $ZEPHYR_BASE/boards/<vendor>/<boardId>.
 * Returns true/false when determinable; undefined when the base is unknown or
 * the boards/ tree can't be read (so callers never fail on an inconclusive
 * lookup — they just skip the board check).
 */
export function boardExistsInCheckout(
  boardId: string,
  zephyrBase: string | undefined,
): boolean | undefined {
  if (!zephyrBase) return undefined;
  const boards = join(zephyrBase, 'boards');
  try {
    const entries = readdirSync(boards, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && existsSync(join(boards, entry.name, boardId))) {
        return true;
      }
    }
    return false;
  } catch {
    return undefined;
  }
}

// ---- main entry point -------------------------------------------------------

/**
 * Verify the environment can build for `buildTarget`. Cheap and
 * side-effect-free: discovers west, reads the Zephyr version, checks the compat
 * range, and — when a target is configured — verifies the board exists in the
 * checkout. Reports what (if anything) is wrong.
 *
 * - If `buildTarget` is undefined/empty, the board check is skipped (not a
 *   failure), mirroring the no-build-target path.
 * - Never installs anything. Never mutates the user environment.
 * - Never throws — always returns a result. Callers decide how to react.
 *
 * `options` is for-test only (injects fake probe data / board lookup).
 */
export function checkZephyrEnv(
  buildTarget?: string,
  options?: CheckZephyrEnvOptions,
): ZephyrEnvResult {
  const probe = options?.fakeWestProbe ?? probeWestEnv();

  const zephyrVersion = detectZephyrVersion();
  const compat = checkZephyrCompat(zephyrVersion);
  const resolvedBoardTarget = buildTarget ? resolveBoardTarget(buildTarget, zephyrVersion) : undefined;
  // The board directory is named without a revision: nrf9160dk@0.14.0 lives
  // in boards/<vendor>/nrf9160dk/.
  const boardId = resolvedBoardTarget ? resolvedBoardTarget.split('/')[0]!.split('@')[0]! : undefined;

  let boardTargetSupported: boolean | undefined;
  let boardSuggestion: string | undefined;
  let boardEntry: BoardDataEntry | undefined;
  if (resolvedBoardTarget !== undefined && boardId !== undefined) {
    if (options?.fakeBoardExists) {
      boardTargetSupported = options.fakeBoardExists(boardId, probe.zephyrBase);
    } else {
      let catalog: Readonly<Record<string, BoardDataEntry>> = {};
      try { catalog = options?.boardCatalog ?? activeBoardCatalog(); } catch { /* no catalog */ }
      const verdict = lookupBoardTarget(catalog, resolvedBoardTarget);
      if (verdict) {
        boardTargetSupported = verdict.found;
        if (verdict.found) boardEntry = verdict.entry;
        else boardSuggestion = verdict.suggestion;
      } else {
        boardTargetSupported = boardExistsInCheckout(boardId, probe.zephyrBase);
      }
    }
  }

  const check: ZephyrEnvCheck = {
    westFound: probe.westFound,
    westVersion: probe.westVersion,
    westSource: probe.source,
    zephyrBase: probe.zephyrBase,
    zephyrVersion,
    compatRange: compat.range,
    compatStatus: compat.status,
    buildTarget,
    resolvedBoardTarget,
    boardTargetSupported,
    ...(boardSuggestion ? { boardSuggestion } : {}),
    ...(boardEntry ? { boardEntry } : {}),
  };

  // 1. west (the build tool) missing entirely — nothing else can run.
  if (!probe.westFound) {
    return {
      ok: false,
      reason: 'west-not-found',
      check,
      messages: [
        "west (the Zephyr build tool) was not found. Install the pinned Zephyr setup",
        "(it includes west), or activate an existing Zephyr environment in this shell.",
      ],
      fixCommand: ZEPHYR_INSTALL_CMD,
    };
  }

  // 2. No readable Zephyr tree — nothing can build. (Not a soft skip: a
  // project with no tree cannot compile, so "Environment OK" would be false.)
  if (compat.status === 'undetectable') {
    const envBase = process.env.ZEPHYR_BASE;
    return {
      ok: false,
      reason: 'zephyr-not-found',
      check,
      messages: [
        envBase
          ? `ZEPHYR_BASE is set to ${envBase}, but that folder isn't a Zephyr tree (no VERSION file). ` +
            `Point ZEPHYR_BASE at your zephyr/ folder, or unset it to use the installed one.`
          : 'No Zephyr tree was found. Install the pinned Zephyr setup, or set ZEPHYR_BASE to your zephyr/ folder.',
      ],
      fixCommand: envBase ? undefined : ZEPHYR_INSTALL_CMD,
    };
  }

  // 3. west healthy but the Zephyr RTOS is outside the supported range.
  if (compat.status === 'out-of-range') {
    return {
      ok: false,
      reason: 'zephyr-out-of-range',
      check,
      messages: [
        `Zephyr ${zephyrVersion} is outside the supported range (${compat.range}) for @typecad/framework-zephyr. ` +
          'Re-pin your tree with the installer, or set ZEPHYR_BASE to a compatible Zephyr checkout.',
      ],
      fixCommand: ZEPHYR_INSTALL_CMD,
    };
  }

  // 4. Tree OK — only check the board when a target is configured and the
  // lookup was able to answer. A missing/absent target is not a board
  // problem; an inconclusive lookup (no base) is reported as a skip, not a fail.
  if (buildTarget && boardTargetSupported === false) {
    return {
      ok: false,
      reason: 'board-not-supported',
      check,
      messages: [
        `Board '${resolvedBoardTarget}' isn't in your Zephyr tree` +
          (probe.zephyrBase ? ` (${join(probe.zephyrBase, 'boards')})` : '') + '.' +
          (boardSuggestion ? ` Did you mean '${boardSuggestion}'?` : '') +
          " Fix the board: value in typecad-hal.config.ts.",
      ],
      fixCommand: undefined,
    };
  }

  return { ok: true, check };
}
