/**
 * Which sensors can be enabled together, which need the expansion rail, and
 * which need a particular board.
 *
 * A Shimmer3 or Shimmer3R has more sensors than it has ADC inputs, so some
 * combinations are impossible. The firmware silently corrects a few of them and
 * says nothing about the rest, which leaves a host in an awkward position: a
 * configuration it wrote and read back unchanged can still not be the one in
 * force, and a channel can stream a well-formed packet of nothing.
 *
 * This module is the host-side rule set that closes that gap. It is pure — no
 * transport, no device state — so a configuration editor can consult it against
 * an image it has not written yet, which is the whole point: telling somebody
 * before they press Apply beats correcting them afterwards.
 *
 * **Two kinds of rule, and the difference matters to a user.**
 *
 * `enforcedBy: 'firmware'` means the device will make this change itself at its
 * next configuration write, whatever the host sends —
 * `ShimConfig_checkAndCorrectConfig` (`Configuration/shimmer_config.c`, the
 * GSR/bridge-amp/ExG-versus-internal-ADC block). A host that reports these is
 * predicting the device, not overruling it.
 *
 * `enforcedBy: 'host'` means the firmware will accept the combination and
 * stream it, and it still cannot work — most often because the two sensors are
 * on different expansion boards and only one board can be fitted. These come
 * from the Java driver's `SensorDetailsRef.mListOfSensorIdsConflicting`, which
 * is what Consensys enforces in its own editor.
 *
 * **Those lists are easy to look for and not find.** Almost every Shimmer3
 * entry passes its list as argument 5 of the eight-argument `SensorDetailsRef`
 * constructor (`driverUtilities/SensorDetailsRef.java:122-140`) rather than
 * assigning the field, so a search for `mListOfSensorIdsConflicting =` turns up
 * the Shimmer2 block (`driver/Configuration.java:337-380`) and little else.
 * Read the constructor calls: `sensors/SensorGSR.java:139-167` names both
 * internal ADC channels, the bridge amplifier and the host ExG modes, and
 * `sensors/SensorBridgeAmp.java:97-121` names GSR back.
 *
 * Two details of those lists are worth knowing, because they explain what this
 * table does and does not say. The ExG conflicts are listed as the **host
 * algorithm** ids (`HOST_ECG`, `HOST_EMG`, `HOST_EXG_TEST` and the rest) and
 * the four raw ExG bit ids sit commented out beside them, so Java expresses
 * "GSR cannot be used with ExG" at the level of a chosen ExG mode — which is
 * exactly what `'EXG'` is here. And Java's per-channel lists are asymmetric
 * where a derived channel is involved (PPG, the resistance amplifier, skin
 * temperature); this SDK models none of those, so its table is symmetric.
 *
 * **One firmware rule is deliberately absent.** `checkAndCorrectConfig` also
 * clears a chip's 16-bit ExG flag when its 24-bit flag is set
 * (`Configuration/shimmer_config.c:839-848`). That is a sample width, not a
 * pair of sensors, and `'EXG'` covers all four bits at once here — so it cannot
 * be expressed as a conflict and is not one. A host picks a width when it picks
 * a preset; `exgResolutionFromSensors` in `devices/exg/` reads back which one a
 * bitmap holds.
 *
 * **On required sensors.** There are none in the enabled-bitmap sense.
 * `mListOfSensorIdsRequired` is declared on every `SensorDetailsRef`
 * (`driverUtilities/SensorDetailsRef.java:34`) and populated nowhere in the
 * Java driver, so the code that reads it (`ShimmerDevice.java:2365`,
 * `:2519-2536`) never does anything. The real dependencies are the expansion
 * rail (below), the firmware's own skin-temperature and resistance-amplifier
 * rule — which forces an internal ADC channel on, and concerns derived channels
 * this SDK does not model — and the algorithm layer, which does not exist here.
 * Saying so is more use to a host than inventing a requirement.
 */

import { SensorBitmapShimmer3, type SensorBitmapShimmer3Key } from '../shimmer3r/SensorBitmap.js';
import type { ShimmerGeneration } from '../shimmer3r/channelFormats.js';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * A sensor these rules talk about.
 *
 * Everything is a {@link SensorBitmapShimmer3} key except `'EXG'`, which stands
 * for the ExG front end as a whole. The four ExG bits select a chip and a
 * sample width rather than a sensor, no combination of them is a different
 * *sensor*, and every conflict applies to all four alike — so a host chooses an
 * ExG mode and this module talks about that.
 */
export type SensorRuleKey = SensorBitmapShimmer3Key | 'EXG';

/** Any ExG bit set means the ExG front end is enabled. */
export const EXG_ANY_MASK =
  SensorBitmapShimmer3.SENSOR_EXG1_24BIT |
  SensorBitmapShimmer3.SENSOR_EXG2_24BIT |
  SensorBitmapShimmer3.SENSOR_EXG1_16BIT |
  SensorBitmapShimmer3.SENSOR_EXG2_16BIT;

/** The four internal ADC bits, whose enables leave the expansion rail alone. */
const INTERNAL_ADC_KEYS: readonly SensorRuleKey[] = Object.freeze([
  'SENSOR_INT_A0',
  'SENSOR_INT_A1',
  'SENSOR_INT_A2',
  'SENSOR_INT_A3',
]);

/** The bitmap mask for one rule key; 0 for `'EXG'`, which owns no single bit. */
export function sensorRuleMask(key: SensorRuleKey): number {
  return key === 'EXG' ? EXG_ANY_MASK : SensorBitmapShimmer3[key];
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

interface ConflictPair {
  a: SensorRuleKey;
  b: SensorRuleKey;
  /** True when the firmware corrects this itself at its next config write. */
  firmware: boolean;
  /** What the two share, for the message a host shows. */
  shares: string;
}

/**
 * Every pair that cannot be enabled together.
 *
 * Listed once per pair and applied both ways, so the table cannot become
 * asymmetric. The Java lists it is drawn from ARE asymmetric in places — GSR
 * names internal A1 and A14 while neither names GSR back, and
 * `sensorPpgHostPPG1_A13` omits an ExG mode its sibling includes — but those
 * asymmetries are in derived PPG and skin-temperature channels this SDK does
 * not model, and a rule that fires in one direction only would be a bug
 * wherever it did apply.
 *
 * Shimmer3 ADC names map onto the bitmap keys as A1 → `SENSOR_INT_A3`,
 * A12 → `SENSOR_INT_A0`, A13 → `SENSOR_INT_A1`, A14 → `SENSOR_INT_A2`
 * (`SensorADC.java:210,234,262,290` against `SensorBitmap.ts:33-36`). On a
 * Shimmer3R the same bits are A3, A0, A1 and A2 — the firmware's own logical
 * indices — which is why {@link describeSensorRules} takes a generation.
 */
const CONFLICT_PAIRS: readonly ConflictPair[] = Object.freeze([
  // --- Firmware-enforced (shimmer_config.c, ShimConfig_checkAndCorrectConfig).
  {
    a: 'SENSOR_GSR',
    b: 'SENSOR_INT_A3',
    firmware: true,
    shares: 'one ADC input (Shimmer3 A1, Shimmer3R A3)',
  },
  {
    a: 'SENSOR_BRIDGE_AMP',
    b: 'SENSOR_INT_A1',
    firmware: true,
    shares: 'one ADC input (Shimmer3 A13, Shimmer3R A1)',
  },
  {
    a: 'SENSOR_BRIDGE_AMP',
    b: 'SENSOR_INT_A2',
    firmware: true,
    shares: 'one ADC input (Shimmer3 A14, Shimmer3R A2)',
  },
  {
    a: 'EXG',
    b: 'SENSOR_INT_A3',
    firmware: true,
    shares: 'one ADC input (Shimmer3 A1, Shimmer3R A3)',
  },
  {
    a: 'EXG',
    b: 'SENSOR_INT_A2',
    firmware: true,
    shares: 'one ADC input (Shimmer3 A14, Shimmer3R A2)',
  },

  // --- Host-enforced (SensorDetailsRef conflict lists; Consensys's rules).
  {
    a: 'SENSOR_GSR',
    b: 'SENSOR_INT_A2',
    firmware: false,
    shares: 'the GSR+ board’s own ADC line',
  },
  {
    a: 'SENSOR_GSR',
    b: 'SENSOR_BRIDGE_AMP',
    firmware: false,
    shares: 'the expansion connector — they are different boards',
  },
  {
    a: 'SENSOR_GSR',
    b: 'EXG',
    firmware: false,
    shares: 'the expansion connector — they are different boards',
  },
  {
    a: 'SENSOR_BRIDGE_AMP',
    b: 'SENSOR_INT_A0',
    firmware: false,
    shares: 'one ADC input (Shimmer3 A12, Shimmer3R A0)',
  },
  {
    a: 'SENSOR_BRIDGE_AMP',
    b: 'EXG',
    firmware: false,
    shares: 'the expansion connector — they are different boards',
  },
  {
    a: 'EXG',
    b: 'SENSOR_INT_A0',
    firmware: false,
    shares: 'one ADC input (Shimmer3 A12, Shimmer3R A0)',
  },
  {
    a: 'EXG',
    b: 'SENSOR_INT_A1',
    firmware: false,
    shares: 'one ADC input (Shimmer3 A13, Shimmer3R A1)',
  },
]);

/** Conflicts for one key, resolved from the symmetric pair table. */
export function sensorConflicts(
  key: SensorRuleKey,
): ReadonlyArray<{ key: SensorRuleKey; firmware: boolean; shares: string }> {
  const out: Array<{ key: SensorRuleKey; firmware: boolean; shares: string }> = [];
  for (const p of CONFLICT_PAIRS) {
    if (p.a === key) out.push({ key: p.b, firmware: p.firmware, shares: p.shares });
    else if (p.b === key) out.push({ key: p.a, firmware: p.firmware, shares: p.shares });
  }
  return out;
}

/** The whole pair table, for a host that wants to render it. */
export const SENSOR_RULE_CONFLICTS = CONFLICT_PAIRS;

// ---------------------------------------------------------------------------
// Expansion-board power
// ---------------------------------------------------------------------------

/**
 * Sensors that need the internal expansion rail switched on.
 *
 * `mIntExpBoardPowerRequired` in the Java driver: GSR
 * (`SensorGSR.java:168`), the bridge amplifier (`SensorBridgeAmp.java:121`) and
 * every ExG mode (`SensorEXG.java:374` and its siblings). The internal ADC
 * channels are `false` there, which is why enabling one leaves the bit alone
 * rather than clearing it.
 *
 * **The firmware never derives this.** The bit defaults to off
 * (`ShimConfig_setDefaultConfig`), is read once at sensing start to raise the
 * rail (`Sensing/shimmer_sensing.c:181-184`), and appears nowhere in
 * `ShimConfig_checkAndCorrectConfig`. So a host can enable GSR, get an ACK,
 * read back exactly what it wrote, and stream a perfectly well-formed packet
 * from an unpowered front end.
 *
 * On a Shimmer3R the bit does not in fact power the ExG board — the ADS1292R
 * comes up through `EXG_RESET_N` from its own driver (`EXG/ads1292.c:161-183`)
 * — but Consensys sets it for ExG on every platform, a Shimmer3 genuinely needs
 * it, and matching Consensys keeps the two tools' images identical. So ExG is
 * listed.
 */
const EXP_POWER_REQUIRED: ReadonlySet<SensorRuleKey> = new Set<SensorRuleKey>([
  'SENSOR_GSR',
  'SENSOR_BRIDGE_AMP',
  'EXG',
]);

/** Whether this sensor needs the expansion rail. */
export function requiresExpansionPower(key: SensorRuleKey): boolean {
  return EXP_POWER_REQUIRED.has(key);
}

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

/**
 * SR board codes these rules refer to (`ShimmerVerDetails.java:113-126`, the
 * same codes `devices/identity.ts` names).
 */
export const SR_BOARD = Object.freeze({
  BRIDGE_AMP: 8,
  BRIDGE_AMP_UNIFIED: 49,
  GSR: 14,
  GSR_UNIFIED: 48,
  EXG: 37,
  EXG_UNIFIED: 47,
  PROTO3_MINI: 36,
  PROTO3_DELUXE: 38,
  IMU: 31,
});

/** How firmly a hardware rule should be applied. */
export type SensorGate = 'block' | 'warn';

interface HardwareRule {
  boards: readonly number[];
  generations: readonly ShimmerGeneration[];
  gate: SensorGate;
  /** What to call the hardware this sensor needs. */
  needs: string;
}

/**
 * What board and platform each sensor needs.
 *
 * Drawn from the Java driver's `mListOfCompatibleVersionInfo`
 * (`Configuration.java:1406-1441` ExG, `:1457-1461` GSR, `:1574-1578` bridge
 * amplifier, `:1588-1637` the internal ADCs), which
 * `sensorMapCheckandCorrectHwDependencies` (`ShimmerDevice.java:2538-2551`)
 * enforces by disabling anything incompatible.
 *
 * The gate differs on purpose. A `'block'` sensor is one whose front end is
 * simply absent on the wrong board, so the channel would stream noise. The
 * internal ADC lines only `'warn'`: Java's per-line lists are
 * board-revision-specific and name boards this SDK's SR table does not carry
 * (the 200 g accelerometer, for one), so refusing on an incomplete table would
 * reject configurations that work.
 *
 * A sensor absent from this table has no hardware requirement.
 */
const HARDWARE_RULES: Readonly<Partial<Record<SensorRuleKey, HardwareRule>>> = Object.freeze({
  SENSOR_GSR: {
    boards: [SR_BOARD.GSR, SR_BOARD.GSR_UNIFIED],
    generations: ['shimmer3', 'shimmer3r'],
    gate: 'block',
    needs: 'a GSR+ board (SR14 or SR48)',
  },
  SENSOR_BRIDGE_AMP: {
    boards: [SR_BOARD.BRIDGE_AMP, SR_BOARD.BRIDGE_AMP_UNIFIED],
    // Shimmer3 only: the Shimmer3R channel table has no bridge-amplifier
    // channel at all, so the firmware cannot stream one.
    generations: ['shimmer3'],
    gate: 'block',
    needs: 'a Bridge Amplifier+ board (SR8 or SR49) on a Shimmer3',
  },
  EXG: {
    boards: [SR_BOARD.EXG, SR_BOARD.EXG_UNIFIED],
    generations: ['shimmer3', 'shimmer3r'],
    gate: 'block',
    needs: 'an ECG/EMG board (SR37 or SR47)',
  },
  SENSOR_INT_A0: {
    boards: [
      SR_BOARD.GSR,
      SR_BOARD.GSR_UNIFIED,
      SR_BOARD.PROTO3_MINI,
      SR_BOARD.PROTO3_DELUXE,
      SR_BOARD.BRIDGE_AMP,
      SR_BOARD.BRIDGE_AMP_UNIFIED,
    ],
    generations: ['shimmer3', 'shimmer3r'],
    gate: 'warn',
    needs: 'a board with the internal expansion connector',
  },
});

// The three remaining internal ADC lines share A0's rule.
const INT_ADC_RULE = HARDWARE_RULES.SENSOR_INT_A0!;
const hardwareRuleFor = (key: SensorRuleKey): HardwareRule | undefined =>
  INTERNAL_ADC_KEYS.includes(key) ? INT_ADC_RULE : HARDWARE_RULES[key];

// ---------------------------------------------------------------------------
// State and results
// ---------------------------------------------------------------------------

/** The configuration these rules are evaluated against. */
export interface SensorRuleState {
  /** The 24-bit enabled-sensor bitmap. */
  enabledSensors: number;
  /**
   * The host's ExG mode selection, where it has one: `'off'`, or any other
   * string for an ExG preset. Optional — with it absent the ExG front end
   * counts as enabled when any of its bitmap bits is set.
   */
  exgMode?: string | null;
  /** The expansion-power bit, or `null` when the host does not know it. */
  expPower?: 0 | 1 | null;
  /** The platform, or `null` when the device has not said. */
  generation?: ShimmerGeneration | null;
  /** The fitted board's SR id, or `null` when unknown or unreadable. */
  boardId?: number | null;
}

/** One change a rule made, or would make. */
export interface SensorRuleChange {
  /** The sensor that moved, or `'expPower'` for the rail. */
  key: SensorRuleKey | 'expPower';
  from: number;
  to: number;
  /** A sentence a host can show as-is. */
  reason: string;
}

/** Something about this configuration that cannot work. */
export interface SensorRuleViolation {
  kind: 'conflict' | 'expPower' | 'hardware' | 'generation';
  /** The sensors involved. */
  sensors: SensorRuleKey[];
  enforcedBy: 'firmware' | 'host';
  /** A sentence a host can show as-is. */
  message: string;
}

/** What {@link checkSensorRules} found. */
export interface SensorRuleCheck {
  violations: SensorRuleViolation[];
  /** The nearest configuration that breaks no rule. */
  derivations: { enabledSensors: number; expPower: 0 | 1 | null; exgOff: boolean };
  /** How to get from the given state to {@link derivations}. */
  changes: SensorRuleChange[];
}

/** What {@link applySensorToggle} produced. */
export interface SensorToggleResult {
  enabledSensors: number;
  expPower: 0 | 1 | null;
  /** True when the ExG front end was turned off, so a host resets its mode control. */
  exgOff: boolean;
  /**
   * Whether the ExG front end is on after this toggle.
   *
   * Feed it back as {@link SensorRuleState.exgMode} on the next call. It is not
   * derivable from `enabledSensors`, because `'EXG'` owns no single bit: a host
   * ORs in the width bits its chosen preset needs, and until it does, an ExG
   * that this call turned on is invisible in the bitmap. Without it a caller
   * that toggles and then validates gets `expPower` derived on by the toggle
   * and derived straight back off by {@link checkSensorRules}, which would
   * read the rail off the bits and find none set.
   */
  exgOn: boolean;
  changes: SensorRuleChange[];
}

/** Whether a sensor can be offered at all, given the hardware. */
export interface SensorAvailability {
  available: boolean;
  gate: SensorGate | null;
  reason: string | null;
}

/** Everything known about one sensor's rules, for a tooltip. */
export interface SensorRuleDescription {
  key: SensorRuleKey;
  label: string;
  bit: number;
  conflicts: ReadonlyArray<{ key: SensorRuleKey; firmware: boolean }>;
  requiresExpPower: boolean;
  boards: readonly number[] | null;
  generations: readonly ShimmerGeneration[] | null;
  /** A few lines of prose, ready to be a `title` attribute. */
  text: string;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Per-generation names for the ADC lines, whose labels differ by platform. */
const GENERATION_LABELS: Readonly<
  Partial<Record<SensorRuleKey, Partial<Record<ShimmerGeneration, string>>>>
> = Object.freeze({
  SENSOR_INT_A0: { shimmer3: 'Internal ADC A12', shimmer3r: 'Internal ADC A0' },
  SENSOR_INT_A1: { shimmer3: 'Internal ADC A13', shimmer3r: 'Internal ADC A1' },
  SENSOR_INT_A2: { shimmer3: 'Internal ADC A14', shimmer3r: 'Internal ADC A2' },
  SENSOR_INT_A3: { shimmer3: 'Internal ADC A1', shimmer3r: 'Internal ADC A3' },
  SENSOR_EXT_A0: { shimmer3: 'External ADC A7', shimmer3r: 'External ADC A0' },
  SENSOR_EXT_A1: { shimmer3: 'External ADC A6', shimmer3r: 'External ADC A1' },
  SENSOR_EXT_A2: { shimmer3: 'External ADC A15', shimmer3r: 'External ADC A2' },
});

const BASE_LABELS: Readonly<Partial<Record<SensorRuleKey, string>>> = Object.freeze({
  EXG: 'ExG',
  SENSOR_GSR: 'GSR',
  SENSOR_BRIDGE_AMP: 'Bridge amplifier',
  SENSOR_A_ACCEL: 'Low-noise accelerometer',
  SENSOR_D_ACCEL: 'Wide-range accelerometer',
  SENSOR_ACCEL_ALT: 'Alt accelerometer (high-g)',
  SENSOR_GYRO: 'Gyroscope',
  SENSOR_MAG: 'Magnetometer',
  SENSOR_MAG_ALT: 'Alt magnetometer',
  SENSOR_PRESSURE: 'Pressure / temperature',
  SENSOR_VBATT: 'Battery voltage',
});

/**
 * A sensor's name, in the vocabulary of the generation in play.
 *
 * The ADC lines are the reason this takes a generation: the same bit is
 * "Internal ADC A1" on a Shimmer3 and "Internal ADC A3" on a Shimmer3R, and a
 * message naming the wrong one sends a user looking at the wrong pin.
 */
export function sensorRuleLabel(key: SensorRuleKey, generation?: ShimmerGeneration | null): string {
  const perGeneration = generation ? GENERATION_LABELS[key]?.[generation] : undefined;
  if (perGeneration) return perGeneration;
  // With no generation to hand, name both rather than guessing one.
  const both = GENERATION_LABELS[key];
  if (both) return `${both.shimmer3r} (Shimmer3: ${both.shimmer3?.replace(/^.*ADC /, 'ADC ')})`;
  return BASE_LABELS[key] ?? key;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const isOn = (mask: number, key: SensorRuleKey): boolean => (mask & sensorRuleMask(key)) !== 0;

/**
 * Is the ExG front end enabled?
 *
 * A host that owns an ExG mode control is the authority — its selection is what
 * the next Apply will write, and the bitmap bits may not have caught up. With
 * no mode given, the bits are all there is.
 */
function exgEnabled(state: SensorRuleState): boolean {
  if (state.exgMode !== undefined && state.exgMode !== null) {
    if (state.exgMode !== 'off') return true;
    // An explicit 'off' still defers to bits that are actually set: they are
    // what the device would stream.
    return (state.enabledSensors & EXG_ANY_MASK) !== 0;
  }
  return (state.enabledSensors & EXG_ANY_MASK) !== 0;
}

const enabledKeys = (state: SensorRuleState): SensorRuleKey[] => {
  const keys: SensorRuleKey[] = [];
  for (const key of Object.keys(SensorBitmapShimmer3) as SensorBitmapShimmer3Key[]) {
    // The ExG bits are spoken for by the 'EXG' key.
    if (sensorRuleMask(key) & EXG_ANY_MASK) continue;
    if (isOn(state.enabledSensors, key)) keys.push(key);
  }
  if (exgEnabled(state)) keys.push('EXG');
  return keys;
};

/**
 * The expansion-power bit this configuration should carry.
 *
 * Port of `ShimmerDevice.checkIfInternalExpBrdPowerIsNeeded` (:2279-2298): on
 * if any enabled sensor needs the rail; otherwise off, **unless** an internal
 * ADC channel is enabled, in which case it is left as it was. That last clause
 * is deliberate in the Java driver — the internal ADC lines can be wired to
 * something that needs power without the driver knowing — so `null` in means
 * `null` out.
 */
export function deriveExpPower(
  enabledSensors: number,
  exgOn: boolean,
  current: 0 | 1 | null | undefined,
): 0 | 1 | null {
  const state: SensorRuleState = { enabledSensors, exgMode: exgOn ? 'on' : 'off' };
  for (const key of enabledKeys(state)) {
    if (requiresExpansionPower(key)) return 1;
  }
  const anyInternalAdc = INTERNAL_ADC_KEYS.some((k) => isOn(enabledSensors, k));
  if (anyInternalAdc) return current ?? null;
  return 0;
}

/**
 * Whether a sensor can be offered, given what is known about the hardware.
 *
 * `available: false` with `gate: 'block'` means a host should refuse the choice
 * — but only for a sensor that is currently OFF. A host must always be able to
 * turn off something that is on, whatever the board says, or a configuration
 * read from a device cannot be corrected.
 */
export function sensorAvailability(key: SensorRuleKey, state: SensorRuleState): SensorAvailability {
  const rule = hardwareRuleFor(key);
  if (!rule) return { available: true, gate: null, reason: null };
  const label = sensorRuleLabel(key, state.generation);

  if (state.generation && !rule.generations.includes(state.generation)) {
    return {
      available: false,
      gate: 'block',
      reason:
        state.generation === 'shimmer3r'
          ? `${label} does not exist on a Shimmer3R: its firmware has no such channel.`
          : `${label} is not available on a Shimmer3.`,
    };
  }
  // An unknown board gates nothing: a blank daughter-card id page is a real
  // state, and refusing every board sensor on one would be worse than useless.
  if (state.boardId == null) return { available: true, gate: null, reason: null };
  if (rule.boards.includes(state.boardId)) return { available: true, gate: null, reason: null };
  return {
    available: rule.gate === 'warn',
    gate: rule.gate,
    reason: `${label} needs ${rule.needs}; this board reports SR${state.boardId}.`,
  };
}

/** Everything known about one sensor's rules, for a tooltip. */
export function describeSensorRules(
  key: SensorRuleKey,
  generation?: ShimmerGeneration | null,
): SensorRuleDescription {
  if (key !== 'EXG' && !(key in SensorBitmapShimmer3)) {
    throw new RangeError(`Unknown sensor rule key: ${String(key)}`);
  }
  const label = sensorRuleLabel(key, generation);
  const conflicts = sensorConflicts(key);
  const rule = hardwareRuleFor(key);
  const bit = sensorRuleMask(key);

  const lines: string[] = [`${label} — bitmap 0x${bit.toString(16).padStart(6, '0')}`];
  if (conflicts.length) {
    lines.push(
      'Cannot be enabled with: ' +
        conflicts
          .map(
            (c) =>
              sensorRuleLabel(c.key, generation) + (c.firmware ? ' (the firmware unticks it)' : ''),
          )
          .join(', ') +
        '.',
    );
  }
  if (requiresExpansionPower(key)) lines.push('Turns expansion-board power on.');
  if (rule) lines.push(`Needs ${rule.needs}.`);

  return {
    key,
    label,
    bit,
    conflicts: conflicts.map((c) => ({ key: c.key, firmware: c.firmware })),
    requiresExpPower: requiresExpansionPower(key),
    boards: rule?.boards ?? null,
    generations: rule?.generations ?? null,
    text: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Toggling
// ---------------------------------------------------------------------------

const clearKey = (mask: number, key: SensorRuleKey): number => mask & ~sensorRuleMask(key);

/**
 * Enable or disable one sensor, correcting whatever that breaks.
 *
 * **The newest choice wins**, which is `ShimmerDevice.sensorMapConflictCheckandCorrect`
 * (:2497-2516): every sensor conflicting with the one just enabled is turned
 * off, unconditionally. There is no "refuse the edit" path in the Java driver
 * and there is none here — a user who ticks a box expects the box to tick, and
 * being told what else changed is friendlier than being told no.
 *
 * The expansion rail follows, by {@link deriveExpPower}.
 *
 * @returns the corrected bitmap, the derived rail, and a sentence per change.
 */
export function applySensorToggle(
  state: SensorRuleState,
  key: SensorRuleKey,
  enabled: boolean,
): SensorToggleResult {
  if (key !== 'EXG' && !(key in SensorBitmapShimmer3)) {
    throw new RangeError(`Unknown sensor rule key: ${String(key)}`);
  }
  const changes: SensorRuleChange[] = [];
  let mask = state.enabledSensors;
  let exgOff = false;
  const label = sensorRuleLabel(key, state.generation);

  if (enabled) {
    for (const c of sensorConflicts(key)) {
      const on =
        c.key === 'EXG' ? exgEnabled({ ...state, enabledSensors: mask }) : isOn(mask, c.key);
      if (!on) continue;
      mask = clearKey(mask, c.key);
      if (c.key === 'EXG') exgOff = true;
      const other = sensorRuleLabel(c.key, state.generation);
      changes.push({
        key: c.key,
        from: 1,
        to: 0,
        reason: c.firmware
          ? `${other} unticked — it shares ${c.shares} with ${label}, and the firmware ` +
            'clears it itself on the next write.'
          : `${other} unticked — it cannot be used with ${label} (they share ${c.shares}).`,
      });
    }
  }

  // 'EXG' owns no single bit: a host ORs in the width bits its preset chose.
  if (key !== 'EXG') {
    mask = enabled ? mask | sensorRuleMask(key) : clearKey(mask, key);
  } else if (!enabled) {
    mask = clearKey(mask, 'EXG');
    exgOff = true;
  }

  const exgOn = key === 'EXG' ? enabled : exgEnabled({ ...state, enabledSensors: mask });
  const expPower = deriveExpPower(mask, exgOn, state.expPower);
  if (expPower !== (state.expPower ?? null)) {
    changes.push({
      key: 'expPower',
      from: state.expPower ?? 0,
      to: expPower ?? 0,
      reason: expPowerReason(expPower, mask, exgOn, state),
    });
  }

  return { enabledSensors: mask, expPower, exgOff, exgOn, changes };
}

function expPowerReason(
  next: 0 | 1 | null,
  mask: number,
  exgOn: boolean,
  state: SensorRuleState,
): string {
  if (next !== 1) return 'Expansion-board power switched off — nothing enabled needs the rail.';
  const needing = enabledKeys({ ...state, enabledSensors: mask, exgMode: exgOn ? 'on' : 'off' })
    .filter(requiresExpansionPower)
    .map((k) => sensorRuleLabel(k, state.generation));
  let reason = `Expansion-board power switched on — ${needing.join(' and ')} ${
    needing.length > 1 ? 'need' : 'needs'
  } the internal expansion rail.`;
  if (exgOn && state.generation === 'shimmer3r') {
    reason +=
      ' On a Shimmer3R the ExG front end has its own power control, but Consensys sets ' +
      'this bit for ExG on every platform and this matches it.';
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Checking an existing configuration
// ---------------------------------------------------------------------------

/**
 * Priority when an image already breaks a rule and there is no "newest" choice.
 *
 * A configuration read off a device, or loaded from a file, has to be corrected
 * without knowing what the user meant. The order is:
 *
 * 1. For a firmware-enforced pair, the ADC channel loses — that is what the
 *    device itself will do.
 * 2. For a host-enforced ADC pair, the ADC channel loses too, for consistency.
 * 3. When two owners of the expansion connector are both on, keep the one the
 *    fitted board is for. With no board known, keep ExG over GSR over the
 *    bridge amplifier: an ExG mode is the most deliberate choice a host can
 *    have made, since it takes a control of its own.
 */
const CONNECTOR_OWNERS: readonly SensorRuleKey[] = Object.freeze([
  'EXG',
  'SENSOR_GSR',
  'SENSOR_BRIDGE_AMP',
]);

function preferredConnectorOwner(state: SensorRuleState): SensorRuleKey {
  const board = state.boardId;
  if (board != null) {
    for (const key of CONNECTOR_OWNERS) {
      const rule = hardwareRuleFor(key);
      if (rule?.boards.includes(board)) return key;
    }
  }
  return 'EXG';
}

/**
 * Check a configuration against every rule, and say what the nearest working
 * one would be.
 *
 * Idempotent: checking {@link SensorRuleCheck.derivations} produces no
 * violations.
 */
export function checkSensorRules(state: SensorRuleState): SensorRuleCheck {
  const violations: SensorRuleViolation[] = [];
  const changes: SensorRuleChange[] = [];
  let mask = state.enabledSensors;
  let exgOn = exgEnabled(state);
  let exgOff = false;

  const drop = (key: SensorRuleKey, reason: string) => {
    mask = clearKey(mask, key);
    if (key === 'EXG') {
      exgOn = false;
      exgOff = true;
    }
    changes.push({ key, from: 1, to: 0, reason });
  };
  const on = (key: SensorRuleKey): boolean =>
    key === 'EXG' ? exgOn : isOn(mask, key) && (mask & sensorRuleMask(key)) !== 0;

  // --- hardware and generation, first: a sensor the board does not have
  // cannot be part of any other rule's resolution.
  for (const key of enabledKeys(state)) {
    const availability = sensorAvailability(key, state);
    if (availability.available || availability.gate !== 'block') continue;
    const generationRule =
      state.generation && !(hardwareRuleFor(key)?.generations.includes(state.generation) ?? true);
    violations.push({
      kind: generationRule ? 'generation' : 'hardware',
      sensors: [key],
      enforcedBy: 'host',
      message: availability.reason!,
    });
    drop(key, `${sensorRuleLabel(key, state.generation)} unticked — ${availability.reason}`);
  }

  // --- conflicts
  const owner = preferredConnectorOwner(state);
  for (const pair of CONFLICT_PAIRS) {
    if (!on(pair.a) || !on(pair.b)) continue;
    const aLabel = sensorRuleLabel(pair.a, state.generation);
    const bLabel = sensorRuleLabel(pair.b, state.generation);
    violations.push({
      kind: 'conflict',
      sensors: [pair.a, pair.b],
      enforcedBy: pair.firmware ? 'firmware' : 'host',
      message: pair.firmware
        ? `${aLabel} and ${bLabel} both share ${pair.shares}; the firmware will untick ` +
          'one of them at its next configuration write.'
        : `${aLabel} cannot be used with ${bLabel} — they share ${pair.shares}.`,
    });

    // Resolve: an ADC channel loses to a front end; between two front ends the
    // board decides.
    const aIsAdc = INTERNAL_ADC_KEYS.includes(pair.a);
    const bIsAdc = INTERNAL_ADC_KEYS.includes(pair.b);
    if (aIsAdc !== bIsAdc) {
      const loser = aIsAdc ? pair.a : pair.b;
      const keeper = aIsAdc ? pair.b : pair.a;
      drop(
        loser,
        `${sensorRuleLabel(loser, state.generation)} unticked — it shares ${pair.shares} with ` +
          `${sensorRuleLabel(keeper, state.generation)}.`,
      );
    } else {
      /* Two connector owners. The preferred one is kept and the other dropped
         — and when NEITHER is the preferred one (a GSR-plus-bridge image on a
         board that is neither, or with no board known, where the preference is
         ExG) the ranking still has to decide. Taking `pair.b` unless `pair.a`
         is the winner got that backwards: it dropped whichever side the table
         happened to list first, so a GSR + bridge-amplifier image kept the
         bridge amplifier and unticked GSR, the reverse of the documented
         order. */
      const rank = (key: SensorRuleKey): number => {
        const at = CONNECTOR_OWNERS.indexOf(key);
        return at === -1 ? CONNECTOR_OWNERS.length : at;
      };
      const keeper =
        pair.a === owner
          ? pair.a
          : pair.b === owner
            ? pair.b
            : rank(pair.a) <= rank(pair.b)
              ? pair.a
              : pair.b;
      const loser = keeper === pair.a ? pair.b : pair.a;
      drop(
        loser,
        `${sensorRuleLabel(loser, state.generation)} unticked — it cannot be used with ` +
          `${sensorRuleLabel(keeper, state.generation)} (they share ${pair.shares}).`,
      );
    }
  }

  // --- expansion power
  const expPower = deriveExpPower(mask, exgOn, state.expPower);
  const currentExpPower = state.expPower ?? null;
  if (expPower !== currentExpPower) {
    const needing = enabledKeys({ ...state, enabledSensors: mask, exgMode: exgOn ? 'on' : 'off' })
      .filter(requiresExpansionPower)
      .map((k) => sensorRuleLabel(k, state.generation));
    if (expPower === 1 && currentExpPower === 0) {
      violations.push({
        kind: 'expPower',
        sensors: needing.length
          ? (enabledKeys({ ...state, enabledSensors: mask, exgMode: exgOn ? 'on' : 'off' }).filter(
              requiresExpansionPower,
            ) as SensorRuleKey[])
          : [],
        enforcedBy: 'host',
        message:
          `${needing.join(' and ')} ${needing.length > 1 ? 'are' : 'is'} enabled but ` +
          'expansion-board power is off: the board will not be powered, and its channels ' +
          'will read nothing.',
      });
    }
    changes.push({
      key: 'expPower',
      from: currentExpPower ?? 0,
      to: expPower ?? 0,
      reason: expPowerReason(expPower, mask, exgOn, state),
    });
  }

  return {
    violations,
    derivations: { enabledSensors: mask, expPower, exgOff },
    changes,
  };
}
