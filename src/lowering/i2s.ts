// ---------------------------------------------------------------------------
// I2S lowering — Zephyr's i2s API over the harvested controller node
//
// The controller is addressed by its DT nodelabel (chip.i2s, the harvested
// i2s@ node — ESP32 I2S0/1). Each direction lazy-inits on first use (the
// PWM discipline): configure + trigger START once, then every write/read is
// one block. The shim owns the mem slab (2 blocks), the TX packing buffer,
// and the RX receive buffer; blockAt/readAt index the last received block.
// ---------------------------------------------------------------------------

import type { HALOpIR } from '@typecad/cuttlefish/api/shared';
import type { ZephyrChipDescriptor } from '../chips/types.js';
import { getActiveI2sUsage } from '../chips/index.js';

/** The C variable names for an I2S controller's state. */
function prefix(idx: number): string {
  return `__tc_i2s${idx}`;
}

/** Which i2s.* verbs the program actually uses on a controller — the init
 *  block emits only the state those verbs reference (a write-only program
 *  must not carry an unused rx buffer: -Werror fails the build). */
export interface I2sUsage {
  write: boolean;
  read: boolean;
  readAt: boolean;
}

/**
 * Emit the per-controller I2S state: device handle, mem slab, TX/RX block
 * buffers, and the lazy per-direction init helpers. Called from shimLines
 * when the program uses i2s.* on this controller and the chip declares it.
 * The once-flags live HERE (shim scope), not in the lowered call sites — a
 * second write() statement must not reconfigure/re-start a running stream
 * (i2s_configure is legal only before the first trigger).
 */
export function i2sInitLines(chip: ZephyrChipDescriptor, controllerIndex: number, blockBytes: number, usage: I2sUsage): string[] {
  const ctrl = chip.i2s?.controllers[controllerIndex];
  if (!ctrl) return [];
  const p = prefix(controllerIndex);
  // readAt rides the RX engine too (its lowering lazily starts RX like read
  // does) — a readAt-only program still references the whole engine state.
  const needsEngine = usage.write || usage.read || usage.readAt;
  const lines: string[] = [
    '// CUTTLEFISH_I2S_BEGIN',
    `static const struct device* ${p}_dev = DEVICE_DT_GET(DT_NODELABEL(${ctrl.nodeLabel}));`,
  ];
  if (needsEngine) {
    lines.push(
      `K_MEM_SLAB_DEFINE_STATIC(${p}_slab, ${blockBytes}, 2, 4);`,
      `K_MEM_SLAB_DEFINE_STATIC(${p}_rxslab, ${blockBytes}, 2, 4);`,
      `static void ${p}_init(uint32_t hz, uint8_t channels, uint8_t bits, size_t block_bytes) {`,
      '    struct i2s_config cfg = { 0 };',
      '    cfg.word_size = bits;',
      '    cfg.channels = channels;',
      '    cfg.format = I2S_FMT_DATA_FORMAT_I2S;',
      '    cfg.options = 0;',
      '    cfg.frame_clk_freq = hz;',
      `    cfg.mem_slab = &${p}_slab;`,
      '    cfg.block_size = block_bytes;',
      '    cfg.timeout = 200;',
      `    int err = i2s_configure(${p}_dev, I2S_DIR_TX, &cfg);`,
      '    if (err != 0) { printk("typecad-hal i2s: tx configure failed: %d\\n", err); }',
      `    cfg.mem_slab = &${p}_rxslab;`,
      `    err = i2s_configure(${p}_dev, I2S_DIR_RX, &cfg);`,
      '    if (err != 0) { printk("typecad-hal i2s: rx configure failed: %d\\n", err); }',
      '}',
      `static bool ${p}_init_done = false;`,
    );
  }
  if (usage.write) {
    lines.push(
      `static int16_t ${p}_txbuf[${blockBytes / 2}];`,
      `static bool ${p}_tx_started = false;`,
    );
    // The ESP32 I2S driver (i2s_esp32.c) keeps ONE shared state for both
    // directions — I2S_TRIGGER_START is legal only from READY and flips the
    // state to RUNNING, so a second START on the other direction fails -EIO.
    // A controller that both writes AND reads must start ONCE with
    // I2S_DIR_BOTH (queue the TX block, then one atomic trigger).
    if (usage.read || usage.readAt) {
      lines.push(`static bool ${p}_stream_started = false;`);
    }
  }
  if (usage.read || usage.readAt) {
    lines.push(`static int16_t ${p}_rxbuf[${blockBytes / 2}];`);
    lines.push(`static bool ${p}_rx_started = false;`);
  }
  lines.push('// CUTTLEFISH_I2S_END');
  return lines;
}

/**
 * Resolve a HAL i2s.* op to Zephyr C++.
 * Returns `{ code }` for write, `{ expression }` for read/readAt.
 */
export function lowerI2s(
  op: HALOpIR,
  chip: ZephyrChipDescriptor,
): { code?: string; expression?: string } {
  const o = op as any;
  // DAC discipline: no harvested i2s@ node lowers to the honest comment.
  if (!chip.i2s || chip.i2s.controllers.length === 0) {
    return { code: `/* ${op.operation}: this board's chip data declares no I2S controller (no harvested i2s@ node) */` };
  }
  const idx = Math.min(Number(o.instance ?? 0), chip.i2s.controllers.length - 1);
  const p = prefix(idx);
  const hz = Number(o.hz ?? 16000);
  const channels = Number(o.channels ?? 2);
  const bits = Number(o.bits ?? 16);
  const blockFrames = Number(o.blockFrames ?? 64);
  const blockBytes = blockFrames * channels * (bits / 8);

  switch (op.operation) {
    case 'i2s.write': {
      const samples = (o.samples ?? []) as (number | string)[];
      const cap = blockFrames * channels;
      if (samples.length > cap) {
        throw new Error(
          `I2S write: one block carries at most ${cap} samples (${blockFrames} frames × ${channels} channels) — got ${samples.length}.`,
        );
      }
      // Zero-pad to the full block; samples are 16-bit.
      const writes: string[] = [];
      for (let i = 0; i < cap; i++) {
        const v = i < samples.length ? samples[i] : 0;
        writes.push(`${p}_txbuf[${i}] = static_cast<int16_t>(${v});`);
      }
      // LOOPBACK / FULL-DUPLEX DISCIPLINE. The i2s_esp32 driver keeps ONE
      // shared state for both directions: I2S_TRIGGER_START is legal only
      // from READY and flips the state to RUNNING, so starting TX and RX
      // separately can never work — whichever START comes second fails
      // -EIO and its stream never runs (the 22-i2s loopback read all
      // zeros even with the data line jumpered: the 1ms TX block was long
      // gone and the RX START had been rejected). When the program also
      // READS on this controller, the FIRST write queues the block and
      // triggers ONE I2S_DIR_BOTH START — both DMAs begin together, so the
      // first received block IS the first transmitted one. A lone-RX stream
      // (a read() that ran first) is DROPped to READY before the BOTH START.
      // MULTI-WRITE POLICY: the esp32 i2s driver's TX queue holds ~one block
      // — a second write before the first has clocked out returns -EIO
      // (bench-observed in the 22-i2s suite). Retry with a wait of one block
      // duration (the DMA drains exactly that fast) up to four attempts; a
      // still-failing write reports once. No stream-state surgery — a DROP
      // would kill the shared BOTH stream.
      const blockMs = Math.max(1, Math.ceil((blockFrames * 1000) / hz));
      const txWrite = 'int err = -1; for (int wt = 0; wt < 4 && err != 0; wt++) { err = i2s_buf_write(' + p + '_dev, ' + p + '_txbuf, ' + blockBytes + 'U); if (err != 0) { k_msleep(' + blockMs + '); } }';
      const u = getActiveI2sUsage()?.get(idx);
      const alsoReads = !!u && (u.read || u.readAt);
      const txReport = ` if (err != 0) { printk("typecad-hal i2s: write failed: %d\\\\n", err); }`;
      const queueAndStart = alsoReads
        ? `if (!${p}_stream_started) { if (${p}_rx_started) { (void)i2s_trigger(${p}_dev, I2S_DIR_RX, I2S_TRIGGER_DROP); ${p}_rx_started = false; } ${writes.join(' ')} ${txWrite};${txReport} if (err == 0) { int start_err = i2s_trigger(${p}_dev, I2S_DIR_BOTH, I2S_TRIGGER_START); if (start_err != 0) { printk("typecad-hal i2s: both start failed: %d\\\\n", start_err); } else { ${p}_stream_started = true; ${p}_rx_started = true; ${p}_tx_started = true; } } } else { ${writes.join(' ')} ${txWrite};${txReport} }`
        : `${writes.join(' ')} ${txWrite};${txReport} if (err == 0 && !${p}_tx_started) { ${p}_tx_started = true; err = i2s_trigger(${p}_dev, I2S_DIR_TX, I2S_TRIGGER_START); if (err != 0) { printk("typecad-hal i2s: tx start failed: %d\\\\n", err); } }`;
      return {
        code: `{ if (!${p}_init_done) { ${p}_init_done = true; ${p}_init(${hz}U, ${channels}U, ${bits}U, ${blockBytes}U); } ${queueAndStart} }`,
      };
    }
    case 'i2s.read': {
      return {
        expression: `({ if (!${p}_init_done) { ${p}_init_done = true; ${p}_init(${hz}U, ${channels}U, ${bits}U, ${blockBytes}U); } if (!${p}_rx_started) { ${p}_rx_started = true; int err = i2s_trigger(${p}_dev, I2S_DIR_RX, I2S_TRIGGER_START); if (err != 0) { printk("typecad-hal i2s: rx start failed: %d\\n", err); } } size_t got = 0U; int err = i2s_buf_read(${p}_dev, ${p}_rxbuf, &got); if (err != 0) { printk("typecad-hal i2s: read failed: %d\\n", err); } static_cast<double>(${p}_rxbuf[0]); })`,
      };
    }
    case 'i2s.read_at': {
      // Same lazy RX start as read(): readAt indexes the last RECEIVED
      // block, so the stream must be running — and a readAt-only program
      // references (and therefore compiles in) the whole engine state.
      return {
        expression: `({ if (!${p}_init_done) { ${p}_init_done = true; ${p}_init(${hz}U, ${channels}U, ${bits}U, ${blockBytes}U); } if (!${p}_rx_started) { ${p}_rx_started = true; int err = i2s_trigger(${p}_dev, I2S_DIR_RX, I2S_TRIGGER_START); if (err != 0) { printk("typecad-hal i2s: rx start failed: %d\\n", err); } } int32_t at = static_cast<int32_t>(${o.index}); double v = 0.0; if (at >= 0 && static_cast<uint32_t>(at) < (sizeof(${p}_rxbuf) / sizeof(${p}_rxbuf[0]))) { v = static_cast<double>(${p}_rxbuf[at]); } v; })`,
      };
    }
    default:
      throw new Error(
        `framework-zephyr does not yet support HAL op \`${op.operation}\`. ` +
          `Open an issue or use rawCpp() to emit it manually.`,
      );
  }
}
