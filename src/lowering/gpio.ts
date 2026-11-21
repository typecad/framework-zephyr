// ---------------------------------------------------------------------------
// GPIO lowering — devicetree-spec bridge
//
// Translates HAL gpio.* ops to Zephyr driver C++. Two addressing modes:
//
//  1. Devicetree spec (preferred): if the HAL pin matches a dtSpec in the
//     active chip descriptor, emit gpio_pin_*_dt() calls against a
//     `__tc_dt_<alias>` gpio_dt_spec. This honors the node's polarity flags
//     (GPIO_ACTIVE_LOW), so logical value 1 = LED on for an active-low LED.
//
//  2. Raw fallback: pins without a dtSpec are addressed via the SoC's gpio
//     controller node (DEVICE_DT_GET(DT_NODELABEL(gpio0))) and the
//     gpio_pin_*_raw() API. Polarity is physical (raw bypasses DT flags).
//     The manifest validator's probe (which sends {operation, pin:0} with no
//     port) hits this path, so it must return a lowered result, not undefined.
// ---------------------------------------------------------------------------

import type { HALOpIR } from '@typecad/cuttlefish/api/shared';
import type { ZephyrChipDescriptor } from '../chips/types.js';
import { controllerNodelabelForPin, controllerRawPinForPin } from '../chips/controllers.js';
import { ZEPHYR_GPIO_FLAGS } from '@typecad/hal';

/** The C identifier emitted for a pin's gpio_dt_spec variable. */
export function dtSpecVarName(dtSpec: string): string {
  return `__tc_dt_${dtSpec}`;
}

/** Look up a dtSpec by GPIO pin number; undefined if the pin has none. */
function findDtSpec(chip: ZephyrChipDescriptor, pin: number) {
  return chip.gpio.dtSpecs.find((s) => s.pin === pin);
}

// ── Thin GPIO (hal/gpio-pin.ts) — flag tokens ─────────────────────────────
//
// "GPIO.OUTPUT | GPIO.PULL_UP" token text maps name-for-name onto the GPIO_*
// macros. The name set comes from the GENERATED Zephyr token table (parsed
// from the pinned tree's headers); unknown tokens are build errors listing
// the valid spellings — the sensor-catalog discipline.

const GPIO_FLAG_TOKENS: Record<string, string> = Object.fromEntries(
  ZEPHYR_GPIO_FLAGS.map((f) => [`GPIO.${f}`, `GPIO_${f}`]),
);

/**
 * The init level an OUTPUT_INIT_* construction flag asked for — but ONLY
 * when the strip path will actually drop it (a driven output gaining its
 * input buffer). The callers emit an explicit set at that level right after
 * the guarded configure, which restores the flag's contract (construction
 * leaves the pad AT the init level) despite the ESP32 INIT_*+INPUT driver
 * limitation. Undefined when no strip applies (no INIT token, an explicit
 * INPUT in the flags, or a non-output configure) — the caller adds nothing.
 */
export function gpioInitLevelAfterStrip(flags: string): 0 | 1 | undefined {
  const tokens = String(flags ?? '')
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
  const drivesOutput = tokens.some((t) => t.startsWith('GPIO.OUTPUT'));
  if (!drivesOutput || tokens.includes('GPIO.INPUT')) return undefined;
  let level: 0 | 1 | undefined = undefined;
  for (const t of tokens) {
    if (t === 'GPIO.OUTPUT_INIT_LOW') level = 0;
    else if (t === 'GPIO.OUTPUT_INIT_HIGH') level = 1;
  }
  return level;
}

/** Map thin-GPIO flag token text to the GPIO_* macro expression. */
export function gpioFlagsToMacros(flags: string): string {
  const tokens = String(flags ?? '')
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);
  // An output pin also gets its input buffer enabled. On silicon that gates
  // the IN register by input-enable (ESP32 family) a read of an output-only
  // pad is always 0 — `get()` after `set(true)` returned false on hardware
  // and shiftIn read zeros. Enabling input on every driven pad is benign on
  // every family and makes output read-back uniform.
  const drivesOutput = tokens.some((t) => t.startsWith('GPIO.OUTPUT'));
  if (drivesOutput && !tokens.includes('GPIO.INPUT')) {
    // The Zephyr ESP32 driver's OUTPUT_INIT_* + GPIO_INPUT combination leaves
    // the pad's IN register stuck at 0 (verified on esp32s3: identical code
    // reads back once INIT_LOW is dropped). The init level only matters
    // before the first set() — express it with an explicit set() instead.
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].startsWith('GPIO.OUTPUT_INIT_')) tokens.splice(i, 1);
    }
    tokens.push('GPIO.INPUT');
  }
  if (tokens.length === 0) return 'GPIO_INPUT';
  const macros = tokens.map((t) => {
    const m = GPIO_FLAG_TOKENS[t];
    if (!m) {
      throw new Error(
        `GPIO flag '${t}' is not a known GPIO.* token — valid: ${Object.keys(GPIO_FLAG_TOKENS).join(', ')}.`,
      );
    }
    return m;
  });
  return macros.join(' | ');
}

/** Guarded per-pin configure statement for the dt-spec path: construction
 *  flags apply exactly once per PAD (the shared __tc_gpio_cfg_once latch —
 *  one program-wide instance; see dtSpecGuardConfigure), ahead of the first
 *  use. */
function dtSpecConfigure(varName: string, pin: number, flags: string): string {
  return `{ ${dtSpecGuardConfigure(varName, pin, flags)} }`;
}

/** The guard body only (no wrapping braces) — for fusing into
 *  statement-expressions. The latch is per PAD (the op's global pin number),
 *  NOT per emission site: a block-local static re-fires at every site (each
 *  emission is its own scope), and with the init set riding the guard that
 *  re-drove the init level before EVERY set()/toggle() — a toggle after
 *  set(true) always left the pad at NOT-init (the tour's "toggle() flips the
 *  level" red, esp32s3 COM9). With the latch the init set fires once per pad
 *  — at whichever op runs first — and every later op goes straight to its
 *  verb. Reads need no drive-less special case: if a read is the pad's first
 *  use it configures and reads the init level (construction leaves the pad
 *  AT it — the flag's contract); after any other op the latch is spent and
 *  the read is pure.
 *
 *  Each site carries a block-scoped DECLARATION of the helper: class
 *  methods with HAL ops inline into module HEADERS, and the entry TU
 *  includes those headers BEFORE its shim block (where the inline
 *  definition lives) — a bare call there is "not declared in this scope"
 *  (the strict gate caught it on zephyr-bitbang's dht.h). The declaration
 *  makes every site self-contained regardless of include order; the call
 *  links to the ONE program-wide definition (inline → ODR) the shim emits. */
function dtSpecGuardConfigure(varName: string, pin: number, flags: string): string {
  const initLevel = gpioInitLevelAfterStrip(flags);
  const initSet = initLevel !== undefined ? ` gpio_pin_set_dt(&${varName}, ${initLevel});` : '';
  return `{ bool __tc_gpio_cfg_once(int32_t); if (__tc_gpio_cfg_once(${pin})) { gpio_pin_configure_dt(&${varName}, ${gpioFlagsToMacros(flags)});${initSet} } }`;
}

/** Guarded per-pin configure statement for the raw-controller path. */
function rawConfigure(controller: string, rawPin: number, pin: number, flags: string): string {
  return `{ ${rawGuardConfigure(controller, rawPin, pin, flags)} }`;
}

/** The raw-path guard body only — for fusing into statement-expressions
 *  (see dtSpecGuardConfigure for the per-pad latch contract + the per-site
 *  declaration rationale). */
function rawGuardConfigure(controller: string, rawPin: number, pin: number, flags: string): string {
  const initLevel = gpioInitLevelAfterStrip(flags);
  const initSet = initLevel !== undefined ? ` gpio_pin_set_raw(${controller}, ${rawPin}, ${initLevel});` : '';
  return `{ bool __tc_gpio_cfg_once(int32_t); if (__tc_gpio_cfg_once(${pin})) { gpio_pin_configure(${controller}, ${rawPin}, ${gpioFlagsToMacros(flags)});${initSet} } }`;
}

/**
 * Resolve a HAL gpio.* op to Zephyr C++.
 * Returns `{ code }` for statement ops, `{ expression }` for value-returning ops.
 */
export function lowerGpio(
  op: HALOpIR,
  chip: ZephyrChipDescriptor,
): { code?: string; expression?: string } {
  const o = op as any;
  const pin: number = o.pin;
  const spec = findDtSpec(chip, pin);

  if (spec) {
    return lowerGpioDtSpec(op, spec.dtSpec);
  }
  return lowerGpioRaw(op, chip);
}

/** Devicetree-spec path — polarity-correct via gpio_pin_*_dt(). */
function lowerGpioDtSpec(
  op: HALOpIR,
  dtSpec: string,
): { code?: string; expression?: string } {
  const o = op as any;
  const varName = dtSpecVarName(dtSpec);

  switch (op.operation) {
    case 'gpio.configure':
      // Thin GPIO: construction flags, applied once per pad (latch).
      return { code: dtSpecConfigure(varName, o.pin, o.flags) };
    case 'gpio.read_cfg':
      // Thin GPIO get(): the guarded configure FUSED into the read — one
      // statement-expression, correct in any expression position (a method's
      // leading side-effect ops are dropped when the call sits in a pure
      // expression, e.g. an if-condition). The latch inside fires once per
      // pad; the read itself never drives.
      return {
        expression: `({ ${dtSpecGuardConfigure(varName, o.pin, o.flags)} gpio_pin_get_dt(&${varName}); })`,
      };
    case 'gpio.write': {
      // Literal 0/1 stays as-is; runtime expression coerced to int via ternary.
      const v = o.value;
      const rhs = typeof v === 'string' ? `((${v}) ? 1 : 0)` : v ? 1 : 0;
      return { code: `gpio_pin_set_dt(&${varName}, ${rhs});` };
    }
    case 'gpio.read':
      return { expression: `gpio_pin_get_dt(&${varName})` };
    case 'gpio.toggle':
      return { code: `gpio_pin_toggle_dt(&${varName});` };
    default:
      throw new Error(
        `framework-zephyr does not yet support HAL op \`${op.operation}\`. ` +
          `Open an issue or use rawCpp() to emit it manually.`,
      );
  }
}

/**
 * Raw-controller path — for pins without a DT spec (and the manifest probe).
 * Uses the SoC's primary GPIO controller node. Polarity is physical.
 */
function lowerGpioRaw(
  op: HALOpIR,
  chip: ZephyrChipDescriptor,
): { code?: string; expression?: string } {
  const o = op as any;
  const pin: number = o.pin;
  // Resolve the owning controller by pin range (ESP32-S3 splits GPIO across
  // gpio0/gpio1; STM32 across gpioa/gpiob/gpioc). For single-controller SoCs
  // this is just chip.gpioController. The raw API takes the PORT-RELATIVE
  // index (STM32 gpiob is 0-15), not the global HAL pin number.
  const controller = `DEVICE_DT_GET(DT_NODELABEL(${controllerNodelabelForPin(chip, pin)}))`;
  const rawPin = controllerRawPinForPin(chip, pin);

  switch (op.operation) {
    case 'gpio.configure':
      // Thin GPIO: construction flags, applied once per pad (latch).
      return { code: rawConfigure(controller, rawPin, o.pin, o.flags) };
    case 'gpio.read_cfg':
      // Fused guarded configure + raw read (see the dt-spec path above).
      // The latch fires once per pad; the read itself never drives.
      return {
        expression: `({ ${rawGuardConfigure(controller, rawPin, o.pin, o.flags)} gpio_pin_get_raw(${controller}, ${rawPin}); })`,
      };
    case 'gpio.shift_out':
    case 'gpio.shift_in': {
      // Bit-bang over the raw-controller path (shift pairs are arbitrary
      // pins): configure both once (guarded), then clock the bits. Zephyr
      // verbs only — gpio_pin_set_raw / gpio_pin_get_raw / k_busy_wait.
      const dataCtrl = `DEVICE_DT_GET(DT_NODELABEL(${controllerNodelabelForPin(chip, o.dataPin)}))`;
      const dataRaw = controllerRawPinForPin(chip, o.dataPin);
      const clkCtrl = `DEVICE_DT_GET(DT_NODELABEL(${controllerNodelabelForPin(chip, o.clockPin)}))`;
      const clkRaw = controllerRawPinForPin(chip, o.clockPin);
      // The data pin's direction follows the op: shift_out DRIVES it
      // (GPIO_OUTPUT | GPIO_INPUT — the uniform output read-back rule; the
      // shared once-guard then lets a following shift_in sample the driven
      // level, which is the bench loopback), shift_in listens (GPIO_INPUT).
      // The guard name is per-pair by design: the first op on a pair owns
      // the pad configuration.
      const dataFlags = op.operation === 'gpio.shift_out' ? 'GPIO_OUTPUT | GPIO_INPUT' : 'GPIO_INPUT';
      const cfg = `{ static bool __tc_shf${o.dataPin}_${o.clockPin}_done = false; if (!__tc_shf${o.dataPin}_${o.clockPin}_done) { gpio_pin_configure(${dataCtrl}, ${dataRaw}, ${dataFlags}); gpio_pin_configure(${clkCtrl}, ${clkRaw}, GPIO_OUTPUT); __tc_shf${o.dataPin}_${o.clockPin}_done = true; } }`;
      if (op.operation === 'gpio.shift_out') {
        return {
          code: `${cfg} for (int __i = ${(o.msbFirst ?? true) ? '7' : '0'}; ${(o.msbFirst ?? true) ? '__i >= 0' : '__i < 8'}; ${(o.msbFirst ?? true) ? '__i--' : '__i++'}) { gpio_pin_set_raw(${dataCtrl}, ${dataRaw}, ((static_cast<uint8_t>(${o.value})) >> __i) & 1); gpio_pin_set_raw(${clkCtrl}, ${clkRaw}, 1); k_busy_wait(1); gpio_pin_set_raw(${clkCtrl}, ${clkRaw}, 0); }`,
        };
      }
      return {
        expression: `({ ${cfg} uint8_t __b = 0; for (int __i = ${(o.msbFirst ?? true) ? '7' : '0'}; ${(o.msbFirst ?? true) ? '__i >= 0' : '__i < 8'}; ${(o.msbFirst ?? true) ? '__i--' : '__i++'}) { gpio_pin_set_raw(${clkCtrl}, ${clkRaw}, 1); k_busy_wait(1); __b = static_cast<uint8_t>((__b << 1) | (gpio_pin_get_raw(${dataCtrl}, ${dataRaw}) & 1)); gpio_pin_set_raw(${clkCtrl}, ${clkRaw}, 0); } __b; })`,
      };
    }
    case 'gpio.write': {
      const v = o.value;
      const rhs = typeof v === 'string' ? `((${v}) ? 1 : 0)` : v ? 1 : 0;
      return { code: `gpio_pin_set_raw(${controller}, ${rawPin}, ${rhs});` };
    }
    case 'gpio.read':
      return { expression: `gpio_pin_get_raw(${controller}, ${rawPin})` };
    case 'gpio.toggle':
      // Native atomic toggle — never read-modify-write. gpio_pin_get_raw on
      // a direction-only output reads the input latch, which is undefined on
      // SoCs that don't latch it. Zephyr's toggle API has no _raw variant —
      // gpio_pin_toggle is the driver-level atomic toggle, and for pins
      // configured without GPIO_ACTIVE_LOW the logical level equals the
      // physical one, so it matches the get_raw/set_raw used elsewhere.
      return { code: `gpio_pin_toggle(${controller}, ${rawPin});` };
    default:
      throw new Error(
        `framework-zephyr does not yet support HAL op \`${op.operation}\`. ` +
          `Open an issue or use rawCpp() to emit it manually.`,
      );
  }
}
