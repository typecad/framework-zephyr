// ---------------------------------------------------------------------------
// HAL lowering dispatcher
//
// Routes a HALOpIR to the per-category lowering module by category prefix
// (e.g. 'gpio.write' → lowerGpio). Returns undefined for categories the
// framework does not lower (display/mdns/ota/rmt/
// capacitive/temp/espnow/crypto/i2s/twai/usb/eth/pcnt/mcpwm — see
// the manifest), so the transpiler falls back and the manifest validator
// cross-checks the unsupported categories. (board.* is registered below but is
// a dead-letter — its values are constant-folded at IR-build time.)
//
// Prefix dispatch (matching framework-esp32's lowerHalOp) keeps this resilient:
// a new op added to a category's lowering fn is picked up here automatically,
// without also editing a 40-case switch. The per-fn default arm still throws a
// clear "unsupported op" error for ops that fall within a category prefix but
// aren't handled, so coverage stays honest.
// ---------------------------------------------------------------------------

import type { HALOpIR } from '@typecad/cuttlefish/api/shared';
import { getActiveChip } from '../chips/index.js';
import { lowerGpio } from './gpio.js';
import { lowerTiming } from './timing.js';
import { lowerAdc } from './adc.js';
import { lowerPwm } from './pwm.js';
import { lowerI2c } from './i2c.js';
import { lowerSpi } from './spi.js';
import { lowerUart } from './uart.js';
import { lowerUsb } from './usb.js';
import { lowerInterrupt } from './interrupts.js';
import { lowerWdt } from './wdt.js';
import { lowerBle } from './ble.js';
import { lowerWifi } from './wifi.js';
import { lowerHttp } from './http.js';
import { lowerMqtt } from './mqtt.js';
import { lowerPreferences } from './preferences.js';
import { lowerBoard } from './board.js';
import { lowerRandom } from './random.js';
import { lowerDac } from './dac.js';
import { lowerFs } from './fs.js';
import { lowerSensor } from './sensor.js';
import { lowerHwtimer, lowerCounter } from './hwtimer.js';
import { lowerThread } from './thread.js';
import { lowerTrace } from './trace.js';
import { lowerStrip } from './strip.js';
import { lowerHid } from './hid.js';
import { lowerMatrix } from './matrix.js';
import { lowerPower } from './power.js';
import { lowerClock } from './clock.js';
import { lowerCan } from './can.js';
import { lowerI2s } from './i2s.js';

export {
  lowerGpio, lowerTiming, lowerAdc, lowerPwm, lowerI2c, lowerSpi, lowerUart,
  lowerUsb, lowerInterrupt, lowerWdt, lowerBle,
  lowerWifi, lowerHttp, lowerMqtt, lowerPreferences, lowerBoard, lowerRandom,
  lowerDac, lowerFs, lowerHwtimer, lowerCounter, lowerSensor, lowerThread, lowerTrace,
  lowerStrip, lowerHid, lowerMatrix, lowerPower, lowerClock, lowerCan, lowerI2s,
};

/**
 * Lower a HAL op to Zephyr C++. Returns undefined for unsupported categories
 * (mirrors lowerHalOp in framework-esp32/src/lowering/index.ts).
 */
export function lowerHalOp(
  op: HALOpIR,
): { code?: string; expression?: string; markers?: readonly string[] } | undefined {
  const resolved = lowerHalOpInner(op);
  if (resolved === undefined) return undefined;
  const markers = OP_SHIM_MARKERS[op.operation] ?? OP_SHIM_MARKERS[prefixOf(op.operation)];
  if (markers === undefined) return resolved;
  return { ...resolved, markers };
}

function prefixOf(operation: string): string {
  const dot = operation.indexOf('.');
  return dot === -1 ? operation : `${operation.slice(0, dot + 1)}`;
}

/**
 * The shim/usage markers each op CATEGORY rides — declared at the ONE
 * dispatch point that lowers them (single definition site). The engine
 * records these at resolution time (routeHALOp → CompilationContext.
 * shimMarkers) and stamps usage-markers.json beside the emitted sources;
 * the toolchain's overlay usage scan unions them over its text scan, so a
 * capability never depends on its marker surviving verbatim in emitted text
 * (helper tokens baked into a string payload, stripped or renamed code).
 * Keys are category prefixes ('preferences.'); values are the exact tokens
 * scanOverlayUsage greps for. Keep in sync with that scan's token families.
 */
const OP_SHIM_MARKERS: Readonly<Record<string, readonly string[]>> = {
  'preferences.': ['__tc_prefs'],
  'fs.': ['__tc_fs'],
  'uart.': ['__tc_uart'],
  'usb.': ['__tc_usb0'],
  'can.': ['__tc_can'],
  'clock.': ['__tc_rtc'],
  'hid.': ['__tc_hid_'],
  'matrix.': ['__tc_matrix'],
  'hwtimer.': ['counter_', '__tc_hw'],
  'counter.': ['counter_', '__tc_hw'],
  'wdt.': ['wdt_'],
  'dac.': ['__tc_dac'],
  'strip.': ['led_strip'],
  'i2c.': ['__tc_i2c'],
  'spi.': ['__tc_spi'],
  'adc.': ['adc_'],
  'pwm.': ['pwm_'],
  'i2s.': ['i2s_'],
};

function lowerHalOpInner(
  op: HALOpIR,
): { code?: string; expression?: string } | undefined {
  const chip = getActiveChip();

  if (op.operation.startsWith('gpio.'))       return lowerGpio(op, chip);
  if (op.operation.startsWith('timing.'))     return lowerTiming(op);
  if (op.operation.startsWith('adc.'))        return lowerAdc(op, chip);
  if (op.operation.startsWith('pwm.'))        return lowerPwm(op, chip);
  if (op.operation.startsWith('dac.'))        return lowerDac(op, chip);
  if (op.operation.startsWith('i2c.'))        return lowerI2c(op, chip);
  if (op.operation.startsWith('spi.'))        return lowerSpi(op, chip);
  if (op.operation.startsWith('uart.'))       return lowerUart(op);
  if (op.operation.startsWith('usb.'))        return lowerUsb(op, chip);
  if (op.operation.startsWith('interrupt.'))  return lowerInterrupt(op, chip);
  if (op.operation.startsWith('wdt.'))        return lowerWdt(op, chip);
  if (op.operation.startsWith('hwtimer.'))    return lowerHwtimer(op, chip);
  if (op.operation.startsWith('counter.'))    return lowerCounter(op, chip);
  // (legacy pulse/shift bit-bang module removed)
  if (op.operation.startsWith('ble.'))        return lowerBle(op);
  if (op.operation.startsWith('wifi.'))       return lowerWifi(op);
  if (op.operation.startsWith('http.'))       return lowerHttp(op);
  if (op.operation.startsWith('mqtt.'))       return lowerMqtt(op);
  if (op.operation.startsWith('preferences.')) return lowerPreferences(op);
  if (op.operation.startsWith('fs.'))         return lowerFs(op);
  // board.resolve is constant-folded at IR-build time; lowerBoard is the
  // dead-letter reached only on an unresolvable path.
  if (op.operation.startsWith('board.')) return lowerBoard(op);
  if (op.operation.startsWith('random.')) return lowerRandom(op);
  if (op.operation.startsWith('sensor.')) return lowerSensor(op);
  if (op.operation.startsWith('thread.'))   return lowerThread(op);
  if (op.operation.startsWith('trace.'))    return lowerTrace(op);
  if (op.operation.startsWith('strip.'))    return lowerStrip(op, chip);
  if (op.operation.startsWith('hid.'))      return lowerHid(op, chip);
  if (op.operation.startsWith('matrix.'))   return lowerMatrix(op);
  if (op.operation.startsWith('power.'))    return lowerPower(op, chip);
  if (op.operation.startsWith('clock.'))    return lowerClock(op);
  if (op.operation.startsWith('can.'))      return lowerCan(op, chip);
  if (op.operation.startsWith('i2s.'))      return lowerI2s(op, chip);

  // raw / snprintf.emit / display.* / ... — not lowered by this
  // framework. Return undefined so the transpiler falls back and the manifest
  // validator confirms the unsupported declaration.
  return undefined;
}
