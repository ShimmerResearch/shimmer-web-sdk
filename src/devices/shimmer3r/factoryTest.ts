/**
 * The Shimmer3/Shimmer3R factory self-test: the type table and the two
 * LiteProtocol helpers a Bluetooth client needs to drive it.
 *
 * `SET_FACTORY_TEST` (0xA8, `Comms/shimmer_bt_uart.h:210`, one argument byte per
 * the command's entry in the argument table at `:695`, handler at
 * `Comms/shimmer_bt_uart.c:1285-1293`) selects one of the four suites the
 * firmware runs at the factory. Everything in this module is pure — the runner
 * itself lives in `../factoryTest/capture.ts` and the clients.
 *
 * The suites are shared between the two families: `log-and-stream-common` is
 * built into both the Shimmer3 (MSP430) and Shimmer3R (STM32) firmware, so the
 * type numbering, the ACK-then-report sequence and the report envelope are the
 * same on either. The bodies differ — only the Shimmer3R prints test IDs.
 */

import type { AckVerdict } from '../factoryTest/capture.js';
import { OPCODES } from './constants.js';

/**
 * The factory-test types, exactly as the firmware enumerates them
 * (`Test/shimmer_test.h:21-27`). A type of 4 or more is silently ACKed and
 * produces NO report, which is why {@link requireShimmer3FactoryTestType}
 * refuses it rather than letting a caller wait out a timeout for a report the
 * firmware was never going to print.
 */
export const SHIMMER3_FACTORY_TEST_TYPE = Object.freeze({
  /** Everything: the IC suite, the LED walk-through and an overall verdict. */
  MAIN: 0,
  /** The LEDs only — nothing to pass or fail, so no overall verdict. */
  LEDS: 1,
  /** The ICs only, with an overall verdict. */
  ICS: 2,
  /** The operational LED-state walk-through — again no overall verdict. */
  LED_STATES: 3,
} as const);

/** A factory-test type value (0–3). */
export type Shimmer3FactoryTestType =
  (typeof SHIMMER3_FACTORY_TEST_TYPE)[keyof typeof SHIMMER3_FACTORY_TEST_TYPE];

/** Everything a host needs to offer one factory-test type in a UI. */
export interface Shimmer3FactoryTestTypeInfo {
  /** The argument byte for `SET_FACTORY_TEST`. */
  readonly value: number;
  /** The firmware's own enumerator name. */
  readonly name: 'MAIN' | 'LEDS' | 'ICS' | 'LED_STATES';
  /** Short human label for a picker. */
  readonly label: string;
  /** One sentence explaining what the sensor will do. */
  readonly description: string;
  /**
   * Roughly how long the suite takes. The firmware's main loop is blocked for
   * the whole of it, so this is also how long the link is unusable.
   */
  readonly expectedDurationMs: number;
  /** Default overall budget for a run of this type — comfortably past the expected duration. */
  readonly defaultTimeoutMs: number;
  /** Whether the report ends with an `Overall Result =` line. */
  readonly hasOverall: boolean;
}

/**
 * The four types in firmware order.
 *
 * The durations are the firmware's own step counts, not measurements: the LED
 * suite is 9 steps of 2 s, and the operational-state walk-through holds 15
 * states for 5 s each — 2 with Bluetooth disabled, 6 with it enabled, 5 under
 * SD sync and 2 others, one `platform_delayMs` apiece
 * (`Test/shimmer_test_leds_states.c`). The IC suite's chip probes dominate
 * MAIN. HARDWARE-VERIFY: they have not been timed on a real Shimmer3 or
 * Shimmer3R, so the default timeouts carry generous headroom over them.
 */
export const SHIMMER3_FACTORY_TEST_TYPES: readonly Shimmer3FactoryTestTypeInfo[] = Object.freeze([
  Object.freeze({
    value: SHIMMER3_FACTORY_TEST_TYPE.MAIN,
    name: 'MAIN' as const,
    label: 'Everything (MAIN)',
    description: 'Probes every chip, walks the LEDs and ends with an overall pass/fail verdict.',
    expectedDurationMs: 35_000,
    defaultTimeoutMs: 90_000,
    hasOverall: true,
  }),
  Object.freeze({
    value: SHIMMER3_FACTORY_TEST_TYPE.LEDS,
    name: 'LEDS' as const,
    label: 'LEDs only',
    description:
      'Lights each LED in turn for two seconds. Meant to be watched — there is no overall verdict.',
    expectedDurationMs: 18_000,
    defaultTimeoutMs: 45_000,
    hasOverall: false,
  }),
  Object.freeze({
    value: SHIMMER3_FACTORY_TEST_TYPE.ICS,
    name: 'ICS' as const,
    label: 'Chips only (ICs)',
    description:
      'Probes the sensor, memory and radio chips and ends with an overall pass/fail verdict.',
    expectedDurationMs: 15_000,
    defaultTimeoutMs: 60_000,
    hasOverall: true,
  }),
  Object.freeze({
    value: SHIMMER3_FACTORY_TEST_TYPE.LED_STATES,
    name: 'LED_STATES' as const,
    label: 'LED operating states',
    description:
      'Holds each operational LED state for five seconds so it can be compared against the sensor. ' +
      'No overall verdict, and the longest of the four.',
    expectedDurationMs: 75_000,
    defaultTimeoutMs: 120_000,
    hasOverall: false,
  }),
]);

/** Look up a type's table entry, or `null` when the value is not one of the four. */
export function shimmer3FactoryTestTypeInfo(value: number): Shimmer3FactoryTestTypeInfo | null {
  return SHIMMER3_FACTORY_TEST_TYPES.find((t) => t.value === value) ?? null;
}

/**
 * Look up a type's table entry, or throw.
 *
 * @throws RangeError when `value` is not 0–3. The firmware ACKs a larger type
 *   and then prints nothing at all (`Test/shimmer_test.h:21-27`), so a run with
 *   one would hang until its timeout with no way to tell it from a dead link.
 */
export function requireShimmer3FactoryTestType(value: number): Shimmer3FactoryTestTypeInfo {
  const info = shimmer3FactoryTestTypeInfo(value);
  if (!info) {
    const known = SHIMMER3_FACTORY_TEST_TYPES.map((t) => `${t.value} ${t.name}`).join(', ');
    throw new RangeError(
      `Unknown factory-test type ${value}. The firmware defines ${known}; ` +
        'anything else is acknowledged and then prints no report.',
    );
  }
  return info;
}

/** Build the two-byte `SET_FACTORY_TEST` command for a type. */
export function buildSetFactoryTestCommand(type: number): Uint8Array {
  const info = requireShimmer3FactoryTestType(type);
  return new Uint8Array([OPCODES.SET_FACTORY_TEST, info.value]);
}

/**
 * Classify the head of a LiteProtocol chunk during a factory-test run.
 *
 * The firmware answers the command with the generic one-byte ACK (0xFF) or NACK
 * (0xFE) and then prints the report as bare ASCII on the same link, so anything
 * that is not one of those two bytes is already report text. Both answers are
 * one byte, so this never needs more.
 */
export function classifyLiteProtocolAck(buf: Uint8Array): AckVerdict {
  if (buf.length === 0) return { kind: 'need-more' };
  if (buf[0] === OPCODES.ACK_COMMAND_PROCESSED) return { kind: 'ack', consumed: 1 };
  if (buf[0] === OPCODES.NACK_COMMAND_PROCESSED) {
    return { kind: 'nack', consumed: 1, detail: 'NACK 0xFE' };
  }
  return { kind: 'text' };
}
