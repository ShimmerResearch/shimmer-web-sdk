import { describe, expect, it } from 'vitest';
import {
  EXG_ANY_MASK,
  SENSOR_RULE_CONFLICTS,
  SR_BOARD,
  applySensorToggle,
  checkSensorRules,
  deriveExpPower,
  describeSensorRules,
  requiresExpansionPower,
  sensorAvailability,
  sensorConflicts,
  sensorRuleLabel,
  sensorRuleMask,
  type SensorRuleKey,
  type SensorRuleState,
} from '../../src/devices/shimmer3/sensorRules.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';

const B = SensorBitmapShimmer3;

const state = (over: Partial<SensorRuleState> = {}): SensorRuleState => ({
  enabledSensors: 0,
  generation: 'shimmer3r',
  expPower: 0,
  boardId: null,
  ...over,
});

describe('the conflict table', () => {
  it('is symmetric: every conflict lists its partner back', () => {
    for (const pair of SENSOR_RULE_CONFLICTS) {
      expect(
        sensorConflicts(pair.a).some((c) => c.key === pair.b),
        `${pair.a} → ${pair.b}`,
      ).toBe(true);
      expect(
        sensorConflicts(pair.b).some((c) => c.key === pair.a),
        `${pair.b} → ${pair.a}`,
      ).toBe(true);
    }
  });

  it('marks exactly the five pairs the firmware corrects itself', () => {
    // ShimConfig_checkAndCorrectConfig: GSR vs the GSR ADC line, the bridge
    // amplifier vs two ADC lines, and ExG vs two ADC lines. Everything else in
    // the table is a Consensys rule the firmware will happily accept.
    const firmware = SENSOR_RULE_CONFLICTS.filter((p) => p.firmware).map((p) =>
      [p.a, p.b].sort().join('+'),
    );
    expect(firmware.sort()).toEqual(
      [
        'SENSOR_GSR+SENSOR_INT_A3',
        'SENSOR_BRIDGE_AMP+SENSOR_INT_A1',
        'SENSOR_BRIDGE_AMP+SENSOR_INT_A2',
        'EXG+SENSOR_INT_A3',
        'EXG+SENSOR_INT_A2',
      ].sort(),
    );
  });

  it('treats the four ExG bits as one sensor', () => {
    expect(EXG_ANY_MASK).toBe(
      B.SENSOR_EXG1_24BIT | B.SENSOR_EXG2_24BIT | B.SENSOR_EXG1_16BIT | B.SENSOR_EXG2_16BIT,
    );
    expect(sensorRuleMask('EXG')).toBe(EXG_ANY_MASK);
  });
});

describe('applySensorToggle — newest wins', () => {
  it('unticks the ADC line GSR shares an input with, and powers the rail', () => {
    const r = applySensorToggle(
      state({ enabledSensors: B.SENSOR_INT_A3, expPower: 0 }),
      'SENSOR_GSR',
      true,
    );
    expect(r.enabledSensors & B.SENSOR_INT_A3).toBe(0);
    expect(r.enabledSensors & B.SENSOR_GSR).toBe(B.SENSOR_GSR);
    expect(r.expPower).toBe(1);
    expect(r.changes).toHaveLength(2);
    expect(r.changes[0].reason).toMatch(/Internal ADC A3 unticked/);
    expect(r.changes[0].reason).toMatch(/firmware\s+clears it itself/);
    expect(r.changes[1].key).toBe('expPower');
    expect(r.changes[1].reason).toMatch(/switched on/);
  });

  it('lets the ADC line win when IT is the newest choice', () => {
    // The user ticked the ADC line this time, so GSR goes. Same rule, other way.
    const r = applySensorToggle(
      state({ enabledSensors: B.SENSOR_GSR, expPower: 1 }),
      'SENSOR_INT_A3',
      true,
    );
    expect(r.enabledSensors & B.SENSOR_GSR).toBe(0);
    expect(r.enabledSensors & B.SENSOR_INT_A3).toBe(B.SENSOR_INT_A3);
    // An internal ADC line leaves the rail as it was — it may be wired to
    // something that needs it.
    expect(r.expPower).toBe(1);
  });

  it('switches the rail off when the last sensor needing it goes', () => {
    const r = applySensorToggle(
      state({ enabledSensors: B.SENSOR_GSR, expPower: 1 }),
      'SENSOR_GSR',
      false,
    );
    expect(r.expPower).toBe(0);
    expect(r.changes.some((c) => c.key === 'expPower' && /switched off/.test(c.reason))).toBe(true);
  });

  it('clears everything the ExG front end conflicts with', () => {
    const before =
      B.SENSOR_INT_A0 |
      B.SENSOR_INT_A1 |
      B.SENSOR_INT_A2 |
      B.SENSOR_INT_A3 |
      B.SENSOR_GSR |
      B.SENSOR_BRIDGE_AMP |
      B.SENSOR_GYRO;
    const r = applySensorToggle(state({ enabledSensors: before, expPower: 0 }), 'EXG', true);
    for (const key of [
      'SENSOR_INT_A0',
      'SENSOR_INT_A1',
      'SENSOR_INT_A2',
      'SENSOR_INT_A3',
      'SENSOR_GSR',
      'SENSOR_BRIDGE_AMP',
    ] as SensorRuleKey[]) {
      expect(r.enabledSensors & sensorRuleMask(key), key).toBe(0);
    }
    // The gyroscope has nothing to do with the expansion connector.
    expect(r.enabledSensors & B.SENSOR_GYRO).toBe(B.SENSOR_GYRO);
    expect(r.expPower).toBe(1);
    expect(r.exgOff).toBe(false);
  });

  it('reports the Shimmer3R ExG power caveat, and only there', () => {
    const r3r = applySensorToggle(state({ generation: 'shimmer3r' }), 'EXG', true);
    expect(r3r.changes.find((c) => c.key === 'expPower')!.reason).toMatch(
      /own power control.*Consensys/s,
    );
    const r3 = applySensorToggle(state({ generation: 'shimmer3' }), 'EXG', true);
    expect(r3.changes.find((c) => c.key === 'expPower')!.reason).not.toMatch(/own power control/);
  });

  it('tells a host to reset its ExG mode when ExG loses', () => {
    const r = applySensorToggle(
      state({ enabledSensors: EXG_ANY_MASK, exgMode: 'off', expPower: 1 }),
      'SENSOR_GSR',
      true,
    );
    expect(r.exgOff).toBe(true);
    expect(r.enabledSensors & EXG_ANY_MASK).toBe(0);
  });

  it('names the ADC lines the way the platform does', () => {
    const s3 = applySensorToggle(
      state({ generation: 'shimmer3', enabledSensors: B.SENSOR_INT_A3 }),
      'SENSOR_GSR',
      true,
    );
    expect(s3.changes[0].reason).toMatch(/Internal ADC A1 unticked/);
    const s3r = applySensorToggle(
      state({ generation: 'shimmer3r', enabledSensors: B.SENSOR_INT_A3 }),
      'SENSOR_GSR',
      true,
    );
    expect(s3r.changes[0].reason).toMatch(/Internal ADC A3 unticked/);
  });

  it('rejects an unknown key', () => {
    expect(() => applySensorToggle(state(), 'SENSOR_NOPE' as SensorRuleKey, true)).toThrow(
      RangeError,
    );
  });
});

describe('deriveExpPower', () => {
  it('is off when nothing needs the rail', () => {
    expect(deriveExpPower(B.SENSOR_GYRO, false, 0)).toBe(0);
    expect(deriveExpPower(B.SENSOR_GYRO, false, 1)).toBe(0);
  });

  it('is on when a board sensor needs it', () => {
    expect(deriveExpPower(B.SENSOR_GSR, false, 0)).toBe(1);
    expect(deriveExpPower(B.SENSOR_BRIDGE_AMP, false, 0)).toBe(1);
    expect(deriveExpPower(0, true, 0)).toBe(1);
  });

  it('leaves it alone when only an internal ADC line is on', () => {
    // The Java driver's deliberate no-op: the line may be wired to something
    // that needs power without the driver knowing.
    expect(deriveExpPower(B.SENSOR_INT_A0, false, 1)).toBe(1);
    expect(deriveExpPower(B.SENSOR_INT_A0, false, 0)).toBe(0);
    expect(deriveExpPower(B.SENSOR_INT_A0, false, null)).toBeNull();
  });

  it('names which sensors need it', () => {
    expect(requiresExpansionPower('SENSOR_GSR')).toBe(true);
    expect(requiresExpansionPower('SENSOR_BRIDGE_AMP')).toBe(true);
    expect(requiresExpansionPower('EXG')).toBe(true);
    expect(requiresExpansionPower('SENSOR_INT_A0')).toBe(false);
    expect(requiresExpansionPower('SENSOR_GYRO')).toBe(false);
  });
});

describe('checkSensorRules', () => {
  it('finds both faults in an image that shares an input and forgot the rail', () => {
    const check = checkSensorRules(
      state({ enabledSensors: B.SENSOR_GSR | B.SENSOR_INT_A3, expPower: 0 }),
    );
    expect(check.violations.map((v) => v.kind).sort()).toEqual(['conflict', 'expPower']);
    const conflict = check.violations.find((v) => v.kind === 'conflict')!;
    expect(conflict.enforcedBy).toBe('firmware');
    expect(conflict.sensors.sort()).toEqual(['SENSOR_GSR', 'SENSOR_INT_A3']);
    expect(check.violations.find((v) => v.kind === 'expPower')!.message).toMatch(
      /will read nothing/,
    );
    // The ADC line loses, and the rail comes on.
    expect(check.derivations.enabledSensors).toBe(B.SENSOR_GSR);
    expect(check.derivations.expPower).toBe(1);
  });

  it('is idempotent: its own derivations break no rule', () => {
    const messy =
      B.SENSOR_GSR | B.SENSOR_BRIDGE_AMP | B.SENSOR_INT_A0 | B.SENSOR_INT_A2 | EXG_ANY_MASK;
    const first = checkSensorRules(state({ enabledSensors: messy, expPower: 0 }));
    expect(first.violations.length).toBeGreaterThan(0);
    const second = checkSensorRules(
      state({
        enabledSensors: first.derivations.enabledSensors,
        expPower: first.derivations.expPower,
      }),
    );
    expect(second.violations).toEqual([]);
    expect(second.changes).toEqual([]);
  });

  it('finds nothing wrong with a clean configuration', () => {
    const check = checkSensorRules(
      state({ enabledSensors: B.SENSOR_GYRO | B.SENSOR_A_ACCEL, expPower: 0 }),
    );
    expect(check.violations).toEqual([]);
    expect(check.changes).toEqual([]);
  });

  it('keeps the front end the fitted board is for', () => {
    const both = B.SENSOR_GSR | EXG_ANY_MASK;
    // A GSR+ board: GSR is what this hardware is.
    const gsrBoard = checkSensorRules(
      state({ enabledSensors: both, expPower: 1, boardId: SR_BOARD.GSR_UNIFIED }),
    );
    expect(gsrBoard.derivations.enabledSensors & B.SENSOR_GSR).toBe(B.SENSOR_GSR);
    expect(gsrBoard.derivations.enabledSensors & EXG_ANY_MASK).toBe(0);

    // An ExG board: the other way.
    const exgBoard = checkSensorRules(
      state({ enabledSensors: both, expPower: 1, boardId: SR_BOARD.EXG_UNIFIED }),
    );
    expect(exgBoard.derivations.enabledSensors & EXG_ANY_MASK).toBe(EXG_ANY_MASK);
    expect(exgBoard.derivations.enabledSensors & B.SENSOR_GSR).toBe(0);

    // No board known: ExG wins, being the most deliberate choice a host makes.
    const unknown = checkSensorRules(state({ enabledSensors: both, expPower: 1, boardId: null }));
    expect(unknown.derivations.enabledSensors & EXG_ANY_MASK).toBe(EXG_ANY_MASK);
  });

  it('reports the bridge amplifier as impossible on a Shimmer3R', () => {
    const check = checkSensorRules(
      state({ enabledSensors: B.SENSOR_BRIDGE_AMP, generation: 'shimmer3r' }),
    );
    expect(check.violations[0].kind).toBe('generation');
    expect(check.violations[0].message).toMatch(/no such channel/);
    expect(check.derivations.enabledSensors & B.SENSOR_BRIDGE_AMP).toBe(0);
  });

  it('accepts the bridge amplifier on a Shimmer3 with the right board', () => {
    const ok = checkSensorRules(
      state({
        enabledSensors: B.SENSOR_BRIDGE_AMP,
        generation: 'shimmer3',
        expPower: 1,
        boardId: SR_BOARD.BRIDGE_AMP,
      }),
    );
    expect(ok.violations).toEqual([]);
  });

  it('reports a sensor the fitted board does not have', () => {
    const check = checkSensorRules(
      state({ enabledSensors: B.SENSOR_GSR, expPower: 1, boardId: SR_BOARD.EXG }),
    );
    expect(check.violations[0].kind).toBe('hardware');
    expect(check.violations[0].message).toMatch(/needs a GSR\+ board.*SR37/);
  });

  it('gates nothing when the board is unknown', () => {
    const check = checkSensorRules(
      state({ enabledSensors: B.SENSOR_GSR, expPower: 1, boardId: null }),
    );
    expect(check.violations).toEqual([]);
  });
});

describe('sensorAvailability', () => {
  it('blocks a front end the board does not have', () => {
    const a = sensorAvailability('SENSOR_GSR', state({ boardId: SR_BOARD.EXG }));
    expect(a).toMatchObject({ available: false, gate: 'block' });
    expect(a.reason).toMatch(/GSR\+ board/);
  });

  it('blocks the bridge amplifier on a Shimmer3R whatever the board', () => {
    expect(
      sensorAvailability('SENSOR_BRIDGE_AMP', state({ generation: 'shimmer3r' })),
    ).toMatchObject({ available: false, gate: 'block' });
  });

  it('only warns about an internal ADC line', () => {
    // Java's per-line board lists are revision-specific and name boards this
    // SDK's table does not carry, so refusing would reject working setups.
    const a = sensorAvailability('SENSOR_INT_A0', state({ boardId: SR_BOARD.IMU }));
    expect(a.available).toBe(true);
    expect(a.gate).toBe('warn');
    expect(a.reason).toMatch(/internal expansion connector/);
  });

  it('permits everything on an unknown board', () => {
    for (const key of ['SENSOR_GSR', 'EXG', 'SENSOR_INT_A0'] as SensorRuleKey[]) {
      expect(sensorAvailability(key, state({ boardId: null })).available, key).toBe(true);
    }
  });

  it('permits a sensor with no hardware rule at all', () => {
    expect(sensorAvailability('SENSOR_GYRO', state({ boardId: SR_BOARD.IMU }))).toEqual({
      available: true,
      gate: null,
      reason: null,
    });
  });
});

describe('describeSensorRules', () => {
  it('describes GSR in the platform’s own vocabulary', () => {
    const s3r = describeSensorRules('SENSOR_GSR', 'shimmer3r');
    expect(s3r.text).toMatch(/GSR — bitmap 0x000004/);
    expect(s3r.text).toMatch(/Internal ADC A3 \(the firmware unticks it\)/);
    expect(s3r.text).toMatch(/Turns expansion-board power on/);
    expect(s3r.text).toMatch(/Needs a GSR\+ board/);
    expect(s3r.requiresExpPower).toBe(true);

    const s3 = describeSensorRules('SENSOR_GSR', 'shimmer3');
    expect(s3.text).toMatch(/Internal ADC A1 \(the firmware unticks it\)/);
  });

  it('names an ADC line per generation', () => {
    expect(sensorRuleLabel('SENSOR_INT_A3', 'shimmer3')).toBe('Internal ADC A1');
    expect(sensorRuleLabel('SENSOR_INT_A3', 'shimmer3r')).toBe('Internal ADC A3');
    // With no generation known, neither name is guessed at.
    expect(sensorRuleLabel('SENSOR_INT_A3')).toMatch(/Internal ADC A3.*Shimmer3/);
  });

  it('says nothing about conflicts or power for a plain inertial sensor', () => {
    const d = describeSensorRules('SENSOR_GYRO', 'shimmer3r');
    expect(d.conflicts).toEqual([]);
    expect(d.requiresExpPower).toBe(false);
    expect(d.boards).toBeNull();
    expect(d.text).not.toMatch(/Cannot be enabled/);
  });

  it('rejects an unknown key', () => {
    expect(() => describeSensorRules('NOPE' as SensorRuleKey)).toThrow(RangeError);
  });
});
