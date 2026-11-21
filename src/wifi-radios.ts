// ---------------------------------------------------------------------------
// wifi-radios.ts — the Wi-Fi radios this framework can actually drive.
//
// A harvested radio node is necessary but not sufficient: the Wi-Fi Kconfig
// block (dt-config/kconfig.ts, usesWifi) selects ONE driver, CONFIG_WIFI_ESP32,
// so only radios bound by that driver's compatible work end to end. A radio
// with another binding (silabs,siwx91x-wifi, nordic,nrf7120-wifi, ...) would
// pass a presence check and then fail deep in the Zephyr build.
//
// DATA, not a board gate: keyed by devicetree compatible. Adding a radio here
// means adding its driver selection to the Kconfig block in the same change.
// ---------------------------------------------------------------------------

/** Radio compatible → the Kconfig driver symbol the Wi-Fi block enables. */
export const DRIVEN_WIFI_RADIOS: Readonly<Record<string, string>> = {
  'espressif,esp32-wifi': 'CONFIG_WIFI_ESP32',
};

/** True when the board's harvested radio is one the Wi-Fi block drives. */
export function wifiRadioIsDriven(radio: { readonly compatible: string } | undefined): boolean {
  return radio !== undefined && Object.prototype.hasOwnProperty.call(DRIVEN_WIFI_RADIOS, radio.compatible);
}
