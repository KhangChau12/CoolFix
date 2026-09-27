import assert from "node:assert/strict";
import { mock } from "node:test";
import { nowISO, isFrozen, sgDayKey } from "../src/lib/time";
import { rowToConfig, configToRow } from "../src/lib/mappers";
import { DEFAULT_CONFIG } from "../src/lib/types";
import { buildDemoDataset } from "../src/data/demoSeed";
import { buildHospitalDataset } from "../src/data/hospitalSeed";

const before = Date.now();
const current = Date.parse(nowISO());
assert.ok(current >= before && current <= Date.now(), "Server time must match the current wall clock");

const legacy = { clockMode: "custom" as const, customTimeISO: "2001-01-01T00:00:00.000Z" };
const browser = Object.getOwnPropertyDescriptor(globalThis, "window");
try {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: () => JSON.stringify(legacy) },
  } });
  const browserNow = Date.parse(nowISO());
  assert.ok(browserNow >= before && browserNow <= Date.now(), "Stale localStorage must not override browser time");
} finally {
  if (browser) Object.defineProperty(globalThis, "window", browser);
  else Reflect.deleteProperty(globalThis, "window");
}

for (const stored of [
  { clock_mode: "custom", custom_time_iso: legacy.customTimeISO },
  { dispatch_policy: { ...DEFAULT_CONFIG.dispatchPolicy, _coolfix_clock: legacy } },
]) {
  const config = rowToConfig(stored);
  assert.equal(config.clockMode, "real");
  assert.equal(config.customTimeISO, null);
}
const stored = configToRow({ ...DEFAULT_CONFIG, ...legacy }, { embedClockFallback: true });
assert.equal(stored.clock_mode, "real");
assert.equal(stored.custom_time_iso, null);
assert.deepEqual((stored.dispatch_policy as Record<string, unknown>)._coolfix_clock, { clockMode: "real", customTimeISO: null });

// Tests control Date locally; there is no production clock override.
mock.timers.enable({ apis: ["Date"], now: new Date("2030-02-01T15:59:59.000Z") });
try {
  const freezePoint = "2030-02-01T16:00:00.000Z";
  assert.equal(isFrozen(freezePoint), false);
  assert.equal(sgDayKey(nowISO()), "2030-02-01");
  mock.timers.tick(2000);
  assert.equal(nowISO(), "2030-02-01T16:00:01.000Z", "Time must keep advancing");
  assert.equal(isFrozen(freezePoint), true);
  assert.equal(sgDayKey(nowISO()), "2030-02-02", "Singapore dates must roll over at UTC+8 midnight");
  for (const dataset of [buildDemoDataset(), buildHospitalDataset()]) {
    assert.equal(sgDayKey(dataset.anchorISO), "2030-02-02", "Default seed dates must follow today's date");
    assert.equal(dataset.config.clockMode, "real");
    assert.equal(dataset.config.customTimeISO, null);
  }
} finally {
  mock.timers.reset();
}
console.log("Real-time checks passed: wall clock, stale browser/database overrides, advancing freeze windows, Singapore midnight, and current-date seeds.");
