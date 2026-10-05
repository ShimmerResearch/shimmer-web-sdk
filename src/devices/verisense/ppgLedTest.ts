import { getVerisenseHardwareSensorSupport } from './hardwareModels.js';

/**
 * Why the MAX86xxx PPG LED test did not run.
 *
 * The distinction that matters on a factory line is `ppg-comms` versus
 * everything else: the LED test is judged by an operator looking at the board,
 * so a unit whose PPG bus is wedged lights no LEDs and reads as "PPG LEDs
 * dead". That misdiagnosis scraps a good board, which is what DEV-973 changed
 * the firmware to prevent and what this classification surfaces to the host.
 */
export type VerisensePpgLedTestFailureReason =
  /**
   * The device refused the command and the connected hardware is known to
   * carry a MAX86xxx, so the firmware reached the LED test and it failed —
   * a PPG comms failure (wedged or unreachable PPG I2C bus).
   *
   * Also used when the hardware revision is unknown: failing loud is the safe
   * direction here, because reporting "unsupported" on a real comms fault is
   * what leads to a good board being scrapped.
   */
  | 'ppg-comms'
  /**
   * The device refused the command and the connected hardware carries no PPG
   * front end, so the firmware never reached the LED test. Not a unit fault.
   */
  | 'not-supported'
  /** No reply within the command timeout — link problem, not a PPG verdict. */
  | 'no-response'
  /** Anything else the transport raised. */
  | 'unknown';

/**
 * A MAX86xxx PPG LED-test failure, tagged with a machine-readable reason.
 *
 * Mirrors the {@link FactoryTestError} pattern: callers switch on `reason`
 * rather than pattern-matching a message string.
 */
export class VerisensePpgLedTestError extends Error {
  readonly reason: VerisensePpgLedTestFailureReason;
  /**
   * Whether the connected hardware is known to carry a PPG front end:
   * `true`/`false` when the production config was readable, `null` when the
   * hardware revision could not be established.
   */
  readonly hardwarePpgSupport: boolean | null;
  /** Operator-facing wording, safe to put straight into a toast or a log. */
  readonly operatorMessage: string;
  /** The underlying transport error, when there was one. */
  readonly cause?: unknown;

  constructor(
    reason: VerisensePpgLedTestFailureReason,
    operatorMessage: string,
    hardwarePpgSupport: boolean | null,
    cause?: unknown,
  ) {
    super(operatorMessage);
    this.name = 'VerisensePpgLedTestError';
    this.reason = reason;
    this.hardwarePpgSupport = hardwarePpgSupport;
    this.operatorMessage = operatorMessage;
    this.cause = cause;
  }
}

/** Type guard for {@link VerisensePpgLedTestError}. */
export function isVerisensePpgLedTestError(e: unknown): e is VerisensePpgLedTestError {
  return e instanceof VerisensePpgLedTestError;
}

/**
 * Whether an error raised by the command path is the device NACKing a debug
 * command. Matches the three NACK opcodes (0x50 bad-header-command, 0x60
 * bad-header-property, 0x70 generic) on the DEBUG_COMMAND property (0x9),
 * which is how `validatePendingResponse` renders a refusal.
 */
function isDebugNackError(message: string): boolean {
  return /NACK command=0x(?:50|60|70) property=0x9/i.test(message);
}

/** Whether the error is the command path's own timeout. */
function isTimeoutError(message: string): boolean {
  return /Request timeout/i.test(message);
}

/**
 * Classify a failure of the MAX86xxx LED-test debug command (0x0E).
 *
 * **The NACK is ambiguous on the wire.** In the firmware's debug dispatch
 * (`asm_payload_parse.c`) the MAX86xxx branch is guarded by
 * `doesHwSupportPpg()`, and the `else` that catches unrecognised debug
 * commands calls the same `sendNackGeneric()`. So after DEV-973 (commit
 * `b98c113c3`) three different causes produce a byte-identical
 * `NACK_GENERIC` on property `0x09`:
 *
 * 1. firmware too old to know debug command `0x0E`;
 * 2. hardware with no PPG front end (`doesHwSupportPpg()` false);
 * 3. the new one — `max86xxx_ledTest()` returned non-success, i.e. the PPG
 *    bus is wedged or unreachable.
 *
 * Nothing in the reply separates them, so the only usable discriminator is
 * the hardware revision the host already holds from the production config.
 * Known-PPG hardware reaching a NACK means the firmware got as far as the
 * LED test and it failed; known-no-PPG hardware means it never did.
 *
 * @param err     the error the command path raised
 * @param opts.hardwarePpgSupport
 *        `true`/`false` from {@link getVerisenseHardwareSensorSupport}, or
 *        `null` when the hardware revision is unknown
 */
export function classifyPpgLedTestFailure(
  err: unknown,
  opts: { hardwarePpgSupport: boolean | null },
): VerisensePpgLedTestError {
  const { hardwarePpgSupport } = opts;
  const message = err instanceof Error ? err.message : String(err);

  if (isDebugNackError(message)) {
    if (hardwarePpgSupport === false) {
      return new VerisensePpgLedTestError(
        'not-supported',
        'PPG LED test refused: this hardware revision has no PPG front end, so the ' +
          'firmware never ran the test. Not a unit fault.',
        hardwarePpgSupport,
        err,
      );
    }

    const hardwareCaveat =
      hardwarePpgSupport === null
        ? ' (hardware revision unknown — read the production config to rule out ' +
          'a board with no PPG front end, or firmware too old to support this command)'
        : '';

    return new VerisensePpgLedTestError(
      'ppg-comms',
      'PPG LED test FAILED: the device refused the command — PPG comms failure ' +
        '(wedged or unreachable PPG bus). The LEDs themselves are NOT known to be ' +
        `dead; do not scrap this board as a dead-LED fault${hardwareCaveat}.`,
      hardwarePpgSupport,
      err,
    );
  }

  if (isTimeoutError(message)) {
    return new VerisensePpgLedTestError(
      'no-response',
      `PPG LED test inconclusive: no reply from the device (${message}). This is a ` +
        'link problem, not a verdict on the PPG LEDs.',
      hardwarePpgSupport,
      err,
    );
  }

  return new VerisensePpgLedTestError(
    'unknown',
    `PPG LED test failed: ${message}`,
    hardwarePpgSupport,
    err,
  );
}

/**
 * Resolve whether a parsed production config describes hardware with a PPG
 * front end. Returns `null` when the revision cannot be established (config
 * erased, unreadable, or non-numeric fields), which
 * {@link classifyPpgLedTestFailure} treats as "assume a comms fault".
 */
export function resolveHardwarePpgSupport(
  parsed: { revHwMajor?: number | null; revHwMinor?: number | null } | null | undefined,
): boolean | null {
  const major = Number(parsed?.revHwMajor);
  const minor = Number(parsed?.revHwMinor);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  // An erased production config reads back as 0xFF bytes; that is not a
  // hardware revision, it is an unprogrammed unit.
  if (major === 0xff || major <= 0) return null;
  return getVerisenseHardwareSensorSupport(major, minor).ppg;
}
