/**
 * ADS1292R (EXG) register-bank codec — decode a 10-byte per-chip register
 * bank into structured, human-readable settings and encode it back, enforcing
 * the hardware "must-be" bits.
 *
 * Pure port of the Java oracle:
 *   - decode           : ShimmerObject.exgBytesGetConfigFrom
 *                        (ShimmerObject.java:6894-6940)
 *   - field bit-layout : ExGConfigBytesDetails.mMapOfExGSettingsChip1
 *                        (ExGConfigBytesDetails.java:369-451) — every field's
 *                        byteIndex / bitShift / mask
 *   - encode           : ExGConfigBytesDetails.generateExgByteArray
 *                        (ExGConfigBytesDetails.java:487-502)
 *   - must-be bits     : ExGConfigBytesDetails.setExgByteArrayConstants
 *                        (ExGConfigBytesDetails.java:507-525)
 *   - option labels    : SensorEXG.java:116-149 (GUI value lists) and the
 *                        EXG_SETTING_OPTIONS enums (ExGConfigBytesDetails.java:116-360)
 *   - gain value map   : SensorEXG.convertEXGGainSettingToValue
 *                        (SensorEXG.java:2637)
 *
 * Resolution (16- vs 24-bit) is NOT a register field — it lives in the sensor
 * bitmap. See {@link exgResolutionFromSensors} in ./presets.ts
 * (ShimmerObject.checkExgResolutionFromEnabledSensorsVar, :7255-7279).
 */

/** Number of register bytes in one ADS1292R chip bank (InfoMem EXG_BANK_LENGTH). */
export const EXG_BANK_LENGTH = 10;

// --------------------------------------------------------------------------
// Option label lists (verbatim from the Java oracle; the array index is the
// register field's config value).
// --------------------------------------------------------------------------

/** REG1 conversion mode (ExGConfigBytesDetails.java:119-120). */
export const CONVERSION_MODE_LABELS = ['Continuous Conversion Mode', 'Single-shot mode'] as const;
/** REG1 data rate 0-6 (SensorEXG.java:148 ListOfExGRate). */
export const DATA_RATE_LABELS = [
  '125 Hz',
  '250 Hz',
  '500 Hz',
  '1 kHz',
  '2 kHz',
  '4 kHz',
  '8 kHz',
] as const;
/** REG2 voltage reference (ExGConfigBytesDetails.java:142-143). */
export const VOLTAGE_REFERENCE_LABELS = ['2.42 V', '4.033 V'] as const;
/** REG2 test-signal frequency (ExGConfigBytesDetails.java:154-155). */
export const TEST_SIGNAL_FREQUENCY_LABELS = ['DC', '1 kHz Square Wave'] as const;
/** REG3 lead-off comparator threshold 0-7 (SensorEXG.java:136). */
export const COMPARATOR_THRESHOLD_LABELS = [
  'Pos:95%-Neg:5%',
  'Pos:92.5%-Neg:7.5%',
  'Pos:90%-Neg:10%',
  'Pos:87.5%-Neg:12.5%',
  'Pos:85%-Neg:15%',
  'Pos:80%-Neg:20%',
  'Pos:75%-Neg:25%',
  'Pos:70%-Neg:30%',
] as const;
/** REG3 lead-off current 0-3 (SensorEXG.java:134). */
export const LEAD_OFF_CURRENT_LABELS = ['6 nA', '22 nA', '6 uA', '22 uA'] as const;
/** REG3 lead-off frequency (ExGConfigBytesDetails.java:177-178). */
export const LEAD_OFF_FREQUENCY_LABELS = [
  'DC lead-off detect',
  'AC lead-off detect (fs / 4)',
] as const;
/** REG4/REG5 PGA gain setting 0-6 → GUI label (SensorEXG.java:116 ListOfExGGain). */
export const GAIN_LABELS = ['6', '1', '2', '3', '4', '8', '12'] as const;
/** REG4/REG5 PGA gain setting 0-6 → numeric gain (SensorEXG.convertEXGGainSettingToValue, :2637). */
export const GAIN_VALUES = [6, 1, 2, 3, 4, 8, 12] as const;
/** REG4/REG5 channel power-down (ExGConfigBytesDetails.java:184-185). */
export const POWER_DOWN_LABELS = ['Normal operation', 'Power-down'] as const;
/** REG4/REG5 input selection 0-9 (ExGConfigBytesDetails.java:196-234). */
export const INPUT_SELECTION_LABELS = [
  'Normal electrode input',
  'Input shorted',
  'RLD_MEASURE',
  'Supply measurement',
  'Temperature sensor',
  'Test signal',
  'RLD_DRP (positive side connected to RLDIN)',
  'RLD_DRM (negative side connected to RLDIN)',
  'RLD_DRPM (both connected to RLDIN)',
  'Route IN3P/IN3N to channel 1 inputs',
] as const;
/** REG6 PGA chop frequency (ExGConfigBytesDetails.java:240-242; value 1 is reserved). */
export const CHOP_FREQUENCY_LABELS = ['fMOD / 16', 'reserved', 'fMOD / 2', 'fMOD / 4'] as const;
/** REG9 respiration phase at 32 kHz, 0-15 (SensorEXG.java:143). */
export const RESPIRATION_PHASE_32KHZ_LABELS = [
  '0°',
  '11.25°',
  '22.5°',
  '33.75°',
  '45°',
  '56.25°',
  '67.5°',
  '78.75°',
  '90°',
  '101.25°',
  '112.5°',
  '123.75°',
  '135°',
  '146.25°',
  '157.5°',
  '168.75°',
] as const;
/** REG9 respiration phase at 64 kHz, 0-7 (SensorEXG.java:145). */
export const RESPIRATION_PHASE_64KHZ_LABELS = [
  '0°',
  '22.5°',
  '45°',
  '67.5°',
  '90°',
  '112.5°',
  '135°',
  '157.5°',
] as const;
/** REG10 respiration control frequency (SensorEXG.java:140). */
export const RESPIRATION_FREQUENCY_LABELS = ['32 kHz', '64 kHz'] as const;
/** REG10 RLD reference signal (ExGConfigBytesDetails.java:357-358). */
export const RLD_REFERENCE_SIGNAL_LABELS = ['Fed externally', '(AVDD - AVSS) / 2'] as const;
/** REG9 respiration control clock (ExGConfigBytesDetails.java:342-343). */
export const RESPIRATION_CONTROL_LABELS = ['Internal clock', 'External Clock'] as const;

/**
 * Lead-off detection mode (the "Lead-Off Detection" GUI knob). The GUI exposes
 * only Off / DC Current (SensorEXG.ListOfExGLeadOffDetection, SensorEXG.java:132);
 * the setter also supports an AC-current mode (value 2) which the GUI does not
 * offer (see the knob helpers in ./knobs.ts).
 */
export const LEAD_OFF_DETECTION_LABELS = ['Off', 'DC Current'] as const;

const ON_OFF = ['Off', 'On'] as const;

/**
 * Reference-electrode config value → label (byte5 & 0x0F). The four
 * meaningful values come from ListOfExGReferenceElectrodeConfigValuesAll
 * {0,3,13,7} (SensorEXG.java:123-124); any other value is reported as custom.
 */
const REFERENCE_ELECTRODE_LABELS: Record<number, string> = {
  0: 'Fixed Potential',
  3: 'Inverse of Ch1',
  13: 'Inverse Wilson CT',
  7: '3-Ch Single-ended',
};

/**
 * Reference-electrode options as `{ value, label }`, verbatim from the Java
 * "All" list ListOfExGReferenceElectrodeAll / …ConfigValuesAll
 * (SensorEXG.java:123-124): Fixed Potential (0), Inverse of Ch1 (3), Inverse
 * Wilson CT (13), 3-Ch Single-ended (7). The value is the REG6 low-nibble RLD
 * input-routing code, NOT an index — see setEXGReferenceElectrode
 * (SensorEXG.java:2483-2489). The 3-Ch single-ended entry is kept for data
 * fidelity but EX4 builds no special UI for it (docs/handoff/13 EX4 descope).
 */
export const REFERENCE_ELECTRODE_OPTIONS: ReadonlyArray<{ value: number; label: string }> =
  Object.freeze([
    { value: 0, label: 'Fixed Potential' },
    { value: 3, label: 'Inverse of Ch1' },
    { value: 13, label: 'Inverse Wilson CT' },
    { value: 7, label: '3-Ch Single-ended' },
  ]);

// --------------------------------------------------------------------------
// Field bit-layout table — the sole source of truth for both decode and
// encode, keeping the two directions symmetric (ExGConfigBytesDetails.java:369-451).
// --------------------------------------------------------------------------

interface FieldSpec {
  byteIndex: number;
  bitShift: number;
  mask: number;
}

/** Every ADS1292R register field, keyed by a stable name. */
const FIELDS = {
  conversionMode: { byteIndex: 0, bitShift: 7, mask: 0x01 },
  dataRate: { byteIndex: 0, bitShift: 0, mask: 0x07 },

  leadOffComparators: { byteIndex: 1, bitShift: 6, mask: 0x01 },
  referenceBuffer: { byteIndex: 1, bitShift: 5, mask: 0x01 },
  voltageReference: { byteIndex: 1, bitShift: 4, mask: 0x01 },
  oscillatorClockConnection: { byteIndex: 1, bitShift: 3, mask: 0x01 },
  testSignalSelection: { byteIndex: 1, bitShift: 1, mask: 0x01 },
  testSignalFrequency: { byteIndex: 1, bitShift: 0, mask: 0x01 },

  comparatorThreshold: { byteIndex: 2, bitShift: 5, mask: 0x07 },
  leadOffCurrent: { byteIndex: 2, bitShift: 2, mask: 0x03 },
  leadOffFrequency: { byteIndex: 2, bitShift: 0, mask: 0x01 },

  ch1PowerDown: { byteIndex: 3, bitShift: 7, mask: 0x01 },
  ch1Gain: { byteIndex: 3, bitShift: 4, mask: 0x07 },
  ch1InputSelection: { byteIndex: 3, bitShift: 0, mask: 0x0f },

  ch2PowerDown: { byteIndex: 4, bitShift: 7, mask: 0x01 },
  ch2Gain: { byteIndex: 4, bitShift: 4, mask: 0x07 },
  ch2InputSelection: { byteIndex: 4, bitShift: 0, mask: 0x0f },

  chopFrequency: { byteIndex: 5, bitShift: 6, mask: 0x03 },
  rldBufferPower: { byteIndex: 5, bitShift: 5, mask: 0x01 },
  rldLeadOffSenseFunction: { byteIndex: 5, bitShift: 4, mask: 0x01 },
  ch2RldNegInputs: { byteIndex: 5, bitShift: 3, mask: 0x01 },
  ch2RldPosInputs: { byteIndex: 5, bitShift: 2, mask: 0x01 },
  ch1RldNegInputs: { byteIndex: 5, bitShift: 1, mask: 0x01 },
  ch1RldPosInputs: { byteIndex: 5, bitShift: 0, mask: 0x01 },

  ch2FlipCurrent: { byteIndex: 6, bitShift: 5, mask: 0x01 },
  ch1FlipCurrent: { byteIndex: 6, bitShift: 4, mask: 0x01 },
  ch2LeadOffDetectNegInputs: { byteIndex: 6, bitShift: 3, mask: 0x01 },
  ch2LeadOffDetectPosInputs: { byteIndex: 6, bitShift: 2, mask: 0x01 },
  ch1LeadOffDetectNegInputs: { byteIndex: 6, bitShift: 1, mask: 0x01 },
  ch1LeadOffDetectPosInputs: { byteIndex: 6, bitShift: 0, mask: 0x01 },

  clockDividerSelection: { byteIndex: 7, bitShift: 6, mask: 0x01 },
  rldLeadOffStatus: { byteIndex: 7, bitShift: 4, mask: 0x01 },
  ch2NegElectrodeStatus: { byteIndex: 7, bitShift: 3, mask: 0x01 },
  ch2PosElectrodeStatus: { byteIndex: 7, bitShift: 2, mask: 0x01 },
  ch1NegElectrodeStatus: { byteIndex: 7, bitShift: 1, mask: 0x01 },
  ch1PosElectrodeStatus: { byteIndex: 7, bitShift: 0, mask: 0x01 },

  respirationDemodCircuitry: { byteIndex: 8, bitShift: 7, mask: 0x01 },
  respirationModCircuitry: { byteIndex: 8, bitShift: 6, mask: 0x01 },
  respirationPhase: { byteIndex: 8, bitShift: 2, mask: 0x0f },
  respirationControl: { byteIndex: 8, bitShift: 0, mask: 0x01 },

  respirationCalibration: { byteIndex: 9, bitShift: 7, mask: 0x01 },
  respirationControlFrequency: { byteIndex: 9, bitShift: 2, mask: 0x01 },
  rldReferenceSignal: { byteIndex: 9, bitShift: 1, mask: 0x01 },
} as const satisfies Record<string, FieldSpec>;

type FieldName = keyof typeof FIELDS;

/**
 * The stable name of a single ADS1292R register field (the keys of the internal
 * bit-layout table). Exported so the per-knob edit layer (./knobs.ts) can
 * address individual fields by name and reuse this module's bit-layout as the
 * single source of truth, rather than duplicating byteIndex/shift/mask.
 */
export type ExgFieldName = FieldName;

/**
 * Read one register field's raw config value out of a 10-byte bank. Companion
 * to {@link setExgFieldPreserving}; both consult the internal bit-layout table.
 */
export function readExgField(bank: Uint8Array, name: ExgFieldName): number {
  return readField(bank, name);
}

/**
 * Write one register field's value into a 10-byte bank IN PLACE, clearing that
 * field's bits first so every OTHER bit in the byte is preserved (unlike the
 * encode-time {@link writeField}, which assumes a freshly zeroed bank and only
 * ORs bits in). This is the primitive the per-knob edit layer builds on: it lets
 * a single knob change exactly its field and leave the rest of the populated
 * bank untouched. Does NOT re-apply the must-be bits — callers do that once
 * after all field writes (see ./knobs.ts).
 */
export function setExgFieldPreserving(bank: Uint8Array, name: ExgFieldName, value: number): void {
  const f = FIELDS[name];
  const fieldMask = (f.mask << f.bitShift) & 0xff;
  bank[f.byteIndex] = ((bank[f.byteIndex] & ~fieldMask) | ((value & f.mask) << f.bitShift)) & 0xff;
}

/** A decoded register field: raw config value plus a human-readable label. */
export interface ExgFieldValue {
  /** Raw config value as read from the register bits. */
  value: number;
  /** Human-readable label from the Java GUI value lists. */
  label: string;
}

/** A decoded PGA-gain field with its numeric gain value. */
export interface ExgGainValue extends ExgFieldValue {
  /** Numeric PGA gain (6,1,2,3,4,8,12) — SensorEXG.convertEXGGainSettingToValue. */
  gain: number;
}

/** Per-channel (CH1/CH2) settings from REG4/REG5. */
export interface ExgChannelSettings {
  powerDown: ExgFieldValue;
  gain: ExgGainValue;
  inputSelection: ExgFieldValue;
}

/** Lead-off detection settings (REG2 comparator enable + REG3 + REG7 per-lead). */
export interface ExgLeadOffSettings {
  /** True when the lead-off comparators are powered on (REG2 bit6). */
  detectionEnabled: boolean;
  comparators: ExgFieldValue;
  current: ExgFieldValue;
  comparatorThreshold: ExgFieldValue;
  frequency: ExgFieldValue;
  ch1: { posInput: ExgFieldValue; negInput: ExgFieldValue; flipCurrent: ExgFieldValue };
  ch2: { posInput: ExgFieldValue; negInput: ExgFieldValue; flipCurrent: ExgFieldValue };
}

/** Respiration circuitry settings (REG9/REG10 — only meaningful on chip 2). */
export interface ExgRespirationSettings {
  /** True when both the modulation and demodulation circuits are on. */
  enabled: boolean;
  demod: ExgFieldValue;
  mod: ExgFieldValue;
  phase: ExgFieldValue;
  control: ExgFieldValue;
  calibration: ExgFieldValue;
  frequency: ExgFieldValue;
}

/** Right-leg-drive (RLD) routing (REG6 + REG10 reference). */
export interface ExgRldSettings {
  bufferPower: ExgFieldValue;
  leadOffSenseFunction: ExgFieldValue;
  chopFrequency: ExgFieldValue;
  referenceSignal: ExgFieldValue;
  ch1: { posInput: ExgFieldValue; negInput: ExgFieldValue };
  ch2: { posInput: ExgFieldValue; negInput: ExgFieldValue };
}

/** Test-signal settings (REG2). */
export interface ExgTestSignalSettings {
  enabled: ExgFieldValue;
  frequency: ExgFieldValue;
}

/** Read-only lead-off status bits (REG8). */
export interface ExgStatusBits {
  clockDivider: ExgFieldValue;
  rldLeadOff: ExgFieldValue;
  ch1PosElectrode: ExgFieldValue;
  ch1NegElectrode: ExgFieldValue;
  ch2PosElectrode: ExgFieldValue;
  ch2NegElectrode: ExgFieldValue;
}

/** Fully decoded ADS1292R register bank for one chip. */
export interface DecodedExgRegisters {
  conversionMode: ExgFieldValue;
  dataRate: ExgFieldValue;
  referenceBuffer: ExgFieldValue;
  voltageReference: ExgFieldValue;
  oscillatorClockConnection: ExgFieldValue;
  testSignal: ExgTestSignalSettings;
  /** CH1 settings (REG4). */
  ch1: ExgChannelSettings;
  /** CH2 settings (REG5). */
  ch2: ExgChannelSettings;
  /** Reference-electrode selection (byte5 & 0x0F, ShimmerObject.java:6912). */
  referenceElectrode: ExgFieldValue;
  leadOff: ExgLeadOffSettings;
  rld: ExgRldSettings;
  respiration: ExgRespirationSettings;
  /** Read-only status bits (REG8) — cleared on write by the must-be constants. */
  status: ExgStatusBits;
  /** The 10 raw register bytes this was decoded from. */
  raw: number[];
}

// --------------------------------------------------------------------------
// Decode
// --------------------------------------------------------------------------

function readField(bank: Uint8Array, name: FieldName): number {
  const f = FIELDS[name];
  return (bank[f.byteIndex] >> f.bitShift) & f.mask;
}

function labelled(value: number, labels: readonly string[]): ExgFieldValue {
  return { value, label: labels[value] ?? `Unknown (${value})` };
}

function onOff(value: number): ExgFieldValue {
  return { value, label: ON_OFF[value] ?? `Unknown (${value})` };
}

function gainField(value: number): ExgGainValue {
  return {
    value,
    label: GAIN_LABELS[value] ?? `Unknown (${value})`,
    gain: GAIN_VALUES[value] ?? -1,
  };
}

function channelSettings(bank: Uint8Array, chan: 1 | 2): ExgChannelSettings {
  const pd = chan === 1 ? 'ch1PowerDown' : 'ch2PowerDown';
  const gn = chan === 1 ? 'ch1Gain' : 'ch2Gain';
  const inp = chan === 1 ? 'ch1InputSelection' : 'ch2InputSelection';
  return {
    powerDown: labelled(readField(bank, pd), POWER_DOWN_LABELS),
    gain: gainField(readField(bank, gn)),
    inputSelection: labelled(readField(bank, inp), INPUT_SELECTION_LABELS),
  };
}

/**
 * Decode a single 10-byte ADS1292R register bank into structured settings.
 * Mirrors ShimmerObject.exgBytesGetConfigFrom (ShimmerObject.java:6894-6940)
 * combined with ExGConfigBytesDetails.updateFromRegisterArray (:528-539).
 *
 * @throws RangeError when the bank is not exactly 10 bytes.
 */
export function decodeExgRegisters(bank: Uint8Array): DecodedExgRegisters {
  if (bank.length !== EXG_BANK_LENGTH) {
    throw new RangeError(
      `EXG register bank must be exactly ${EXG_BANK_LENGTH} bytes, got ${bank.length}.`,
    );
  }

  const respFreqValue = readField(bank, 'respirationControlFrequency');
  const phaseValue = readField(bank, 'respirationPhase');
  // Phase label depends on the detection frequency (16 options @32 kHz, 8 @64 kHz)
  // — SensorEXG.java:143-146, PanelAdvancedExG.java:555-556.
  const phaseLabels =
    respFreqValue === 0 ? RESPIRATION_PHASE_32KHZ_LABELS : RESPIRATION_PHASE_64KHZ_LABELS;

  const comparators = onOff(readField(bank, 'leadOffComparators'));
  const refElectrodeValue = bank[5] & 0x0f;

  return {
    conversionMode: labelled(readField(bank, 'conversionMode'), CONVERSION_MODE_LABELS),
    dataRate: labelled(readField(bank, 'dataRate'), DATA_RATE_LABELS),
    referenceBuffer: onOff(readField(bank, 'referenceBuffer')),
    voltageReference: labelled(readField(bank, 'voltageReference'), VOLTAGE_REFERENCE_LABELS),
    oscillatorClockConnection: onOff(readField(bank, 'oscillatorClockConnection')),
    testSignal: {
      enabled: onOff(readField(bank, 'testSignalSelection')),
      frequency: labelled(readField(bank, 'testSignalFrequency'), TEST_SIGNAL_FREQUENCY_LABELS),
    },
    ch1: channelSettings(bank, 1),
    ch2: channelSettings(bank, 2),
    referenceElectrode: {
      value: refElectrodeValue,
      label:
        REFERENCE_ELECTRODE_LABELS[refElectrodeValue] ??
        `Custom (0x${refElectrodeValue.toString(16)})`,
    },
    leadOff: {
      detectionEnabled: comparators.value === 1,
      comparators,
      current: labelled(readField(bank, 'leadOffCurrent'), LEAD_OFF_CURRENT_LABELS),
      comparatorThreshold: labelled(
        readField(bank, 'comparatorThreshold'),
        COMPARATOR_THRESHOLD_LABELS,
      ),
      frequency: labelled(readField(bank, 'leadOffFrequency'), LEAD_OFF_FREQUENCY_LABELS),
      ch1: {
        posInput: onOff(readField(bank, 'ch1LeadOffDetectPosInputs')),
        negInput: onOff(readField(bank, 'ch1LeadOffDetectNegInputs')),
        flipCurrent: onOff(readField(bank, 'ch1FlipCurrent')),
      },
      ch2: {
        posInput: onOff(readField(bank, 'ch2LeadOffDetectPosInputs')),
        negInput: onOff(readField(bank, 'ch2LeadOffDetectNegInputs')),
        flipCurrent: onOff(readField(bank, 'ch2FlipCurrent')),
      },
    },
    rld: {
      bufferPower: onOff(readField(bank, 'rldBufferPower')),
      leadOffSenseFunction: onOff(readField(bank, 'rldLeadOffSenseFunction')),
      chopFrequency: labelled(readField(bank, 'chopFrequency'), CHOP_FREQUENCY_LABELS),
      referenceSignal: labelled(readField(bank, 'rldReferenceSignal'), RLD_REFERENCE_SIGNAL_LABELS),
      ch1: {
        posInput: onOff(readField(bank, 'ch1RldPosInputs')),
        negInput: onOff(readField(bank, 'ch1RldNegInputs')),
      },
      ch2: {
        posInput: onOff(readField(bank, 'ch2RldPosInputs')),
        negInput: onOff(readField(bank, 'ch2RldNegInputs')),
      },
    },
    respiration: {
      enabled:
        readField(bank, 'respirationDemodCircuitry') === 1 &&
        readField(bank, 'respirationModCircuitry') === 1,
      demod: onOff(readField(bank, 'respirationDemodCircuitry')),
      mod: onOff(readField(bank, 'respirationModCircuitry')),
      phase: labelled(phaseValue, phaseLabels),
      control: labelled(readField(bank, 'respirationControl'), RESPIRATION_CONTROL_LABELS),
      calibration: onOff(readField(bank, 'respirationCalibration')),
      frequency: labelled(respFreqValue, RESPIRATION_FREQUENCY_LABELS),
    },
    status: {
      clockDivider: {
        value: readField(bank, 'clockDividerSelection'),
        label:
          readField(bank, 'clockDividerSelection') === 0 ? 'fMOD = fCLK / 4' : 'fMOD = fCLK / 16',
      },
      rldLeadOff: onOff(readField(bank, 'rldLeadOffStatus')),
      ch1PosElectrode: onOff(readField(bank, 'ch1PosElectrodeStatus')),
      ch1NegElectrode: onOff(readField(bank, 'ch1NegElectrodeStatus')),
      ch2PosElectrode: onOff(readField(bank, 'ch2PosElectrodeStatus')),
      ch2NegElectrode: onOff(readField(bank, 'ch2NegElectrodeStatus')),
    },
    raw: Array.from(bank),
  };
}

// --------------------------------------------------------------------------
// Encode
// --------------------------------------------------------------------------

const BIT = (n: number): number => 1 << n;

/**
 * Force the ADS1292R "must-be" bits listed in the datasheet, exactly as
 * ExGConfigBytesDetails.setExgByteArrayConstants (ExGConfigBytesDetails.java:507-525).
 * Mutates and returns the array.
 */
export function applyExgMustBeBits(bank: Uint8Array): Uint8Array {
  // CONFIG1 (0x00): reserved bits 3-6 cleared.
  bank[0] &= ~(BIT(6) | BIT(5) | BIT(4) | BIT(3)) & 0xff;
  // CONFIG2 (0x80): bit7 must be 1, bit2 must be 0.
  bank[1] |= BIT(7);
  bank[1] &= ~BIT(2) & 0xff;
  // LOFF (0x10): bit4 must be 1, bit1 must be 0.
  bank[2] |= BIT(4);
  bank[2] &= ~BIT(1) & 0xff;
  // LOFF_SENS (0x00): bits 6-7 cleared.
  bank[6] &= ~(BIT(7) | BIT(6)) & 0xff;
  // LOFF_STAT (0x00): read-only status bits cleared (only bit6 clock-div kept).
  bank[7] &= ~(BIT(7) | BIT(5) | BIT(4) | BIT(3) | BIT(2) | BIT(1) | BIT(0)) & 0xff;
  // RESP1 (0x02): bit1 must be 1.
  bank[8] |= BIT(1);
  // RESP2 (0x01): reserved bits 3-6 cleared, bit0 must be 1.
  bank[9] &= ~(BIT(6) | BIT(5) | BIT(4) | BIT(3)) & 0xff;
  bank[9] |= BIT(0);
  return bank;
}

function writeField(bank: Uint8Array, name: FieldName, value: number): void {
  const f = FIELDS[name];
  bank[f.byteIndex] |= (value & f.mask) << f.bitShift;
}

/**
 * Encode structured settings back into a 10-byte register bank, applying the
 * mandatory must-be bits. Inverse of {@link decodeExgRegisters}; mirrors
 * ExGConfigBytesDetails.generateExgByteArray (ExGConfigBytesDetails.java:487-502).
 *
 * A round-trip `encodeExgRegisters(decodeExgRegisters(bank))` reproduces
 * `bank` for any bank already satisfying the must-be bits (all Java presets do).
 */
export function encodeExgRegisters(settings: DecodedExgRegisters): Uint8Array {
  const bank = new Uint8Array(EXG_BANK_LENGTH);

  writeField(bank, 'conversionMode', settings.conversionMode.value);
  writeField(bank, 'dataRate', settings.dataRate.value);

  writeField(bank, 'leadOffComparators', settings.leadOff.comparators.value);
  writeField(bank, 'referenceBuffer', settings.referenceBuffer.value);
  writeField(bank, 'voltageReference', settings.voltageReference.value);
  writeField(bank, 'oscillatorClockConnection', settings.oscillatorClockConnection.value);
  writeField(bank, 'testSignalSelection', settings.testSignal.enabled.value);
  writeField(bank, 'testSignalFrequency', settings.testSignal.frequency.value);

  writeField(bank, 'comparatorThreshold', settings.leadOff.comparatorThreshold.value);
  writeField(bank, 'leadOffCurrent', settings.leadOff.current.value);
  writeField(bank, 'leadOffFrequency', settings.leadOff.frequency.value);

  writeField(bank, 'ch1PowerDown', settings.ch1.powerDown.value);
  writeField(bank, 'ch1Gain', settings.ch1.gain.value);
  writeField(bank, 'ch1InputSelection', settings.ch1.inputSelection.value);

  writeField(bank, 'ch2PowerDown', settings.ch2.powerDown.value);
  writeField(bank, 'ch2Gain', settings.ch2.gain.value);
  writeField(bank, 'ch2InputSelection', settings.ch2.inputSelection.value);

  writeField(bank, 'chopFrequency', settings.rld.chopFrequency.value);
  writeField(bank, 'rldBufferPower', settings.rld.bufferPower.value);
  writeField(bank, 'rldLeadOffSenseFunction', settings.rld.leadOffSenseFunction.value);
  writeField(bank, 'ch2RldNegInputs', settings.rld.ch2.negInput.value);
  writeField(bank, 'ch2RldPosInputs', settings.rld.ch2.posInput.value);
  writeField(bank, 'ch1RldNegInputs', settings.rld.ch1.negInput.value);
  writeField(bank, 'ch1RldPosInputs', settings.rld.ch1.posInput.value);

  writeField(bank, 'ch2FlipCurrent', settings.leadOff.ch2.flipCurrent.value);
  writeField(bank, 'ch1FlipCurrent', settings.leadOff.ch1.flipCurrent.value);
  writeField(bank, 'ch2LeadOffDetectNegInputs', settings.leadOff.ch2.negInput.value);
  writeField(bank, 'ch2LeadOffDetectPosInputs', settings.leadOff.ch2.posInput.value);
  writeField(bank, 'ch1LeadOffDetectNegInputs', settings.leadOff.ch1.negInput.value);
  writeField(bank, 'ch1LeadOffDetectPosInputs', settings.leadOff.ch1.posInput.value);

  // REG8 status bits are read-only — cleared by must-be (except clock divider).
  writeField(bank, 'clockDividerSelection', settings.status.clockDivider.value);

  writeField(bank, 'respirationDemodCircuitry', settings.respiration.demod.value);
  writeField(bank, 'respirationModCircuitry', settings.respiration.mod.value);
  writeField(bank, 'respirationPhase', settings.respiration.phase.value);
  writeField(bank, 'respirationControl', settings.respiration.control.value);

  writeField(bank, 'respirationCalibration', settings.respiration.calibration.value);
  writeField(bank, 'respirationControlFrequency', settings.respiration.frequency.value);
  writeField(bank, 'rldReferenceSignal', settings.rld.referenceSignal.value);

  return applyExgMustBeBits(bank);
}
