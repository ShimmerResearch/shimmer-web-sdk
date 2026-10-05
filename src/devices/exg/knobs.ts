/**
 * ADS1292R (EXG) per-knob EDITING — change a single named setting on a pair of
 * register banks, enforcing the hardware "must-be" bits and preserving every
 * other bit, with typed validation and the desktop's respiration coupling rules.
 *
 * Where EX2's `apply.ts` writes a WHOLE preset, this module (EX4) is the
 * per-knob layer the docked config editor stages individual edits through. It is
 * pure and transport-free.
 *
 * Java oracle:
 *   - knob set + GUI labels : SensorEXG.GuiLabelConfig (SensorEXG.java:157-168),
 *     value lists SensorEXG.java:116-149.
 *   - which chip(s) each knob writes: the SensorEXG setters behind
 *     setConfigValueUsingConfigLabel (SensorEXG.java:2948-2998):
 *       · Gain  — setExGGainSetting(chipID, channel, v) per chip+channel
 *                 (SensorEXG.java:2314-2331); the GUI's single "Gain" knob sets
 *                 all four via setExGGainSetting(v) (:2333-2338).
 *       · Rate  — setEXGRateSetting(v) writes REG1 on BOTH chips (:2468-2471).
 *       · Reference electrode — setEXGReferenceElectrode(v) writes the four REG6
 *                 RLD-input bits on CHIP1 only (:2483-2489).
 *       · Lead-off detection — setEXGLeadOffCurrentMode(mode) flips comparators /
 *                 RLD sense / per-lead detect bits across BOTH chips
 *                 (:2495-2575); Off=0 / DC=1 ported (AC=2 descoped, GUI omits it).
 *       · Lead-off current — setEXGLeadOffDetectionCurrent(v) REG3 both chips
 *                 (:2600-2604).
 *       · Lead-off comparator threshold — setEXGLeadOffComparatorTreshold(v) REG3
 *                 both chips (:2610-2614).
 *       · Respiration freq — setEXG2RespirationDetectFreq(v) CHIP2 only, and
 *                 FORCES the phase to the frequency's canonical default
 *                 (:2618-2628, see the freq-flip note below).
 *       · Respiration phase — setEXG2RespirationDetectPhase(v) CHIP2 only
 *                 (:2634-2635).
 *   - phase-by-frequency lists : ListOfExGRespirationDetectPhase32khz (16 steps,
 *     values 0-15) / …64khz (8 steps, values 0-7), SensorEXG.java:143-146.
 *   - freq-flip behaviour : setEXG2RespirationDetectFreq re-validates the phase
 *     against the new list (checkWhichExgRespPhaseValuesToUse, :2883-2907,
 *     resets to configvalues[0] if the current phase is now illegal) and THEN
 *     sets a canonical phase: 112.5° (reg value 10) at 32 kHz, 157.5° (reg value
 *     7) at 64 kHz (:2622-2627). We port that net effect: flipping the frequency
 *     auto-remaps the phase to that frequency's default.
 *   - respiration-locked-unless-enabled : the desktop only opens the freq/phase
 *     popups when the respiration sensor is enabled (PanelAdvancedExG.java:340,
 *     357-361, 416-420). We reject freq/phase/control edits when chip-2
 *     respiration (demod+mod) is off — see the contract note on the knob table.
 */

import {
  EXG_BANK_LENGTH,
  applyExgMustBeBits,
  readExgField,
  setExgFieldPreserving,
  decodeExgRegisters,
  DATA_RATE_LABELS,
  GAIN_LABELS,
  LEAD_OFF_CURRENT_LABELS,
  COMPARATOR_THRESHOLD_LABELS,
  LEAD_OFF_DETECTION_LABELS,
  REFERENCE_ELECTRODE_OPTIONS,
  RESPIRATION_FREQUENCY_LABELS,
  RESPIRATION_PHASE_32KHZ_LABELS,
  RESPIRATION_PHASE_64KHZ_LABELS,
} from './registers.js';
import { detectExgPreset } from './presets.js';

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

/** The two per-chip register banks the editor stages edits against. */
export interface ExgBanks {
  /** EXG1 (chip-1) register bank — 10 bytes. */
  exg1: Uint8Array;
  /** EXG2 (chip-2) register bank — 10 bytes. */
  exg2: Uint8Array;
}

/** A selectable value for a knob: raw register/config value + human label. */
export interface ExgKnobOption {
  value: number;
  label: string;
}

/**
 * Every editable EXG knob, keyed by a stable name. Chip addressing is explicit
 * in the name where it matters: the four gain knobs name their chip AND channel
 * ('exg1Ch1Gain' = chip-1 CH1), and the respiration knobs are chip-2 only.
 */
export type ExgKnobField =
  | 'exg1Ch1Gain'
  | 'exg1Ch2Gain'
  | 'exg2Ch1Gain'
  | 'exg2Ch2Gain'
  | 'dataRate'
  | 'referenceElectrode'
  | 'leadOffDetection'
  | 'leadOffCurrent'
  | 'leadOffComparatorThreshold'
  | 'respirationEnable'
  | 'respirationFrequency'
  | 'respirationPhase';

/** A single staged knob edit: which field, and the raw value to set. */
export interface ExgKnobEdit {
  field: ExgKnobField;
  value: number;
}

// --------------------------------------------------------------------------
// Typed errors
// --------------------------------------------------------------------------

/** Base class for all knob-edit errors (so callers can `instanceof` one type). */
export class ExgKnobError extends Error {}

/** Thrown when a knob field name is not recognised. */
export class UnknownExgKnobError extends ExgKnobError {
  constructor(public readonly field: string) {
    super(`Unknown EXG knob field: "${field}".`);
    this.name = 'UnknownExgKnobError';
  }
}

/** Thrown when a value is not one of the knob's legal options. */
export class ExgKnobValueError extends ExgKnobError {
  constructor(
    public readonly field: ExgKnobField,
    public readonly value: number,
    public readonly allowed: readonly number[],
  ) {
    super(`Value ${value} is not valid for EXG knob "${field}"; allowed: [${allowed.join(', ')}].`);
    this.name = 'ExgKnobValueError';
  }
}

/**
 * Thrown when a respiration-only knob (frequency / phase) is edited while
 * chip-2 respiration is disabled (the desktop locks these — see the module
 * header). Enable respiration first (the `respirationEnable` knob, or the EX2
 * Respiration preset).
 */
export class ExgRespirationLockedError extends ExgKnobError {
  constructor(public readonly field: ExgKnobField) {
    super(
      `EXG knob "${field}" is locked until respiration is enabled ` +
        `(set "respirationEnable" to 1 or apply the Respiration preset first).`,
    );
    this.name = 'ExgRespirationLockedError';
  }
}

function assertBanks(banks: ExgBanks): void {
  if (banks.exg1.length !== EXG_BANK_LENGTH || banks.exg2.length !== EXG_BANK_LENGTH) {
    throw new RangeError(
      `EXG register banks must be exactly ${EXG_BANK_LENGTH} bytes each, got ` +
        `${banks.exg1.length}/${banks.exg2.length}.`,
    );
  }
}

// --------------------------------------------------------------------------
// Option lists
// --------------------------------------------------------------------------

const indexOptions = (labels: readonly string[]): ExgKnobOption[] =>
  labels.map((label, value) => ({ value, label }));

/** Per-channel PGA gain options (label = GUI gain, value = REG4/5 setting 0-6). */
export const GAIN_OPTIONS: readonly ExgKnobOption[] = Object.freeze(indexOptions(GAIN_LABELS));
/** REG1 data-rate options (values 0-6). */
export const DATA_RATE_OPTIONS: readonly ExgKnobOption[] = Object.freeze(
  indexOptions(DATA_RATE_LABELS),
);
/** REG3 lead-off current options (values 0-3). */
export const LEAD_OFF_CURRENT_OPTIONS: readonly ExgKnobOption[] = Object.freeze(
  indexOptions(LEAD_OFF_CURRENT_LABELS),
);
/** REG3 lead-off comparator-threshold options (values 0-7). */
export const LEAD_OFF_COMPARATOR_OPTIONS: readonly ExgKnobOption[] = Object.freeze(
  indexOptions(COMPARATOR_THRESHOLD_LABELS),
);
/** Lead-off detection mode options — Off (0) / DC Current (1). */
export const LEAD_OFF_DETECTION_OPTIONS: readonly ExgKnobOption[] = Object.freeze(
  indexOptions(LEAD_OFF_DETECTION_LABELS),
);
/** Respiration detection-frequency options — 32 kHz (0) / 64 kHz (1). */
export const RESPIRATION_FREQUENCY_OPTIONS: readonly ExgKnobOption[] = Object.freeze(
  indexOptions(RESPIRATION_FREQUENCY_LABELS),
);
/** On/Off options for the respiration-enable toggle. */
const ON_OFF_OPTIONS: readonly ExgKnobOption[] = Object.freeze([
  { value: 0, label: 'Off' },
  { value: 1, label: 'On' },
]);

/**
 * Legal respiration-phase options for a given detection frequency. At 32 kHz
 * (freq value 0) there are 16 phase steps (values 0-15); at 64 kHz (value 1)
 * there are 8 (values 0-7). Verbatim from SensorEXG.java:143-146.
 */
export function respirationPhaseOptions(freq: number): ExgKnobOption[] {
  return indexOptions(freq === 0 ? RESPIRATION_PHASE_32KHZ_LABELS : RESPIRATION_PHASE_64KHZ_LABELS);
}

/** Canonical phase the desktop forces when the detection frequency changes. */
// SensorEXG.setEXG2RespirationDetectFreq (:2622-2627): 32 kHz → PHASE_112_5
// (REG9 value 10), 64 kHz → PHASE_157_5 (REG9 value 7).
const RESP_PHASE_DEFAULT_32KHZ = 10;
const RESP_PHASE_DEFAULT_64KHZ = 7;

// --------------------------------------------------------------------------
// Knob table
// --------------------------------------------------------------------------

interface KnobSpec {
  /** Desktop GUI label (SensorEXG.GuiLabelConfig). */
  label: string;
  /** Which banks this knob writes (for must-be re-application + docs). */
  banks: ReadonlyArray<'exg1' | 'exg2'>;
  /** Fixed option list, or undefined when it depends on the banks (phase). */
  options?: readonly ExgKnobOption[];
  /** Resolve the option list from the current banks (respiration phase). */
  dynamicOptions?: (banks: ExgBanks) => ExgKnobOption[];
  /** True when the edit is rejected unless chip-2 respiration is enabled. */
  requiresRespiration: boolean;
  /** Apply the (already-validated) value to a mutable clone of the banks. */
  apply: (banks: ExgBanks, value: number) => void;
}

/** Set the same field on both chip banks. */
function setBoth(
  banks: ExgBanks,
  field: Parameters<typeof setExgFieldPreserving>[1],
  value: number,
) {
  setExgFieldPreserving(banks.exg1, field, value);
  setExgFieldPreserving(banks.exg2, field, value);
}

/**
 * Port of SensorEXG.setEXGLeadOffCurrentMode for the two GUI-exposed modes
 * (Off=0, DC Current=1). AC current (mode 2) and the three-unipolar branch are
 * descoped (docs/handoff/13 EX4); the bipolar branch is used for DC.
 */
function applyLeadOffDetection(banks: ExgBanks, mode: number): void {
  const isEmg = detectExgPreset(banks.exg1, banks.exg2) === 'emg';
  if (mode === 0) {
    // OFF — SensorEXG.java:2496-2507.
    setBoth(banks, 'leadOffFrequency', 0); // DC
    setBoth(banks, 'leadOffComparators', 0); // OFF
    setExgFieldPreserving(banks.exg1, 'rldLeadOffSenseFunction', 0);
    setBoth(banks, 'ch2LeadOffDetectNegInputs', 0);
    setBoth(banks, 'ch2LeadOffDetectPosInputs', 0);
    setBoth(banks, 'ch1LeadOffDetectNegInputs', 0);
    setBoth(banks, 'ch1LeadOffDetectPosInputs', 0);
    // EMG: power down chip-2 CH2 again (only powered up for lead-off).
    if (isEmg) setExgFieldPreserving(banks.exg2, 'ch2PowerDown', 1);
    return;
  }
  // DC Current — SensorEXG.java:2508-2545 (bipolar / non-unipolar branch).
  // Chip 1.
  setExgFieldPreserving(banks.exg1, 'leadOffFrequency', 0); // DC
  setExgFieldPreserving(banks.exg1, 'leadOffComparators', 1); // ON
  setExgFieldPreserving(banks.exg1, 'rldLeadOffSenseFunction', 1); // ON
  setExgFieldPreserving(banks.exg1, 'ch2LeadOffDetectNegInputs', 0);
  setExgFieldPreserving(banks.exg1, 'ch2LeadOffDetectPosInputs', 1);
  setExgFieldPreserving(banks.exg1, 'ch1LeadOffDetectNegInputs', 1);
  setExgFieldPreserving(banks.exg1, 'ch1LeadOffDetectPosInputs', 1);
  setExgFieldPreserving(banks.exg1, 'leadOffCurrent', 1); // 22 nA
  setExgFieldPreserving(banks.exg1, 'comparatorThreshold', 2); // Pos90/Neg10
  // Chip 2 (always present in the docked two-bank model — isTwoChipExg true).
  setExgFieldPreserving(banks.exg2, 'leadOffFrequency', 0);
  setExgFieldPreserving(banks.exg2, 'leadOffComparators', 1);
  setExgFieldPreserving(banks.exg2, 'ch2LeadOffDetectNegInputs', 0);
  setExgFieldPreserving(banks.exg2, 'ch2LeadOffDetectPosInputs', 1);
  setExgFieldPreserving(banks.exg2, 'ch1LeadOffDetectNegInputs', 0);
  setExgFieldPreserving(banks.exg2, 'ch1LeadOffDetectPosInputs', 0);
  setExgFieldPreserving(banks.exg2, 'leadOffCurrent', 1);
  setExgFieldPreserving(banks.exg2, 'comparatorThreshold', 2);
  // EMG: power up chip-2 CH2 so it can carry the lead-off measurement.
  if (isEmg) setExgFieldPreserving(banks.exg2, 'ch2PowerDown', 0);
}

/** The complete editable-knob registry. */
export const EXG_KNOBS: Readonly<Record<ExgKnobField, KnobSpec>> = Object.freeze({
  exg1Ch1Gain: {
    label: 'Gain (EXG1 CH1)',
    banks: ['exg1'],
    options: GAIN_OPTIONS,
    requiresRespiration: false,
    apply: (b, v) => setExgFieldPreserving(b.exg1, 'ch1Gain', v),
  },
  exg1Ch2Gain: {
    label: 'Gain (EXG1 CH2)',
    banks: ['exg1'],
    options: GAIN_OPTIONS,
    requiresRespiration: false,
    apply: (b, v) => setExgFieldPreserving(b.exg1, 'ch2Gain', v),
  },
  exg2Ch1Gain: {
    label: 'Gain (EXG2 CH1)',
    banks: ['exg2'],
    options: GAIN_OPTIONS,
    requiresRespiration: false,
    apply: (b, v) => setExgFieldPreserving(b.exg2, 'ch1Gain', v),
  },
  exg2Ch2Gain: {
    label: 'Gain (EXG2 CH2)',
    banks: ['exg2'],
    options: GAIN_OPTIONS,
    requiresRespiration: false,
    apply: (b, v) => setExgFieldPreserving(b.exg2, 'ch2Gain', v),
  },
  dataRate: {
    label: 'ExG Rate',
    banks: ['exg1', 'exg2'],
    options: DATA_RATE_OPTIONS,
    requiresRespiration: false,
    apply: (b, v) => setBoth(b, 'dataRate', v),
  },
  referenceElectrode: {
    label: 'Reference Electrode',
    banks: ['exg1'],
    options: REFERENCE_ELECTRODE_OPTIONS,
    requiresRespiration: false,
    // setEXGReferenceElectrode (SensorEXG.java:2483-2489): the value is a REG6
    // low-nibble routing code; spread its bits over the four CHIP1 RLD-input
    // fields (bit3→CH2 neg, bit2→CH2 pos, bit1→CH1 neg, bit0→CH1 pos).
    apply: (b, v) => {
      setExgFieldPreserving(b.exg1, 'ch2RldNegInputs', (v & 0x08) === 0x08 ? 1 : 0);
      setExgFieldPreserving(b.exg1, 'ch2RldPosInputs', (v & 0x04) === 0x04 ? 1 : 0);
      setExgFieldPreserving(b.exg1, 'ch1RldNegInputs', (v & 0x02) === 0x02 ? 1 : 0);
      setExgFieldPreserving(b.exg1, 'ch1RldPosInputs', (v & 0x01) === 0x01 ? 1 : 0);
    },
  },
  leadOffDetection: {
    label: 'Lead-Off Detection',
    banks: ['exg1', 'exg2'],
    options: LEAD_OFF_DETECTION_OPTIONS,
    requiresRespiration: false,
    apply: applyLeadOffDetection,
  },
  leadOffCurrent: {
    label: 'Lead-Off Current',
    banks: ['exg1', 'exg2'],
    options: LEAD_OFF_CURRENT_OPTIONS,
    requiresRespiration: false,
    apply: (b, v) => setBoth(b, 'leadOffCurrent', v),
  },
  leadOffComparatorThreshold: {
    label: 'Lead-Off Comparator Threshold',
    banks: ['exg1', 'exg2'],
    options: LEAD_OFF_COMPARATOR_OPTIONS,
    requiresRespiration: false,
    apply: (b, v) => setBoth(b, 'comparatorThreshold', v),
  },
  respirationEnable: {
    label: 'Respiration',
    banks: ['exg2'],
    options: ON_OFF_OPTIONS,
    // This IS the gate toggle — never gated on itself.
    requiresRespiration: false,
    apply: (b, v) => {
      setExgFieldPreserving(b.exg2, 'respirationDemodCircuitry', v);
      setExgFieldPreserving(b.exg2, 'respirationModCircuitry', v);
    },
  },
  respirationFrequency: {
    label: 'Respiration Detection Freq',
    banks: ['exg2'],
    options: RESPIRATION_FREQUENCY_OPTIONS,
    requiresRespiration: true,
    // setEXG2RespirationDetectFreq (SensorEXG.java:2618-2628): set the frequency,
    // then FORCE the phase to that frequency's canonical default.
    apply: (b, v) => {
      setExgFieldPreserving(b.exg2, 'respirationControlFrequency', v);
      setExgFieldPreserving(
        b.exg2,
        'respirationPhase',
        v === 0 ? RESP_PHASE_DEFAULT_32KHZ : RESP_PHASE_DEFAULT_64KHZ,
      );
    },
  },
  respirationPhase: {
    label: 'Respiration Detection Phase',
    banks: ['exg2'],
    dynamicOptions: (b) =>
      respirationPhaseOptions(readExgField(b.exg2, 'respirationControlFrequency')),
    requiresRespiration: true,
    apply: (b, v) => setExgFieldPreserving(b.exg2, 'respirationPhase', v),
  },
});

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * The current legal option list for a knob, given the banks (needed for the
 * respiration phase list, which follows the current detection frequency).
 *
 * @throws UnknownExgKnobError for an unrecognised field.
 */
export function exgKnobOptions(field: ExgKnobField, banks: ExgBanks): ExgKnobOption[] {
  const spec = EXG_KNOBS[field];
  if (!spec) throw new UnknownExgKnobError(field);
  if (spec.dynamicOptions) return spec.dynamicOptions(banks);
  return [...(spec.options ?? [])];
}

/** True when chip-2 respiration (both demod + mod circuits) is enabled. */
export function isExgRespirationEnabled(banks: ExgBanks): boolean {
  return (
    readExgField(banks.exg2, 'respirationDemodCircuitry') === 1 &&
    readExgField(banks.exg2, 'respirationModCircuitry') === 1
  );
}

/**
 * Set ONE knob to `value`, returning NEW banks with the field changed, the
 * must-be bits re-enforced, and every other bit preserved. Pure — the inputs
 * are not mutated.
 *
 * Respiration contract: `respirationFrequency` and `respirationPhase` are
 * REJECTED (throw {@link ExgRespirationLockedError}) unless chip-2 respiration
 * is enabled — matching the desktop, which greys these knobs out until the
 * respiration sensor is on (PanelAdvancedExG.java:340,357-361,416-420). The
 * app disables the corresponding controls, so this throw is a backstop rather
 * than a normal path. `respirationEnable` is the toggle itself and is never
 * gated.
 *
 * Phase/frequency coupling: setting `respirationFrequency` also auto-remaps the
 * phase to that frequency's canonical default (112.5° at 32 kHz, 157.5° at
 * 64 kHz), so the stored phase is never left illegal for the new frequency
 * (matches SensorEXG.setEXG2RespirationDetectFreq). Setting `respirationPhase`
 * directly to a value that is illegal for the CURRENT frequency throws
 * {@link ExgKnobValueError}.
 *
 * @throws RangeError when a bank is not 10 bytes.
 * @throws UnknownExgKnobError for an unrecognised field.
 * @throws ExgKnobValueError when the value is not a legal option.
 * @throws ExgRespirationLockedError for a locked respiration edit.
 */
export function updateExgSetting(banks: ExgBanks, field: ExgKnobField, value: number): ExgBanks {
  assertBanks(banks);
  const spec = EXG_KNOBS[field];
  if (!spec) throw new UnknownExgKnobError(field);

  if (spec.requiresRespiration && !isExgRespirationEnabled(banks)) {
    throw new ExgRespirationLockedError(field);
  }

  const options = spec.dynamicOptions ? spec.dynamicOptions(banks) : (spec.options ?? []);
  if (!options.some((o) => o.value === value)) {
    throw new ExgKnobValueError(
      field,
      value,
      options.map((o) => o.value),
    );
  }

  const next: ExgBanks = {
    exg1: Uint8Array.from(banks.exg1),
    exg2: Uint8Array.from(banks.exg2),
  };
  spec.apply(next, value);

  // Re-enforce must-be bits on every bank this knob touched.
  if (spec.banks.includes('exg1')) applyExgMustBeBits(next.exg1);
  if (spec.banks.includes('exg2')) applyExgMustBeBits(next.exg2);
  return next;
}

/**
 * Apply a batch of knob edits in order, threading each edit's result into the
 * next. Later edits win over earlier ones, and each edit sees the banks as left
 * by the previous (so e.g. a `respirationEnable: 1` edit can precede — and
 * unlock — a `respirationPhase` edit in the same batch). Pure.
 *
 * @throws the same typed errors as {@link updateExgSetting}, on the first
 * offending edit.
 */
export function applyExgKnobEdits(banks: ExgBanks, edits: readonly ExgKnobEdit[]): ExgBanks {
  assertBanks(banks);
  let acc: ExgBanks = {
    exg1: Uint8Array.from(banks.exg1),
    exg2: Uint8Array.from(banks.exg2),
  };
  for (const edit of edits) {
    acc = updateExgSetting(acc, edit.field, edit.value);
  }
  return acc;
}

/**
 * Read the current value of every knob out of a pair of banks — the inverse of
 * a full set. Handy for seeding an editor from the device's current config and
 * for round-trip tests. The respiration-enable and lead-off-detection knobs are
 * derived (they are macros over several bits), everything else reads its field.
 */
export function readExgKnobs(banks: ExgBanks): Record<ExgKnobField, number> {
  assertBanks(banks);
  const d1 = decodeExgRegisters(banks.exg1);
  const d2 = decodeExgRegisters(banks.exg2);
  return {
    exg1Ch1Gain: d1.ch1.gain.value,
    exg1Ch2Gain: d1.ch2.gain.value,
    exg2Ch1Gain: d2.ch1.gain.value,
    exg2Ch2Gain: d2.ch2.gain.value,
    dataRate: d1.dataRate.value,
    referenceElectrode: banks.exg1[5] & 0x0f,
    // Detection is "on" (DC=1) when the CHIP1 comparators + RLD sense are on.
    leadOffDetection: d1.leadOff.detectionEnabled ? 1 : 0,
    leadOffCurrent: d1.leadOff.current.value,
    leadOffComparatorThreshold: d1.leadOff.comparatorThreshold.value,
    respirationEnable: isExgRespirationEnabled(banks) ? 1 : 0,
    respirationFrequency: d2.respiration.frequency.value,
    respirationPhase: d2.respiration.phase.value,
  };
}
