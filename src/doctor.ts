// ---------------------------------------------------------------------------
// @typecad/framework-zephyr — Zephyr environment doctor
//
// `typecad-hal doctor` (Zephyr framework) — verify west (the Zephyr build tool)
// is installed + responsive, a Zephyr tree is present and inside the
// framework's declared compat range, the toolchain bundle is there, the
// configured board target exists, and the configured probe is valid with its
// host tool installed. Exits 0 if the environment is OK, 1 otherwise. Rows are
// rendered by cuttlefish's shared doctor report (text or --json).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import * as ui from '@typecad/cuttlefish/utils/ui';
import { loadTypecadConfig } from '@typecad/cuttlefish/config-loader';
import { checkZephyrEnv } from './toolchain/env-check.js';
import { checkZephyrSdk, PINNED_ZEPHYR_MANIFEST_REV, ZEPHYR_INSTALL_CMD } from '@typecad/cuttlefish/board-catalog';
import { resolveChipFromBoard } from './chips/resolve.js';
import { discoverWest, type WestInstall } from './toolchain/west-discover.js';
import { buildEnv } from './toolchain/west-spawn.js';
import { resolveSessionOpenOcd } from './toolchain/index.js';

type ProbeMethod = { id: string; runner?: string; debug?: boolean };

/**
 * Host executables each west flash runner needs. Data, keyed by runner (the
 * one axis toolchain decisions may branch on). Runners absent here are not
 * checked; `null` marks runners that need no separate host tool.
 */
const RUNNER_TOOLS: Record<string, { exe: readonly string[]; winDirs?: readonly string[]; note?: string } | null> = {
  'dfu-util': { exe: ['dfu-util'] },
  jlink: {
    exe: process.platform === 'win32' ? ['JLink'] : ['JLinkExe'],
    winDirs: ['C:\\Program Files\\SEGGER\\JLink', 'C:\\Program Files (x86)\\SEGGER\\JLink'],
  },
  stm32cubeprogrammer: {
    exe: ['STM32_Programmer_CLI'],
    winDirs: ['C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin'],
  },
  nrfjprog: { exe: ['nrfjprog'] },
  nrfutil: { exe: ['nrfutil'] },
  pyocd: { exe: ['pyocd'] },
  bossac: { exe: ['bossac'] },
  stm32flash: { exe: ['stm32flash'] },
  linkserver: { exe: ['LinkServer'] },
  'probe-rs': { exe: ['probe-rs'] },
  blackmagicprobe: null, // drives the toolchain's gdb
  esp32: null, // esptool ships in west's Python environment
  uf2: null, // copies to the board's USB drive
};

/** The PATH west's own child processes see, plus a micromamba env's bin dirs. */
function westSearchDirs(install: WestInstall | null): string[] {
  const env = install ? buildEnv(install) : process.env;
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(delimiter).filter(Boolean);
  if (install?.mode === 'micromamba' && install.mambaRootPrefix) {
    const envDir = join(install.mambaRootPrefix, 'envs', install.envName ?? 'zephyr');
    dirs.push(...(process.platform === 'win32'
      ? [envDir, join(envDir, 'Library', 'bin'), join(envDir, 'Scripts')]
      : [join(envDir, 'bin')]));
  }
  return dirs;
}

function findExecutable(names: readonly string[], dirs: readonly string[]): string | undefined {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = join(dir, name + ext);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/** Probe methods from the persisted board constants of a previous build. */
function probeMethodsFromBuild(projectDir: string, entry: string | undefined, outDir: string | undefined): ProbeMethod[] {
  const appDir = entry ? resolve(projectDir, dirname(entry), outDir ?? '.') : undefined;
  const candidates = [
    ...(appDir ? [join(appDir, 'src', 'board-constants.json'), join(appDir, 'board-constants.json')] : []),
    join(projectDir, 'out', 'src', 'board-constants.json'),
    join(projectDir, 'src', 'out', 'src', 'board-constants.json'),
  ];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | number | boolean>;
    return [...(resolveChipFromBoard(new Map(Object.entries(raw)))?.probeMethods ?? [])] as ProbeMethod[];
  } catch {
    return [];
  }
}

export function runDoctor(options: { json?: boolean } = {}): void {
  const config = loadTypecadConfig(process.cwd());
  const projectDir = config ? dirname(config.configPath) : process.cwd();
  const buildTarget = config?.buildTarget;

  const result = checkZephyrEnv(buildTarget);
  const c = result.check;
  const rows: ui.DoctorRow[] = [];
  const fixes: ui.DoctorFix[] = [];
  const failMessage = result.ok ? undefined : result.messages.join(' ');
  const failFix = (): void => {
    if (!result.ok) fixes.push({ text: failMessage!, ...(result.fixCommand ? { command: result.fixCommand } : {}) });
  };

  // west
  if (c.westFound) {
    rows.push({ label: 'west', value: `${c.westVersion ?? 'found'}${c.westSource ? `  (${c.westSource})` : ''}`, status: 'ok' });
  } else {
    rows.push({ label: 'west', value: 'not found', status: 'fail' });
    failFix();
  }

  // Zephyr tree + version
  const pinned = PINNED_ZEPHYR_MANIFEST_REV.replace(/^v/, '');
  if (c.compatStatus === 'undetectable') {
    rows.push({
      label: 'Zephyr',
      value: c.zephyrBase ? `not a Zephyr tree: ${c.zephyrBase}` : 'not found',
      status: 'fail',
    });
    if (c.westFound) failFix();
  } else if (c.compatStatus === 'out-of-range') {
    rows.push({ label: 'Zephyr', value: `${c.zephyrVersion} @ ${c.zephyrBase}`, status: 'fail', detail: [`supported: ${c.compatRange}`] });
    if (c.westFound) failFix();
  } else {
    const differs = c.zephyrVersion !== pinned;
    rows.push({
      label: 'Zephyr',
      value: `${c.zephyrVersion} @ ${c.zephyrBase}`,
      status: differs ? 'warn' : 'ok',
      ...(differs ? { detail: [`this release is validated against ${pinned} (supported: ${c.compatRange})`] } : {}),
    });
    if (differs) fixes.push({ text: `To use the validated Zephyr ${pinned}, re-pin your tree:`, command: ZEPHYR_INSTALL_CMD });
  }

  // Toolchain bundle (compilers) — only meaningful with a tree.
  if (c.zephyrBase && c.compatStatus !== 'undetectable') {
    const sdk = checkZephyrSdk(c.zephyrBase);
    if ((sdk.status === 'ok' || sdk.status === 'version-mismatch') && sdk.toolchainDir) {
      rows.push({ label: 'Toolchain', value: `SDK ${sdk.toolchainVersion ?? ''} @ ${sdk.toolchainDir}`, status: 'ok' });
    } else if (sdk.status === 'toolchain-mismatch') {
      rows.push({
        label: 'Toolchain',
        value: `SDK ${sdk.toolchainVersion} @ ${sdk.toolchainDir}`,
        status: 'fail',
        detail: [`expected SDK ${sdk.pinnedToolchainVersion} to match Zephyr ${pinned}`],
      });
      fixes.push({ text: 'Re-fetch the matching toolchain:', command: ZEPHYR_INSTALL_CMD });
    } else {
      rows.push({
        label: 'Toolchain',
        value: 'not found',
        status: 'warn',
        detail: ['west builds may still find one, but some flash/debug runners will not'],
      });
      fixes.push({ text: 'Install the Zephyr SDK toolchain:', command: ZEPHYR_INSTALL_CMD });
    }
  }

  // Board target
  if (!config) {
    rows.push({ label: 'Board', value: 'no project here', status: 'info' });
  } else if (!buildTarget) {
    rows.push({ label: 'Board', value: 'none set in typecad-hal.config.ts', status: 'info' });
  } else {
    const resolvedTarget = c.resolvedBoardTarget ?? buildTarget;
    const shown = resolvedTarget === buildTarget ? buildTarget : `${buildTarget} → ${resolvedTarget}`;
    if (c.boardTargetSupported === false) {
      rows.push({
        label: 'Board',
        value: `${shown}  not found`,
        status: 'fail',
        ...(c.boardSuggestion ? { detail: [`did you mean ${c.boardSuggestion}?`] } : {}),
      });
      failFix();
    } else if (c.boardTargetSupported === undefined) {
      rows.push({ label: 'Board', value: shown, status: 'info', detail: ['not checked (no Zephyr tree to look in)'] });
    } else {
      rows.push({ label: 'Board', value: shown, status: 'ok' });
    }
  }

  // Probe — the configured method (zephyr.probe), checked against the board's
  // table (catalog first, else a previous build's board constants), plus the
  // host tool its runner needs.
  if (config && buildTarget && c.boardTargetSupported !== true) {
    // The probe table belongs to the board — without a confirmed board there
    // is nothing to check it against, so say why instead of guessing.
    const configured = typeof config.zephyrConfig?.probe === 'string' ? config.zephyrConfig.probe : undefined;
    if (configured) {
      rows.push({
        label: 'Probe',
        value: configured,
        status: 'info',
        detail: [c.boardTargetSupported === false ? 'not checked until the board is fixed' : 'not checked (the board couldn\'t be verified)'],
      });
    }
  } else if (config && buildTarget) {
    const methods: ProbeMethod[] = c.boardEntry?.probeMethods?.length
      ? [...c.boardEntry.probeMethods]
      : probeMethodsFromBuild(projectDir, config.entry, config.outputOutDir);
    const configured = typeof config.zephyrConfig?.probe === 'string' ? config.zephyrConfig.probe : undefined;
    const method = configured ? methods.find((m) => m.id === configured) : undefined;

    if (!configured) {
      rows.push({ label: 'Probe', value: 'board default (no zephyr.probe set)', status: 'info' });
    } else if (methods.length > 0 && !method) {
      rows.push({ label: 'Probe', value: `${configured}  not a method this board supports`, status: 'fail' });
      fixes.push({ text: `Set zephyr.probe in typecad-hal.config.ts to one of: ${methods.map((m) => m.id).join(', ')}.` });
    } else {
      rows.push({
        label: 'Probe',
        value: `${configured}${method?.runner ? `  (runner: ${method.runner})` : ''}`,
        status: methods.length > 0 ? 'ok' : 'info',
        ...(methods.length === 0 ? { detail: ['not checked (this board lists no probe methods)'] } : {}),
      });
    }

    const runner = method?.runner;
    if (runner) {
      if (runner === 'openocd') {
        const install = discoverWest();
        const ocd = resolveSessionOpenOcd(process.env, install?.sdkInstallDir);
        if (ocd) rows.push({ label: 'openocd', value: ocd.exe, status: 'ok' });
        else {
          rows.push({ label: 'openocd', value: 'not found', status: 'warn', detail: ['uploads with this probe will fail'] });
          fixes.push({ text: 'Install openocd (the Zephyr installer provides it), or set OPENOCD to its path.', command: ZEPHYR_INSTALL_CMD });
        }
      } else if (RUNNER_TOOLS[runner]) {
        const spec = RUNNER_TOOLS[runner]!;
        const dirs = [...westSearchDirs(discoverWest()), ...(process.platform === 'win32' ? spec.winDirs ?? [] : [])];
        const found = findExecutable(spec.exe, dirs);
        if (found) rows.push({ label: spec.exe[0]!, value: found, status: 'ok' });
        else {
          rows.push({ label: spec.exe[0]!, value: 'not found', status: 'warn', detail: ['uploads with this probe will fail'] });
          fixes.push({ text: `Install ${spec.exe[0]} (needed by the '${runner}' runner) and put it on PATH.` });
        }
      }
    }

    if (methods.length > 0) {
      const debuggable = methods.filter((m) => m.debug !== false).map((m) => m.id);
      rows.push({
        label: 'Probe methods',
        value: methods.map((m) => m.id).join(', '),
        status: 'info',
        detail: [`can debug: ${debuggable.join(', ') || 'none (an external probe is required)'}`],
      });
    }
  }

  ui.printDoctorReport({ title: 'Checking Zephyr environment...', rows, fixes }, options);
}
