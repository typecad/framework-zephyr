// ---------------------------------------------------------------------------
// The Zephyr op → C++ return-type table — one merge point over the per-
// lowering tables. Each lowering declares its ops' types BESIDE the switch
// cases that emit them (the single definition site); the strategy serves
// this merged table to the engine through the PlatformHALStrategy
// halOpCppType seam, and the engine's specifier ladders pick printf formats
// from it. Adding a value-returning op? Add its case AND its table entry in
// the same file — the colocation test
// (tests/packages/cuttlefish/hal-op-cpp-type.test.ts) fails when an entry
// has no lowering case or the engine fallback disagrees.
// ---------------------------------------------------------------------------

import { OP_CPP_RETURN_TYPES as WIFI } from './wifi.js';
import { OP_CPP_RETURN_TYPES as HTTP } from './http.js';
import { OP_CPP_RETURN_TYPES as SENSOR } from './sensor.js';
import { OP_CPP_RETURN_TYPES as TIMING } from './timing.js';
import { OP_CPP_RETURN_TYPES as CLOCK } from './clock.js';
import { OP_CPP_RETURN_TYPES as PREFERENCES } from './preferences.js';

export const ZEPHYR_OP_CPP_RETURN_TYPES: Readonly<Record<string, string>> = {
  ...WIFI,
  ...HTTP,
  ...SENSOR,
  ...TIMING,
  ...CLOCK,
  ...PREFERENCES,
};
