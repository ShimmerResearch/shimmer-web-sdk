import { describe, it, expect } from 'vitest';
import {
  asmRtcBytesToUnixSeconds,
  asmRtcMinutesBytesToUnixSeconds,
  buildProductionConfigPayload,
  formatVerisenseHardwareRevision,
  getVerisenseHardwareFriendlyName,
  getVerisenseHardwareSensorSupport,
  getVerisenseSupportedOperationalFieldGroupIds,
  getVerisenseStreamingBatteryVoltageMultiplier,
  parseEventLogPayload,
  parsePayloadCrcErrorBankIndexes,
  parseProductionConfigPayloadFull,
  parseLookupTablePayload,
  parseRecordBufferDetailsPayload,
  parseSchedulerDebugPayload,
  parseStatusPayload,
  formatVerisenseChargerStatus,
  unixSecondsToAsmRtcBytes,
} from '../../src/devices/verisense/protocol.js';

describe('Hardware model helpers', () => {
  it('returns friendly model names by HW major', () => {
    expect(getVerisenseHardwareFriendlyName(61)).toBe('IMU');
    expect(getVerisenseHardwareFriendlyName(62)).toBe('GSR+');
    expect(getVerisenseHardwareFriendlyName(64)).toBe('SDK');
    expect(getVerisenseHardwareFriendlyName(68)).toBe('Pulse+');
    expect(getVerisenseHardwareFriendlyName(99)).toBeNull();
  });

  it('formats SR revision strings with friendly names', () => {
    expect(formatVerisenseHardwareRevision(61, 5, 0, { includeFriendlyName: true })).toBe(
      'SR61.5.0 (IMU)',
    );
    expect(formatVerisenseHardwareRevision(99, 1, 0, { includeFriendlyName: true })).toBe(
      'SR99.1.0',
    );
  });

  it('returns streaming battery voltage multipliers by model thresholds', () => {
    expect(getVerisenseStreamingBatteryVoltageMultiplier(62, 0)).toBe(2.0);
    expect(getVerisenseStreamingBatteryVoltageMultiplier(61, 5)).toBe(2.469);
    expect(getVerisenseStreamingBatteryVoltageMultiplier(68, 8)).toBe(1.0);
    expect(getVerisenseStreamingBatteryVoltageMultiplier(68, 9)).toBe(2.469);
    expect(getVerisenseStreamingBatteryVoltageMultiplier(69, 0)).toBe(2.469);
  });

  it('resolves sensor support per model from the IC matrix', () => {
    // SR61.1 (1st-gen IMU): LIS2DW12 + LSM6DS3 only.
    expect(getVerisenseHardwareSensorSupport(61, 1)).toMatchObject({
      accel1: true,
      gyroAccel2: true,
      imuGen2: false,
      gsr: false,
      ppg: false,
    });
    // SR61.5 (2nd-gen IMU): LSM6DSV, GSR, ambient light, LEDs - no 1st-gen IMU, no PPG.
    expect(getVerisenseHardwareSensorSupport(61, 5)).toMatchObject({
      accel1: false,
      gyroAccel2: false,
      imuGen2: true,
      gsr: true,
      ppg: false,
      ambientLight: true,
      ledAutoBrightness: true,
    });
    // SR62 (GSR+): 1st-gen IMU + GSR + analog PPG.
    expect(getVerisenseHardwareSensorSupport(62, 0)).toMatchObject({
      accel1: true,
      gyroAccel2: true,
      gsr: true,
      ppg: true,
      imuGen2: false,
    });
    // SR68.8 (1st-gen Pulse+): accel1 + PPG + skin temp; no GSR, no gyro/accel2.
    expect(getVerisenseHardwareSensorSupport(68, 8)).toMatchObject({
      accel1: true,
      gyroAccel2: false,
      gsr: false,
      ppg: true,
      skinTemperature: true,
      imuGen2: false,
    });
    // SR68.6 (1st-gen Pulse+, pre skin temp): no skin temp.
    expect(getVerisenseHardwareSensorSupport(68, 6).skinTemperature).toBe(false);
    // SR68.9 (2nd-gen Pulse+): full stack, except accel1 (LIS2DW12) which is
    // routed to the algo hub and not recorded from.
    expect(getVerisenseHardwareSensorSupport(68, 9)).toMatchObject({
      accel1: false,
      gyroAccel2: false,
      imuGen2: true,
      gsr: true,
      ppg: true,
      ambientLight: true,
      skinTemperature: true,
      algorithmHub: true,
      ledAutoBrightness: true,
    });
    // Dev board / unknown major: assume everything present.
    expect(getVerisenseHardwareSensorSupport(64, 0).algorithmHub).toBe(true);
    expect(getVerisenseHardwareSensorSupport(99, 0).ppg).toBe(true);
  });

  it('derives supported op-config group ids from hardware revision', () => {
    // Unknown revision -> null (caller shows all groups).
    expect(getVerisenseSupportedOperationalFieldGroupIds(null)).toBeNull();
    expect(
      getVerisenseSupportedOperationalFieldGroupIds({ revHwMajor: 0, revHwMinor: 0 }),
    ).toBeNull();

    const gen2Pulse = getVerisenseSupportedOperationalFieldGroupIds({
      revHwMajor: 68,
      revHwMinor: 9,
      revHwInternal: 0,
    });
    // Always-on groups present; 2nd-gen IMU present; both 1st-gen IMU groups
    // excluded (accel1's LIS2DW12 is routed to the algo hub, not recorded from).
    expect(gen2Pulse?.has('gen')).toBe(true);
    expect(gen2Pulse?.has('ble_wake')).toBe(true);
    expect(gen2Pulse?.has('lsm6dsv')).toBe(true);
    expect(gen2Pulse?.has('algo')).toBe(true);
    expect(gen2Pulse?.has('accel1')).toBe(false);
    expect(gen2Pulse?.has('gyro_accel2')).toBe(false);

    const gen1Imu = getVerisenseSupportedOperationalFieldGroupIds({
      revHwMajor: 61,
      revHwMinor: 1,
      revHwInternal: 0,
    });
    // 1st-gen IMU groups present; 2nd-gen + sensor groups excluded.
    expect(gen1Imu?.has('accel1')).toBe(true);
    expect(gen1Imu?.has('gyro_accel2')).toBe(true);
    expect(gen1Imu?.has('lsm6dsv')).toBe(false);
    expect(gen1Imu?.has('ppg')).toBe(false);
    expect(gen1Imu?.has('light')).toBe(false);
  });
});

describe('Verisense RTC helpers', () => {
  it('round-trips unix seconds through the 7-byte RTC format', () => {
    const input = 1716800000.25;
    const rtc = unixSecondsToAsmRtcBytes(input);
    expect(rtc).toHaveLength(7);

    const output = asmRtcBytesToUnixSeconds(rtc);
    expect(Math.abs(output - input)).toBeLessThan(1 / 32768);
  });

  it('parses 8-byte minute counters to seconds', () => {
    const minutes = 12345;
    const payload = new Uint8Array([
      minutes & 0xff,
      (minutes >> 8) & 0xff,
      (minutes >> 16) & 0xff,
      (minutes >> 24) & 0xff,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);

    expect(asmRtcMinutesBytesToUnixSeconds(payload)).toBe(minutes * 60);
  });
});

describe('Production config payload helpers', () => {
  it('builds and parses production config with optional fields', () => {
    const payload = buildProductionConfigPayload({
      manufacturingOrderNumberHex: '26011401',
      macIdHex: 'EF29',
      revHwMajor: 61,
      revHwMinor: 5,
      revFwMajor: 0,
      revFwMinor: 19,
      revFwInternal: 2,
      revHwInternal: 1,
      passkeyId: 'AB',
      passkey: '123456',
      advertisingNamePrefix: 'Verisense-',
      dfuEnabled: true,
    });

    expect(payload).toHaveLength(56);
    expect(payload[0]).toBe(0x5a);

    const parsed = parseProductionConfigPayloadFull(payload);
    expect(parsed.uniqueIdentifier).toBe('26011401EF29');
    expect(parsed.revHwMajor).toBe(61);
    expect(parsed.revHwMinor).toBe(5);
    expect(parsed.passkeyId).toBe('AB');
    expect(parsed.passkey).toBe('123456');
    expect(parsed.advertisingNamePrefix).toBe('Verisense-');
    expect(parsed.dfuEnabled).toBe(true);
  });

  it('encodes a cleared configFlags byte when DFU is disabled', () => {
    const payload = buildProductionConfigPayload({
      manufacturingOrderNumberHex: '26011401',
      macIdHex: 'EF29',
      revHwMajor: 61,
      revHwMinor: 5,
      revFwMajor: 0,
      revFwMinor: 19,
      dfuEnabled: false,
    });

    // configFlags (byte 55) must be 0x00 when disabled — NOT left as the 0xFF
    // fill sentinel, whose bit 0 would read back as "DFU enabled" on the device.
    expect(payload[55]).toBe(0x00);
    expect(parseProductionConfigPayloadFull(payload).dfuEnabled).toBe(false);
  });
});

describe('Status payload parser', () => {
  it('parses core STATUS1 fields from a payload', () => {
    const payload = new Uint8Array(65);

    // unique ID bytes are little-endian in payload
    payload.set([0x29, 0xef, 0x01, 0x14, 0x01, 0x26], 0); // -> 26011401EF29

    // status timestamp minutes
    payload.set([0x0a, 0x00, 0x00, 0x00], 6);

    // battery 3300mV and 95%
    payload.set([0xe4, 0x0c], 10);
    payload[12] = 95;

    // last ok transfer 3 min, last fail transfer 4 min
    payload.set([0x03, 0x00, 0x00, 0x00], 13);
    payload.set([0x04, 0x00, 0x00, 0x00], 17);

    // memory free low 3 bytes + high byte
    payload.set([0x34, 0x12, 0x00], 21);
    payload[57] = 0x00;

    // battery fall counter
    payload.set([0x02, 0x00], 24);

    // status flags
    payload[26] = 0x2d;

    // memory capacity
    payload.set([0x00, 0x20, 0x00, 0x00], 60); // 8192 KB

    // charger status byte (bit0 present + bits1..3 status)
    // present=1, status=0b100 (trickle charging)
    payload[64] = 0x09;

    const parsed = parseStatusPayload(payload, 'status1');

    expect(parsed.uniqueIdentifier).toBe('26011401EF29');
    expect(parsed.batteryMilliVolts).toBe(3300);
    expect(parsed.batteryPercent).toBe(95);
    expect(parsed.memoryFreeKb).toBe(0x1234);
    expect(parsed.memoryCapacityKb).toBe(8192);
    expect(parsed.memoryUsedKb).toBe(8192 - 0x1234);
    expect(parsed.statusFlags?.usbPluggedIn).toBe(true);
    expect(parsed.statusFlags?.recordingPaused).toBe(false);
    expect(parsed.statusFlags?.flashIsFull).toBe(true);
    expect(parsed.batteryFallCounter).toBe(2);
    expect(parsed.chargerPresent).toBe(true);
    expect(parsed.chargerStatusCode).toBe(4);
    expect(parsed.chargerStatusName).toBe('CHARGER_STATUS_TRICKLE_CHARGING');
  });

  it('formats charger status text for UI summaries', () => {
    const text = formatVerisenseChargerStatus(
      {
        chargerPresent: true,
        chargerStatusCode: 2,
        chargerStatusName: 'CHARGER_STATUS_CHARGING_COMPLETE',
      },
      {
        revHwMajor: 68,
        revHwMinor: 9,
        revHwInternal: 0,
      },
    );
    expect(text).toBe('XC6803: Charge completed');
  });
});

describe('Debug payload parsers', () => {
  it('parses payload CRC error bank indexes', () => {
    const payload = new Uint8Array([0x01, 0x00, 0x34, 0x12]);
    expect(parsePayloadCrcErrorBankIndexes(payload)).toEqual([1, 0x1234]);
  });

  it('parses event log payload entries', () => {
    const timeEntry = new Uint8Array(8);
    timeEntry.set(unixSecondsToAsmRtcBytes(1716800000), 0);
    timeEntry[7] = 26; // BLE_CONNECTED

    const battEntry = new Uint8Array([0xe4, 0x0c, 0x00, 0, 0, 0, 0, 20]); // BATTERY_VOLTAGE

    const parsed = parseEventLogPayload(new Uint8Array([...timeEntry, ...battEntry]));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].eventName).toBe('BLE_CONNECTED');
    expect(parsed[0].timestampUnixSeconds).toBeGreaterThan(0);
    expect(parsed[1].eventName).toBe('BATTERY_VOLTAGE');
    expect(parsed[1].batteryMilliVolts).toBe(3300);
  });

  it('parses record buffer details payload (26-byte format)', () => {
    const row = new Uint8Array(26);
    row[0] = 1;
    row[1] = 2;
    row[2] = 0x34;
    row[3] = 0x12;
    row[4] = 0x78;
    row[5] = 0x56;
    row[6] = 0x9a;
    row[7] = 0xbc;
    row[8] = 0x11;
    row[9] = 0x22;
    row[10] = 0x01;
    row[11] = 0x00;
    row[12] = 0x00;
    row[13] = 0x00;
    row[14] = 0x03;
    row[15] = 0x02;
    row[16] = 0x01;
    row[17] = 0x10;
    row[18] = 0x00;
    row[19] = 0x04;
    row[20] = 0x00;
    row[21] = 0x00;
    row[22] = 0x00;
    row[23] = 0x06;
    row[24] = 0x05;
    row[25] = 0x04;

    const parsed = parseRecordBufferDetailsPayload(row);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].bufferIndex).toBe(1);
    expect(parsed[0].packagedPayloadIndex).toBe(0x1234);
    expect(parsed[0].dataTimestampUcClockTicks).toBe(0x040506);
  });

  it('parses scheduler debug payload', () => {
    const parts: number[] = [];
    parts.push(...unixSecondsToAsmRtcBytes(1716800000));
    parts.push(0x01); // status1

    const minBlock = (minutes: number) => [
      minutes & 0xff,
      (minutes >> 8) & 0xff,
      (minutes >> 16) & 0xff,
      (minutes >> 24) & 0xff,
      0,
      0,
      0,
      0,
    ];

    parts.push(...minBlock(10));
    parts.push(...minBlock(11));
    parts.push(...minBlock(12));
    parts.push(...minBlock(13));
    parts.push(3); // retry count
    parts.push(1); // ble-on

    parts.push(...minBlock(14));
    parts.push(1); // adaptive enabled
    parts.push(5); // sync fail

    parts.push(...minBlock(15));
    parts.push(2); // attempt-flash-write
    parts.push(6);
    parts.push(7);

    const parsed = parseSchedulerDebugPayload(new Uint8Array(parts));
    expect(parsed.bleControlCounter).toBe('status1');
    expect(parsed.retryCount).toBe(3);
    expect(parsed.retryOperation).toBe('ble-on');
    expect(parsed.adaptiveScheduler?.enabled).toBe(true);
    expect(parsed.ltfRetry?.currentOperation).toBe('attempt-flash-write');
  });

  it('parses lookup table payload with optional head/tail bytes', () => {
    // 2 banks => 6 bytes + 4-byte tail/head prefix
    const payload = new Uint8Array([
      0x34,
      0x12, // tail
      0x78,
      0x56, // head
      0x81,
      0x01,
      0x00, // bank0: Full + pending write, payload index 1
      0x03,
      0x2a,
      0x00, // bank1: Empty, payload index 42
    ]);

    const parsed = parseLookupTablePayload(payload, 2);
    expect(parsed.tail).toBe(0x1234);
    expect(parsed.head).toBe(0x5678);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].statusName).toBe('Full');
    expect(parsed.entries[0].pendingEepromWrite).toBe(true);
    expect(parsed.entries[1].statusName).toBe('Emty');
    expect(parsed.entries[1].payloadIndex).toBe(42);
  });
});
