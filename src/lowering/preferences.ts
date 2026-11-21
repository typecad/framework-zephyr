// ---------------------------------------------------------------------------
// Preferences lowering — Zephyr settings subsystem (ZMS backend)
//
// The HAL Preferences surface is the ESP32-NVS session model: begin(ns) →
// typed put_*/get_* → end(). Zephyr's settings subsystem has no session — it
// is a flat dotted key-space plus a one-time settings_load() at boot that
// fills an in-RAM cache via the h_set callback. We model the session on top:
//
//   begin("app")   → records the active subtree prefix "tc/app/"
//   putInt("k",v)  → writes the cache + settings_save_one("tc/app/k", bytes, 4)
//   getInt("k",d)  → cache lookup, returns d if absent
//   remove("k")    → settings_delete("tc/app/k") + drop cache slot
//   clear()        → settings_delete each known tc/<ns>/* key + clear cache
//   end()          → clears the prefix (NOT the cache — end() is not a wipe on
//                    ESP32 either; it only closes the NVS handle)
//
// begin/end are intentionally lightweight on Zephyr. They stay in the IR so a
// future backend that genuinely needs a session/namespace (NVS, a crypto-
// sealed store) has the hook without lowering every read through setup. On
// Zephyr they only carry the key prefix.
//
// The settings backend is ZMS (Zephyr Memory Storage), selected by
// CONFIG_SETTINGS + CONFIG_ZMS + CONFIG_SETTINGS_ZMS. The backend locates the
// storage partition automatically: the fixed-partition labeled
// `storage_partition`, or whatever /chosen `zephyr,settings-partition` points
// at (see dt-config/overlay.ts). No partition macro is referenced here.
//
// EMIT BOUNDARY: emitted bytes land in user firmware. Covered by the TypeCAD
// Runtime Exception (RUNTIME_EXCEPTION.md at the repo root).
// ---------------------------------------------------------------------------

import type { HALOpIR } from '@typecad/cuttlefish/api/shared';

/** Render a HAL field: pass through (already rendered by the resolver). */
function unq(v: unknown): string {
  return String(v).replace(/^"|"$/g, '');
}

function s(v: unknown): string {
  return String(v);
}

/** Full settings key: one literal when both halves are literals, a runtime
 *  std::string concatenation when either half is an expression. The halves
 *  arrive pre-classified (quoteNonIdentifier: quoted = literal, bare =
 *  C++ expression); baking both into the template wrote a variable key as
 *  its SOURCE TEXT — kv.setFloat(name, v) stored under the literal key
 *  "tc/ns/name", every variable key onto one junk flash slot, masked
 *  in-session by the RAM cache and exposed only across reboot
 *  (demo-terra round 10 F11). */
function fullKey(ns: string, key: string): string {
  const isLiteral = (v: string) => /^"[^"]*"$/.test(v);
  if (isLiteral(ns) && isLiteral(key)) {
    return `"tc/${unq(ns)}/${unq(key)}"`;
  }
  return `("tc/" + std::string(${ns}) + "/" + std::string(${key})).c_str()`;
}

/** Render a bool op field: literal booleans become `true`/`false`, string
 *  values are the C++ text of a runtime expression and pass through
 *  verbatim (truthiness of the non-empty string would emit `true`). */
function boolText(v: boolean | string): string {
  if (typeof v === "string") {
    if (v === "true") return "true";
    if (v === "false") return "false";
    return v;
  }
  return v ? "true" : "false";
}

// Type tags for the cache slot payload. Scoped enum (AUTOSAR: enum class).
// The on-metal order matters: these are stored in the `type` byte and matched
// at h_set time, so do not renumber.
const TAG = {
  INT: 1,
  UINT: 2,
  BOOL: 3,
  FLOAT: 4,
  STRING: 5,
} as const;

/**
 * The preferences runtime shim — a SINGLETON block.
 *
 * The cache and the `SETTINGS_STATIC_HANDLER_DEFINE` registration must exist
 * exactly once per PROGRAM, not once per translation unit: a duplicated
 * handler registers once per TU, so a multi-file program's boot-time
 * settings_load() fills only the TU that won the link-order race while every
 * other TU's cache stays empty forever (reads return defaults; session
 * roundtrips still pass because put/get share one TU). The block therefore
 * compiles its definitions only in the entry TU (CUTTLEFISH_ENTRY_TU) and
 * prototypes everywhere else.
 *
 * The two guards make ANY include order within one TU safe — a module header
 * spliced before or after the TU's own shim both settle:
 *   entry TU, header first  → header takes the prototype branch (no ENTRY_TU
 *                             define in headers), preamble then defines;
 *   entry TU, preamble first→ header re-entry sees DEFS set and no-ops;
 *   plain TU, either order  → the prototype branch fires once.
 *
 * Helpers are `static` inside the entry branch so unused ones don't trip
 * -Wunused-function; the public `__tc_prefs_*` accessors carry external
 * linkage (single definitions in the entry TU) so every TU links against the
 * one live cache. This is the same split the ESP32 Preferences library uses
 * (NVS is the cache, just in flash-backed RAM pages).
 */
export function preferencesInitLines(): string[] {
  return [
    `// CUTTLEFISH_PREFS_BEGIN`,
    `#include <string>`,
    `#include <cstdio>`,
    `#if defined(CUTTLEFISH_ENTRY_TU)`,
    `#ifndef CUTTLEFISH_PREFS_SINGLETON_DEFS`,
    `#define CUTTLEFISH_PREFS_SINGLETON_DEFS`,
    `#define __TC_PREFS_SLOT_COUNT 32`,
    `#define __TC_PREFS_KEY_LEN   48`,
    `#define __TC_PREFS_VAL_LEN   32`,
    `#define __TC_PREFS_STR_LEN   31`,
    ``,
    `// One cache slot. The full settings key (tc/<ns>/<key>) lives in key[] so`,
    `// remove()/clear() can reconstruct the exact name to settings_delete. The`,
    `// value is stored in its native wire form (little-endian for the numeric`,
    `// types) so h_set can memcpy straight from the settings read callback.`,
    `struct __tc_prefs_slot final {`,
    `    char key[__TC_PREFS_KEY_LEN];`,
    `    uint8_t type;`,
    `    uint8_t val[__TC_PREFS_VAL_LEN];`,
    `    uint8_t len;`,
    `    bool used;`,
    `};`,
    ``,
    `static struct {`,
    `    bool loaded;`,
    `    __tc_prefs_slot slots[__TC_PREFS_SLOT_COUNT];`,
    `} __tc_prefs;`,
    ``,
    `// ── settings_load() handler (the only mandatory callback) ───────────────`,
    `// settings_load() calls h_set once per stored key it finds, handing us the`,
    `// value via read_cb. We copy it into a cache slot keyed by the full dotted`,
    `// path. h_get/h_commit are unused (the cache is the post-load source of`,
    `// truth) so they return -ENOENT / 0 to satisfy the handler contract.`,
    `static __tc_prefs_slot* __tc_prefs_slot_for(const char* full);`,
    `static int __tc_prefs_h_set(const char* name, size_t len, settings_read_cb read_cb, void* cb_arg) {`,
    `    (void)len;`,
    `    // h_set hands us the name RELATIVE to the handler's "tc"`,
    `    // subtree ("rig/marker") - the cache keys full names, so re-attach the`,
    `    // prefix and go through slot_for (which EVICTS when the 32 slots are`,
    `    // full - the free-slot-only loop silently dropped loaded keys once the`,
    `    // shared settings partition accumulated more keys than the cache).`,
    `    char full[__TC_PREFS_KEY_LEN];`,
    `    (void)snprintf(full, sizeof(full), "tc/%s", name);`,
    `    __tc_prefs_slot* slot = __tc_prefs_slot_for(full);`,
    `    ssize_t got = read_cb(cb_arg, slot->val, __TC_PREFS_VAL_LEN);`,
    `    if (got <= 0) { return static_cast<int>(got); }`,
    `    slot->len = static_cast<uint8_t>(got);`,
    `    // Type is encoded as the first byte of the stored value (see put_*).`,
    `    slot->type = slot->val[0];`,
    `    (void)snprintf(slot->key, __TC_PREFS_KEY_LEN, "%s", full);`,
    `    slot->used = true;`,
    `    return 0;`,
    `}`,
    `static int __tc_prefs_h_get(const char* full, char* val, int val_len_max) {`,
    `    (void)full; (void)val; (void)val_len_max;`,
    `    return -ENOENT;`,
    `}`,
    `static int __tc_prefs_h_commit(void) { return 0; }`,
    `SETTINGS_STATIC_HANDLER_DEFINE(tc_prefs, "tc", __tc_prefs_h_get, __tc_prefs_h_set,`,
    `                                __tc_prefs_h_commit, NULL);`,
    ``,
    `// One-time subsystem init + load. Idempotent — the HAL may call begin()`,
    `// repeatedly. settings_subsys_init() is itself idempotent in Zephyr, but the`,
    `// loaded flag short-circuits the (relatively expensive) settings_load() walk.`,
    `static void __tc_prefs_ensure_loaded(void) {`,
    `    if (!__tc_prefs.loaded) {`,
    `        // Loud-diagnostics policy: a settings backend that initializes or`,
    `        // loads with an error makes every Store read silently fall to its`,
    `        // default while saves still "succeed" into the RAM cache — the`,
    `        // demo-pumphouse round 5 finding survived to hardware BECAUSE these`,
    `        // were (void)-cast. Surface the codes once at first use.`,
    `        int rc = settings_subsys_init();`,
    `        if (rc != 0) { __tc_println("typecad-hal-store: settings backend init failed"); }`,
    `        rc = settings_load();`,
    `        if (rc != 0) { __tc_println("typecad-hal-store: settings load failed (persistence off this boot)"); }`,
    `        __tc_prefs.loaded = true;`,
    `    }`,
    `}`,
    ``,
    ``,
    `// Slot lookup by full settings name. Returns nullptr when absent (the get_*`,
    `// helpers then fall back to the caller's default value, matching the ESP32`,
    `// getInt(key, default) contract).`,
    `static __tc_prefs_slot* __tc_prefs_find(const char* full) {`,
    `    for (int i = 0; i < __TC_PREFS_SLOT_COUNT; i++) {`,
    `        if (__tc_prefs.slots[i].used &&`,
    `            strncmp(__tc_prefs.slots[i].key, full, __TC_PREFS_KEY_LEN) == 0) {`,
    `            return &__tc_prefs.slots[i];`,
    `        }`,
    `    }`,
    `    return nullptr;`,
    `}`,
    ``,
    `// Allocate (or reuse) a slot for a full name. Free slots first; a FULL`,
    `// cache EVICTS round-robin instead of returning nullptr. The settings`,
    `// partition is shared across every demo ever flashed on the board, so`,
    `// settings_load() refills the cache with accumulated keys - a full-cache`,
    `// nullptr made every put silently no-op its cache mirror and every get`,
    `// miss to the default (doser + gate store.roundtrip [FAIL] on hardware,`,
    `// reproduced on COM9). The shim comment claiming "the in-RAM value is`,
    `// still returned on get" was wrong: a nullptr put caches nothing.`,
    `static uint8_t __tc_prefs_victim = 0;`,
    `static __tc_prefs_slot* __tc_prefs_slot_for(const char* full) {`,
    `    __tc_prefs_slot* existing = __tc_prefs_find(full);`,
    `    if (existing != nullptr) { return existing; }`,
    `    for (int i = 0; i < __TC_PREFS_SLOT_COUNT; i++) {`,
    `        if (!__tc_prefs.slots[i].used) { return &__tc_prefs.slots[i]; }`,
    `    }`,
    `    __tc_prefs_slot* victim = &__tc_prefs.slots[__tc_prefs_victim];`,
    `    __tc_prefs_victim = static_cast<uint8_t>((__tc_prefs_victim + 1U) % __TC_PREFS_SLOT_COUNT);`,
    `    return victim;`,
    `}`,
    ``,
    `// Generic typed put: stamp the type byte, stash the value, persist via`,
    `// settings_save_one, and mirror into the cache. The type byte rides along`,
    `// as val[0] so h_set can recover it on the next boot without a separate`,
    `// name→type map.`,
    `template <typename T>`,
    `static void __tc_prefs_put(const char* full, uint8_t tag, const T& value) {`,
    `    __tc_prefs_ensure_loaded();   // begin() is gone — mount lazily here`,
    `    uint8_t buf[1U + sizeof(T)];`,
    `    buf[0] = tag;`,
    `    (void)memcpy(&buf[1], &value, sizeof(T));`,
    `    (void)settings_save_one(full, buf, sizeof(buf));`,
    `    __tc_prefs_slot* slot = __tc_prefs_slot_for(full);`,
    `    if (slot != nullptr) {`,
    `        (void)snprintf(slot->key, __TC_PREFS_KEY_LEN, "%s", full);`,
    `        slot->type = tag;`,
    `        slot->len = static_cast<uint8_t>(sizeof(buf));`,
    `        (void)memcpy(slot->val, buf, sizeof(buf));`,
    `        slot->used = true;`,
    `    }`,
    `}`,
    ``,
    `template <typename T>`,
    `static T __tc_prefs_get(const char* full, uint8_t tag, T def) {`,
    `    __tc_prefs_ensure_loaded();`,
    `    __tc_prefs_slot* slot = __tc_prefs_find(full);`,
    `    if (slot == nullptr || slot->type != tag || slot->len < (1U + sizeof(T))) {`,
    `        return def;`,
    `    }`,
    `    T out;`,
    `    (void)memcpy(&out, &slot->val[1], sizeof(T));`,
    `    return out;`,
    `}`,
    ``,
    `// ── Lifecycle (session model on top of the flat key-space) ──────────────`,
    `// begin records "tc/<ns>/" as the prefix every subsequent key is built under.`,
    `// end clears the prefix (NOT the cache). Both are cheap on Zephyr: the real`,
    ``,
    `// remove: drop one key from flash and the cache. Returns whether the`,
    `// key EXISTED (the ESP32-Preferences parity contract the DSL tests pin)`,
    `// — an absent key skips the settings_delete call entirely (its -ENOENT`,
    `// would read as a false removal report and churns the flash).`,
    `bool __tc_prefs_remove(const char* full) {`,
    `    __tc_prefs_ensure_loaded();`,
    `    __tc_prefs_slot* slot = __tc_prefs_find(full);`,
    `    if (slot == nullptr || !slot->used) { return false; }`,
    `    (void)settings_delete(full);`,
    `    slot->used = false;`,
    `    return true;`,
    `}`,
    ``,
    `// clear: drop every key under the active namespace. We walk the cache (the`,
    `// authoritative list of keys we have written) and settings_delete each whose`,
    `// full name starts with the active ns prefix, then mark the slot free. Only`,
    `// the active namespace is cleared — keys under other namespaces survive.`,
    `void __tc_prefs_clear(const char* prefix) {`,
    `    __tc_prefs_ensure_loaded();`,
    `    const size_t plen = strlen(prefix);`,
    `    for (int i = 0; i < __TC_PREFS_SLOT_COUNT; i++) {`,
    `        if (__tc_prefs.slots[i].used &&`,
    `            strncmp(__tc_prefs.slots[i].key, prefix, plen) == 0) {`,
    `            (void)settings_delete(__tc_prefs.slots[i].key);`,
    `            __tc_prefs.slots[i].used = false;`,
    `        }`,
    `    }`,
    `}`,
    ``,
    `// ── Typed accessors ─────────────────────────────────────────────────────`,
    `// Each put_* stamps its tag byte and persists; each get_* reads the cache and`,
    `// returns the default on miss/type-mismatch (mirrors ESP32 Preferences).`,
    `// External linkage — the ONE definitions live here in the entry TU; every`,
    `// other TU links against them through the prototypes below.`,
    `void __tc_prefs_put_int(const char* full, int32_t v) {`,
    `    __tc_prefs_put<int32_t>(full, ${TAG.INT}, v);`,
    `}`,
    `int32_t __tc_prefs_get_int(const char* full, int32_t def) {`,
    `    return __tc_prefs_get<int32_t>(full, ${TAG.INT}, def);`,
    `}`,
    `void __tc_prefs_put_uint(const char* full, uint32_t v) {`,
    `    __tc_prefs_put<uint32_t>(full, ${TAG.UINT}, v);`,
    `}`,
    `uint32_t __tc_prefs_get_uint(const char* full, uint32_t def) {`,
    `    return __tc_prefs_get<uint32_t>(full, ${TAG.UINT}, def);`,
    `}`,
    `void __tc_prefs_put_bool(const char* full, bool v) {`,
    `    uint8_t b = v ? 1U : 0U;`,
    `    __tc_prefs_put<uint8_t>(full, ${TAG.BOOL}, b);`,
    `}`,
    `bool __tc_prefs_get_bool(const char* full, bool def) {`,
    `    uint8_t b = __tc_prefs_get<uint8_t>(full, ${TAG.BOOL}, def ? 1U : 0U);`,
    `    return b != 0U;`,
    `}`,
    `void __tc_prefs_put_float(const char* full, float v) {`,
    `    __tc_prefs_put<float>(full, ${TAG.FLOAT}, v);`,
    `}`,
    `float __tc_prefs_get_float(const char* full, float def) {`,
    `    return __tc_prefs_get<float>(full, ${TAG.FLOAT}, def);`,
    `}`,
    ``,
    `// Strings are length-prefixed into the value buffer (capped at STR_LEN so the`,
    `// whole slot still fits in __TC_PREFS_VAL_LEN). get copies out with a NUL and`,
    `// returns def when the slot is absent or the wrong type. put takes`,
    `// const std::string& — string-typed TS values (string unions, class members,`,
    `// locals) lower as std::string and must bind here without a manual c_str()`,
    `// the way every other shim boundary already accepts them.`,
    `void __tc_prefs_put_string(const char* full, const std::string& v) {`,
    `    const char* vc = v.c_str();`,
    `    __tc_prefs_ensure_loaded();`,
    `    uint8_t buf[1U + __TC_PREFS_STR_LEN];`,
    `    buf[0] = ${TAG.STRING};`,
    `    size_t n = strlen(vc);`,
    `    if (n > __TC_PREFS_STR_LEN) { n = __TC_PREFS_STR_LEN; }`,
    `    (void)memcpy(&buf[1], vc, n);`,
    `    (void)settings_save_one(full, buf, 1U + n);`,
    `    __tc_prefs_slot* slot = __tc_prefs_slot_for(full);`,
    `    if (slot != nullptr) {`,
    `        (void)snprintf(slot->key, __TC_PREFS_KEY_LEN, "%s", full);`,
    `        slot->type = ${TAG.STRING};`,
    `        slot->len = static_cast<uint8_t>(1U + static_cast<uint8_t>(n));`,
    `        (void)memcpy(slot->val, buf, 1U + n);`,
    `        slot->used = true;`,
    `    }`,
    `}`,
    `const char* __tc_prefs_get_string(const char* full, const char* def) {`,
    `    __tc_prefs_ensure_loaded();`,
    `    static char out[__TC_PREFS_STR_LEN + 1U];`,
    `    __tc_prefs_slot* slot = __tc_prefs_find(full);`,
    `    if (slot == nullptr || slot->type != ${TAG.STRING} || slot->len < 1U) {`,
    `        return def;`,
    `    }`,
    `    size_t n = slot->len - 1U;`,
    `    if (n > __TC_PREFS_STR_LEN) { n = __TC_PREFS_STR_LEN; }`,
    `    (void)memcpy(out, &slot->val[1], n);`,
    `    out[n] = '\\0';`,
    `    return out;`,
    `}`,
    `#endif // CUTTLEFISH_PREFS_SINGLETON_DEFS`,
    `#else // !CUTTLEFISH_ENTRY_TU — every other TU links against the one cache`,
    `#ifndef CUTTLEFISH_PREFS_SINGLETON_DECLS`,
    `#define CUTTLEFISH_PREFS_SINGLETON_DECLS`,
    `bool __tc_prefs_remove(const char* full);`,
    `void __tc_prefs_clear(const char* prefix);`,
    `void __tc_prefs_put_int(const char* full, int32_t v);`,
    `int32_t __tc_prefs_get_int(const char* full, int32_t def);`,
    `void __tc_prefs_put_uint(const char* full, uint32_t v);`,
    `uint32_t __tc_prefs_get_uint(const char* full, uint32_t def);`,
    `void __tc_prefs_put_bool(const char* full, bool v);`,
    `bool __tc_prefs_get_bool(const char* full, bool def);`,
    `void __tc_prefs_put_float(const char* full, float v);`,
    `float __tc_prefs_get_float(const char* full, float def);`,
    `void __tc_prefs_put_string(const char* full, const std::string& v);`,
    `const char* __tc_prefs_get_string(const char* full, const char* def);`,
    `#endif // CUTTLEFISH_PREFS_SINGLETON_DECLS`,
    `#endif // CUTTLEFISH_ENTRY_TU`,
    `// CUTTLEFISH_PREFS_END`,
    ``,
  ];
}

/**
 * Resolve a HAL preferences.* op to Zephyr C++ via the __tc_prefs_* shim.
 * Returns `{ code }` for statement ops, `{ expression }` for value-returning
 * ops (the get_* family). The `default` arm throws the standard unsupported-op
 * error so the manifest validator's per-op probe stays honest.
 */
export function lowerPreferences(op: HALOpIR): { code?: string; expression?: string } {
  const o = op as any;

  switch (op.operation) {
    case 'preferences.clear':
      return { code: `__tc_prefs_clear("tc/${unq(o.ns)}/");` };
    case 'preferences.remove':
      return { code: `__tc_prefs_remove(${fullKey(o.ns, o.key)});` };
    case 'preferences.put_int':
      return { code: `__tc_prefs_put_int(${fullKey(o.ns, o.key)}, ${s(o.value)});` };
    case 'preferences.get_int':
      return { expression: `__tc_prefs_get_int(${fullKey(o.ns, o.key)}, ${s(o.defaultValue)})` };
    case 'preferences.put_bool':
      return { code: `__tc_prefs_put_bool(${fullKey(o.ns, o.key)}, ${boolText(o.value)});` };
    case 'preferences.get_bool':
      return { expression: `__tc_prefs_get_bool(${fullKey(o.ns, o.key)}, ${boolText(o.defaultValue)})` };
    case 'preferences.put_float':
      return { code: `__tc_prefs_put_float(${fullKey(o.ns, o.key)}, ${s(o.value)});` };
    case 'preferences.get_float':
      // The shim accessor is float (the settings payload is 32-bit); TS
      // numbers are doubles, so every consumer site compares/assigns the
      // read against double operands — the raw float expression promoted at
      // each use (-Wdouble-promotion). Cast once here.
      return { expression: `static_cast<double>(__tc_prefs_get_float(${fullKey(o.ns, o.key)}, ${s(o.defaultValue)}))` };
    case 'preferences.put_string':
      return { code: `__tc_prefs_put_string(${fullKey(o.ns, o.key)}, ${s(o.value)});` };
    case 'preferences.get_string':
      return { expression: `__tc_prefs_get_string(${fullKey(o.ns, o.key)}, ${s(o.defaultValue)})` };
    default:
      throw new Error(
        `framework-zephyr does not yet support HAL op \`${op.operation}\`. ` +
          `Open an issue or use rawCpp() to emit it manually.`,
      );
  }
}


// ── Op C++ return types (the single definition site) ─────────────────────
// Beside the lowering cases that emit them; served to the engine via the
// strategy's halOpCppType seam (see wifi.ts for the contract).
export const OP_CPP_RETURN_TYPES: Readonly<Record<string, string>> = {
  'preferences.get_int': 'int32_t',
  'preferences.get_bool': 'bool',
  'preferences.get_float': 'double',
  'preferences.get_string': 'const char*',
};
