// ---------------------------------------------------------------------------
// Matrix lowering — gpio-kbd-matrix node + input-event trampoline
//
// The gpio-kbd-matrix driver (Zephyr input subsystem) scans the grid and
// reports each key as ABS_X (column) + ABS_Y (row) + BTN_TOUCH (press).
// The shim decodes the triple and calls the user's lowered callback as
// (row, col, pressed). The overlay generator synthesizes the DT node with
// row-gpios/col-gpios phandle arrays from the construction pad lists —
// the lowering's comment marker carries rows/cols to the toolchain scan
// (the pwm user-facts marker precedent).
// ----------------------------------------------------------------------------

import type { HALOpIR } from '@typecad/cuttlefish/api/shared';

/**
 * Emit the matrix trampoline state. Called from shimLines when the program
 * uses matrix.* — the listener targets the synthesized tc_matrix node, the
 * handler pointer is assigned by the on_key lowering.
 *
 * SINGLETON block: INPUT_CALLBACK_DEFINE registers into the input subsystem's
 * iterable section, so a per-TU copy would register once per translation
 * unit — a multi-file program would fire the callback once per TU per key
 * event, and an op landing in a non-entry TU would assign a handler pointer
 * the registered (entry-TU) callback never reads. The entry TU carries the
 * definitions; every other TU gets an extern of the handler pointer. The
 * two guards keep any header/.cpp splice order within one TU safe (see
 * preferences.ts for the full case analysis).
 */
export function matrixInitLines(): string[] {
  return [
    '// CUTTLEFISH_MATRIX_BEGIN',
    '#if defined(CUTTLEFISH_ENTRY_TU)',
    '#ifndef CUTTLEFISH_MATRIX_SINGLETON_DEFS',
    '#define CUTTLEFISH_MATRIX_SINGLETON_DEFS',
    'void (*__tc_matrix_on_key)(double, double, bool) = NULL;',
    'static int32_t __tc_matrix_row = -1;',
    'static int32_t __tc_matrix_col = -1;',
    'static void __tc_matrix_cb(struct input_event* evt, void* user_data) {',
    '    (void)user_data;',
    '    switch (evt->code) {',
    '    case INPUT_ABS_X:',
    '        __tc_matrix_col = evt->value;',
    '        break;',
    '    case INPUT_ABS_Y:',
    '        __tc_matrix_row = evt->value;',
    '        break;',
    '    case INPUT_BTN_TOUCH:',
    '        if (__tc_matrix_on_key != NULL && __tc_matrix_row >= 0 && __tc_matrix_col >= 0) {',
    '            __tc_matrix_on_key(static_cast<double>(__tc_matrix_row), static_cast<double>(__tc_matrix_col), evt->value != 0);',
    '        }',
    '        break;',
    '    default:',
    '        break;',
    '    }',
    '}',
    'INPUT_CALLBACK_DEFINE(DEVICE_DT_GET(DT_NODELABEL(tc_matrix)), __tc_matrix_cb, NULL);',
    '#endif // CUTTLEFISH_MATRIX_SINGLETON_DEFS',
    '#else // !CUTTLEFISH_ENTRY_TU',
    '#ifndef CUTTLEFISH_MATRIX_SINGLETON_DECLS',
    '#define CUTTLEFISH_MATRIX_SINGLETON_DECLS',
    'extern void (*__tc_matrix_on_key)(double, double, bool);',
    '#endif // CUTTLEFISH_MATRIX_SINGLETON_DECLS',
    '#endif // CUTTLEFISH_ENTRY_TU',
    '// CUTTLEFISH_MATRIX_END',
  ];
}

/**
 * Resolve a HAL matrix.* op to Zephyr C++.
 * Returns `{ code }` for statement ops.
 */
export function lowerMatrix(op: HALOpIR): { code?: string; expression?: string } {
  const o = op as any;

  switch (op.operation) {
    case 'matrix.on_key': {
      // The comment marker carries the construction pad lists to the
      // toolchain's overlay scan (the pwm user-facts precedent).
      return {
        code: `/* cuttlefish-matrix: rows=${o.rows} cols=${o.cols} */ __tc_matrix_on_key = ${o.handler};`,
      };
    }
    default:
      throw new Error(
        `framework-zephyr does not yet support HAL op \`${op.operation}\`. ` +
          `Open an issue or use rawCpp() to emit it manually.`,
      );
  }
}
