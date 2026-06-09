import { OP_IDX, OP_CONFIG_VERSION_V9 } from './constants.js';

export type VerisenseOperationalFieldKind =
  | 'bit'
  | 'u8'
  | 'u16'
  | 'u32'
  | 'inactiveResume'
  | 'inactiveMinutes';

export type VerisenseOperationalFieldOption = readonly [number, string];

export interface VerisenseOperationalFieldDefinition {
  readonly key: string;
  readonly label: string;
  readonly desc: string;
  readonly kind: VerisenseOperationalFieldKind;
  readonly index: number;
  readonly shift?: number;
  readonly width?: number;
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly VerisenseOperationalFieldOption[];
}
export const VERISENSE_OPERATIONAL_FIELD_SCHEMA = [
  // GEN_CFG_0
  {
    key: 'BLUETOOTH_EN',
    label: 'Bluetooth',
    desc: 'Enable BLE',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_0,
    shift: 4,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'USB_EN',
    label: 'USB',
    desc: 'Enable USB interface',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_0,
    shift: 3,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'PRIORITISE_LONG_TERM_FLASH',
    label: 'Prioritise Long-Term Flash',
    desc: 'Prioritise long-term flash behavior',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_0,
    shift: 2,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'DEVICE_EN',
    label: 'Device',
    desc: 'Master device enable',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_0,
    shift: 1,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'RECORDING_EN',
    label: 'Recording',
    desc: 'Enable recording',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_0,
    shift: 0,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },

  // GEN_CFG_1
  {
    key: 'DATA_COMPRESSION_MODE',
    label: 'Data Compression',
    desc: '0: Off, 1: ZLIB (future), 2: XZ (future), 3: Reserved',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_1,
    shift: 0,
    width: 2,
    options: [
      [0, 'Off'],
      [1, 'ZLIB (future)'],
      [2, 'XZ (future)'],
      [3, 'Reserved'],
    ],
  },

  // GEN_CFG_2/3
  {
    key: 'HR_PPG_CHANNEL',
    label: 'HR PPG Channel',
    desc: 'Default HR channel',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_2,
    shift: 6,
    width: 2,
    options: [
      [0, 'IR'],
      [1, 'RED'],
      [2, 'GREEN'],
      [3, 'BLUE'],
    ],
  },
  {
    key: 'STEP_COUNT_EN',
    label: 'Step Counter',
    desc: 'Enable step counter',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_2,
    shift: 5,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'PENDING_EVENTS_SCHEDULER_DISABLED',
    label: 'Pending Events Scheduler',
    desc: '1 = disabled',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_2,
    shift: 4,
    width: 1,
    options: [
      [0, 'Enabled'],
      [1, 'Disabled'],
    ],
  },
  {
    key: 'BATT_TYPE',
    label: 'Battery Type',
    desc: 'Battery chemistry',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_2,
    shift: 0,
    width: 1,
    options: [
      [0, 'Zinc-Air'],
      [1, 'NiMH'],
    ],
  },
  {
    key: 'MAG_EN',
    label: 'Magnetometer',
    desc: 'Enable LIS2MDL magnetometer (second-generation hardware)',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_3,
    shift: 2,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'LED_MODE',
    label: 'LED Mode',
    desc: '0 Off, 1 On, 2 Low-power',
    kind: 'bit',
    index: OP_IDX.GEN_CFG_3,
    shift: 0,
    width: 2,
    options: [
      [0, 'Off'],
      [1, 'On'],
      [2, 'Low-power'],
      [3, 'Reserved'],
    ],
  },

  // ACCEL1
  {
    key: 'ODR',
    label: 'Accel1 ODR',
    desc: 'Accel1 sampling rate mode',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_0,
    shift: 4,
    width: 4,
    options: [
      [0, 'Power-down'],
      [1, '12.5/1.6 Hz'],
      [2, '12.5 Hz'],
      [3, '25 Hz'],
      [4, '50 Hz'],
      [5, '100 Hz'],
      [6, '200 Hz'],
      [7, '400/200 Hz'],
      [8, '800/200 Hz'],
      [9, '1600/200 Hz'],
    ],
  },
  {
    key: 'MODE',
    label: 'Accel1 Mode',
    desc: 'Operating mode',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_0,
    shift: 2,
    width: 2,
    options: [
      [0, 'Low-Power'],
      [1, 'High-Performance'],
      [2, 'Single conversion'],
      [3, 'Reserved'],
    ],
  },
  {
    key: 'LP_MODE',
    label: 'Accel1 LP Mode',
    desc: 'Low-power sub-mode',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_0,
    shift: 0,
    width: 2,
    options: [
      [0, 'LP1'],
      [1, 'LP2'],
      [2, 'LP3'],
      [3, 'LP4'],
    ],
  },
  {
    key: 'BW_FILT',
    label: 'Accel1 BW Filter',
    desc: '00 ODR/2, 01 ODR/4, 10 ODR/10, 11 ODR/20',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_1,
    shift: 6,
    width: 2,
    options: [
      [0, 'ODR/2'],
      [1, 'ODR/4'],
      [2, 'ODR/10'],
      [3, 'ODR/20'],
    ],
  },
  {
    key: 'FS',
    label: 'Accel1 Range',
    desc: 'Full-scale range',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_1,
    shift: 4,
    width: 2,
    options: [
      [0, '+-2g'],
      [1, '+-4g'],
      [2, '+-8g'],
      [3, '+-16g'],
    ],
  },
  {
    key: 'FDS',
    label: 'Accel1 FDS',
    desc: 'Filtered data selection',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_1,
    shift: 3,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'LOW_NOISE',
    label: 'Accel1 Low Noise',
    desc: 'Low-noise mode',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_1,
    shift: 2,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'HP_REF_MODE',
    label: 'Accel1 HP Ref Mode',
    desc: 'High-pass reference mode',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_2,
    shift: 1,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'FMode',
    label: 'Accel1 FIFO Mode',
    desc: 'LIS2DW12 FIFO mode',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_3,
    shift: 5,
    width: 3,
    options: [
      [0, 'Bypass'],
      [1, 'FIFO'],
      [2, 'Reserved'],
      [3, 'Continuous-to-FIFO'],
      [4, 'Bypass-to-Continuous'],
      [5, 'Reserved'],
      [6, 'Continuous'],
      [7, 'Reserved'],
    ],
  },
  {
    key: 'FTH',
    label: 'Accel1 FIFO Threshold',
    desc: '5-bit threshold (0-31)',
    kind: 'bit',
    index: OP_IDX.ACCEL1_CFG_3,
    shift: 0,
    width: 5,
    min: 0,
    max: 31,
  },

  // ACCEL2/GYRO
  {
    key: 'FTH_LSB',
    label: 'LSM FIFO Threshold LSB',
    desc: 'Lower 8 bits of LSM FIFO threshold',
    kind: 'u8',
    index: OP_IDX.GYRO_ACCEL2_CFG_0,
    min: 0,
    max: 255,
  },
  {
    key: 'TIMER_PEDO_FIFDO_EN',
    label: 'Timer/Pedo FIFO Dataset',
    desc: 'Include step/timestamp as 4th dataset',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_1,
    shift: 7,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'TIMER_PEDO_FIFO_DRDY',
    label: 'Timer/Pedo FIFO DRDY',
    desc: '0 write by DRDY, 1 disable write at each step',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_1,
    shift: 6,
    width: 1,
    options: [
      [0, 'DRDY'],
      [1, 'Step detect'],
    ],
  },
  {
    key: 'FTH_MSB',
    label: 'LSM FIFO Threshold MSB',
    desc: 'Upper 4 bits of LSM FIFO threshold',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_1,
    shift: 0,
    width: 4,
    min: 0,
    max: 15,
  },
  {
    key: 'DEC_FIFO_GYRO',
    label: 'Gyro FIFO Decimation',
    desc: 'Decimation factor for gyro',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_2,
    shift: 3,
    width: 3,
    options: [
      [0, 'Not in FIFO'],
      [1, 'No decimation'],
      [2, 'x2'],
      [3, 'x3'],
      [4, 'x4'],
      [5, 'x8'],
      [6, 'x16'],
      [7, 'x32'],
    ],
  },
  {
    key: 'DEC_FIFO_XL',
    label: 'Accel2 FIFO Decimation',
    desc: 'Decimation factor for accel2',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_2,
    shift: 0,
    width: 3,
    options: [
      [0, 'Not in FIFO'],
      [1, 'No decimation'],
      [2, 'x2'],
      [3, 'x3'],
      [4, 'x4'],
      [5, 'x8'],
      [6, 'x16'],
      [7, 'x32'],
    ],
  },
  {
    key: 'ODR_FIFO',
    label: 'LSM FIFO ODR',
    desc: 'FIFO sampling rate',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_3,
    shift: 3,
    width: 4,
    options: [
      [0, 'Disabled'],
      [1, '12.5 Hz'],
      [2, '26 Hz'],
      [3, '52 Hz'],
      [4, '104 Hz'],
      [5, '208 Hz'],
      [6, '416 Hz'],
      [7, '833 Hz'],
      [8, '1.66 kHz'],
      [9, '3.33 kHz'],
      [10, '6.66 kHz'],
    ],
  },
  {
    key: 'FIFO_MODE',
    label: 'LSM FIFO Mode',
    desc: 'FIFO behavior',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_3,
    shift: 0,
    width: 3,
    options: [
      [0, 'Bypass'],
      [1, 'FIFO'],
      [2, 'Reserved'],
      [3, 'Continuous-to-FIFO'],
      [4, 'Bypass-to-Continuous'],
      [5, 'Reserved'],
      [6, 'Continuous'],
      [7, 'Reserved'],
    ],
  },
  {
    key: 'ODR_XL',
    label: 'Accel2 ODR',
    desc: 'Accel2 sampling rate',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_4,
    shift: 4,
    width: 4,
    options: [
      [0, 'Power-down'],
      [1, '12.5 Hz'],
      [2, '26 Hz'],
      [3, '52 Hz'],
      [4, '104 Hz'],
      [5, '208 Hz'],
      [6, '416 Hz'],
      [7, '833 Hz'],
      [8, '1.66 kHz'],
      [9, '3.33 kHz'],
      [10, '6.66 kHz'],
    ],
  },
  {
    key: 'FS_XL',
    label: 'Accel2 Range',
    desc: '00 +-2g, 01 +-16g, 10 +-4g, 11 +-8g',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_4,
    shift: 2,
    width: 2,
    options: [
      [0, '+-2g'],
      [1, '+-16g'],
      [2, '+-4g'],
      [3, '+-8g'],
    ],
  },
  {
    key: 'BW_XL',
    label: 'Accel2 BW',
    desc: 'Anti-alias filter bandwidth',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_4,
    shift: 0,
    width: 2,
    options: [
      [0, '400 Hz'],
      [1, '200 Hz'],
      [2, '100 Hz'],
      [3, '50 Hz'],
    ],
  },
  {
    key: 'ODR_G',
    label: 'Gyro ODR',
    desc: 'Gyro sampling rate',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_5,
    shift: 4,
    width: 4,
    options: [
      [0, 'Power-down'],
      [1, '12.5 Hz'],
      [2, '26 Hz'],
      [3, '52 Hz'],
      [4, '104 Hz'],
      [5, '208 Hz'],
      [6, '416 Hz'],
      [7, '833 Hz'],
      [8, '1.66 kHz'],
    ],
  },
  {
    key: 'FS_G',
    label: 'Gyro Range',
    desc: 'Gyro full-scale',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_5,
    shift: 2,
    width: 2,
    options: [
      [0, '250 dps'],
      [1, '500 dps'],
      [2, '1000 dps'],
      [3, '2000 dps'],
    ],
  },
  {
    key: 'FS_125',
    label: 'Gyro 125 dps',
    desc: 'Enable 125 dps full-scale',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_5,
    shift: 1,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'G_HM_MODE',
    label: 'Gyro High-Performance Mode',
    desc: '0 HP enabled, 1 HP disabled',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_6,
    shift: 7,
    width: 1,
    options: [
      [0, 'Enabled'],
      [1, 'Disabled'],
    ],
  },
  {
    key: 'HP_G_EN',
    label: 'Gyro HPF',
    desc: 'Gyro high-pass filter',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_6,
    shift: 6,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'HPCF_G',
    label: 'Gyro HPF Cutoff',
    desc: 'Gyro HPF cutoff frequency',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_6,
    shift: 4,
    width: 2,
    options: [
      [0, '0.0081 Hz'],
      [1, '0.0324 Hz'],
      [2, '2.07 Hz'],
      [3, '16.32 Hz'],
    ],
  },
  {
    key: 'HP_G_RST',
    label: 'Gyro HPF Reset',
    desc: 'Reset digital HPF',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_6,
    shift: 3,
    width: 1,
    options: [
      [0, 'Off'],
      [1, 'On'],
    ],
  },
  {
    key: 'ROUNDING_STATUS',
    label: 'Rounding Status',
    desc: 'Source register rounding',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_6,
    shift: 2,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'LPF2_XL_EN',
    label: 'Accel2 LPF2',
    desc: 'LPF2 selection',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_7,
    shift: 7,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'HPCF_XL',
    label: 'Accel2 HP/Slope Cutoff',
    desc: 'HPCF_XL bits',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_7,
    shift: 5,
    width: 2,
    min: 0,
    max: 3,
  },
  {
    key: 'HP_SLOPE_XL_EN',
    label: 'Accel2 HP/Slope Enable',
    desc: 'HP/slope filter selection',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_7,
    shift: 2,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'LOW_PASS_ON_6D',
    label: 'Low-pass on 6D',
    desc: 'Low-pass filter on 6D function',
    kind: 'bit',
    index: OP_IDX.GYRO_ACCEL2_CFG_7,
    shift: 0,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },

  // LSM6DSV explicit host fields (bytes 18..20)
  {
    key: 'LSM6DSV_ODR_XL',
    label: 'LSM6DSV Accel ODR',
    desc: 'Accel ODR (LSM6DSV ODR_XL datasheet register value, byte 18 bits 3:0)',
    kind: 'bit',
    index: OP_IDX.LSM6DSV_CFG_0,
    shift: 0,
    width: 4,
    options: [
      [0, 'Off'],
      [1, '1.875 Hz'],
      [2, '7.5 Hz'],
      [3, '15 Hz'],
      [4, '30 Hz'],
      [5, '60 Hz'],
      [6, '120 Hz'],
      [7, '240 Hz'],
      [8, '480 Hz'],
      [9, '960 Hz'],
      [10, '1920 Hz'],
      [11, '3840 Hz'],
      [12, '7680 Hz'],
    ],
  },
  {
    key: 'LSM6DSV_FS_XL',
    label: 'LSM6DSV Accel Range',
    desc: 'Second-gen accel range code (byte 18 bits 5:4)',
    kind: 'bit',
    index: OP_IDX.LSM6DSV_CFG_0,
    shift: 4,
    width: 2,
    options: [
      [0, '+-2g'],
      [1, '+-4g'],
      [2, '+-8g'],
      [3, '+-16g'],
    ],
  },
  {
    key: 'LSM6DSV_ODR_G',
    label: 'LSM6DSV Gyro ODR',
    desc: 'Gyro ODR (LSM6DSV ODR_G datasheet register value, byte 19 bits 3:0)',
    kind: 'bit',
    index: OP_IDX.LSM6DSV_CFG_1,
    shift: 0,
    width: 4,
    options: [
      [0, 'Off'],
      [1, '1.875 Hz'],
      [2, '7.5 Hz'],
      [3, '15 Hz'],
      [4, '30 Hz'],
      [5, '60 Hz'],
      [6, '120 Hz'],
      [7, '240 Hz'],
      [8, '480 Hz'],
      [9, '960 Hz'],
      [10, '1920 Hz'],
      [11, '3840 Hz'],
      [12, '7680 Hz'],
    ],
  },
  {
    key: 'LSM6DSV_FS_G',
    label: 'LSM6DSV Gyro Range',
    desc: 'Gyro range (LSM6DSV FS_G datasheet register value, byte 19 bits 7:4)',
    kind: 'bit',
    index: OP_IDX.LSM6DSV_CFG_1,
    shift: 4,
    width: 4,
    options: [
      [0, '125 dps'],
      [1, '250 dps'],
      [2, '500 dps'],
      [3, '1000 dps'],
      [4, '2000 dps'],
    ],
  },
  {
    key: 'LIS2MDL_ODR',
    label: 'Mag Output Rate',
    desc: 'Magnetometer output (sensor-hub) rate. Firmware derives the LIS2MDL ODR to keep a fresh sample available (byte 20 bits 1:0). Bounded by the accel/gyro ODR (the sensor-hub trigger).',
    kind: 'bit',
    index: OP_IDX.LSM6DSV_CFG_2,
    shift: 0,
    width: 2,
    options: [
      [0, '15 Hz (LIS2MDL 20 Hz)'],
      [1, '30 Hz (LIS2MDL 50 Hz)'],
      [2, '60 Hz (LIS2MDL 100 Hz)'],
      [3, '120 Hz (LIS2MDL 100 Hz)'],
    ],
  },

  // Timing and BLE scheduler
  {
    key: 'START_TIME',
    label: 'Start Time',
    desc: '32-bit start time',
    kind: 'u32',
    index: OP_IDX.START_TIME,
    min: 0,
    max: 4294967295,
  },
  {
    key: 'END_TIME',
    label: 'End Time',
    desc: '32-bit end time',
    kind: 'u32',
    index: OP_IDX.END_TIME,
    min: 0,
    max: 4294967295,
  },
  {
    key: 'RESUME_REC_ON_ACTIVITY',
    label: 'Resume Rec On Activity',
    desc: 'INACTIVE_TIMEOUT bit 6',
    kind: 'inactiveResume',
    index: OP_IDX.INACTIVE_TIMEOUT,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'INACTIVE_TIMEOUT_MINUTES',
    label: 'Inactive Timeout (min)',
    desc: 'INACTIVE_TIMEOUT bits [5:0]',
    kind: 'inactiveMinutes',
    index: OP_IDX.INACTIVE_TIMEOUT,
    min: 0,
    max: 63,
  },
  {
    key: 'BLE_CONNECTION_TRIES_PER_DAY',
    label: 'BLE Retry Count',
    desc: 'BLE connection tries per day',
    kind: 'u8',
    index: OP_IDX.BLE_RETRY_COUNT,
    min: 0,
    max: 255,
  },
  {
    key: 'BLE_TX_POWER',
    label: 'BLE TX Power',
    desc: 'Radio TX power',
    kind: 'u8',
    index: OP_IDX.BLE_TX_POWER,
    options: [
      [0x08, '+8 dBm'],
      [0x07, '+7 dBm'],
      [0x06, '+6 dBm'],
      [0x05, '+5 dBm'],
      [0x04, '+4 dBm'],
      [0x03, '+3 dBm'],
      [0x02, '+2 dBm'],
      [0x00, '+0 dBm'],
      [0xfc, '-4 dBm'],
      [0xf8, '-8 dBm'],
      [0xf4, '-12 dBm'],
      [0xf0, '-16 dBm'],
      [0xec, '-20 dBm'],
      [0xff, '-40 dBm'],
      [0xd8, '-40 dBm'],
    ],
  },
  {
    key: 'BLE_DATA_TRANS_WKUP_INT_HOURS',
    label: 'BLE Data Wakeup Interval (h)',
    desc: 'Data transfer wake interval',
    kind: 'u8',
    index: OP_IDX.BLE_DATA_TRANS_WKUP_INT_HRS,
    min: 0,
    max: 255,
  },
  {
    key: 'BLE_DATA_TRANS_WKUP_TIME',
    label: 'BLE Data Wakeup Time',
    desc: 'LSB/MSB 16-bit value',
    kind: 'u16',
    index: OP_IDX.BLE_DATA_TRANS_WKUP_TIME,
    min: 0,
    max: 65535,
  },
  {
    key: 'BLE_DATA_TRANS_WKUP_DUR',
    label: 'BLE Data Wakeup Duration',
    desc: 'Duration in units used by firmware',
    kind: 'u8',
    index: OP_IDX.BLE_DATA_TRANS_WKUP_DUR,
    min: 0,
    max: 255,
  },
  {
    key: 'BLE_DATA_TRANS_RETRY_INT',
    label: 'BLE Data Retry Interval',
    desc: 'LSB/MSB 16-bit value',
    kind: 'u16',
    index: OP_IDX.BLE_DATA_TRANS_RETRY_INT,
    min: 0,
    max: 65535,
  },
  {
    key: 'BLE_STATUS_WKUP_INT_HOURS',
    label: 'BLE Status Wakeup Interval (h)',
    desc: 'Status wake interval',
    kind: 'u8',
    index: OP_IDX.BLE_STATUS_WKUP_INT_HRS,
    min: 0,
    max: 255,
  },
  {
    key: 'BLE_STATUS_WKUP_TIME',
    label: 'BLE Status Wakeup Time',
    desc: 'LSB/MSB 16-bit value',
    kind: 'u16',
    index: OP_IDX.BLE_STATUS_WKUP_TIME,
    min: 0,
    max: 65535,
  },
  {
    key: 'BLE_STATUS_WKUP_DUR',
    label: 'BLE Status Wakeup Duration',
    desc: 'Duration in units used by firmware',
    kind: 'u8',
    index: OP_IDX.BLE_STATUS_WKUP_DUR,
    min: 0,
    max: 255,
  },
  {
    key: 'BLE_STATUS_RETRY_INT',
    label: 'BLE Status Retry Interval',
    desc: 'LSB/MSB 16-bit value',
    kind: 'u16',
    index: OP_IDX.BLE_STATUS_RETRY_INT,
    min: 0,
    max: 65535,
  },
  {
    key: 'BLE_RTC_SYNC_WKUP_INT_HOURS',
    label: 'BLE RTC Sync Wakeup Interval (h)',
    desc: 'RTC sync wake interval',
    kind: 'u8',
    index: OP_IDX.BLE_RTC_SYNC_WKUP_INT_HRS,
    min: 0,
    max: 255,
  },
  {
    key: 'BLE_RTC_SYNC_WKUP_TIME',
    label: 'BLE RTC Sync Wakeup Time',
    desc: 'LSB/MSB 16-bit value',
    kind: 'u16',
    index: OP_IDX.BLE_RTC_SYNC_WKUP_TIME,
    min: 0,
    max: 65535,
  },
  {
    key: 'BLE_RTC_SYNC_WKUP_DUR',
    label: 'BLE RTC Sync Wakeup Duration',
    desc: 'Duration in units used by firmware',
    kind: 'u8',
    index: OP_IDX.BLE_RTC_SYNC_WKUP_DUR,
    min: 0,
    max: 255,
  },
  {
    key: 'BLE_RTC_SYNC_RETRY_INT',
    label: 'BLE RTC Sync Retry Interval',
    desc: 'LSB/MSB 16-bit value',
    kind: 'u16',
    index: OP_IDX.BLE_RTC_SYNC_RETRY_INT,
    min: 0,
    max: 65535,
  },

  // ADC/PPG
  {
    key: 'ADC_SAMPLE_RATE',
    label: 'ADC Sample Rate',
    desc: 'ADC sample rate code',
    kind: 'bit',
    index: OP_IDX.ADC_CHANNEL_SETTINGS_0,
    shift: 0,
    width: 6,
    options: [
      [0, 'Off'],
      [1, '32768.0 Hz'],
      [2, '16384.0 Hz'],
      [3, '8192.0 Hz'],
      [4, '6553.6 Hz'],
      [5, '4096.0 Hz'],
      [6, '3276.8 Hz'],
      [7, '2048.0 Hz'],
      [8, '1638.4 Hz'],
      [9, '1310.72 Hz'],
      [10, '1024.0 Hz'],
      [11, '819.2 Hz'],
      [12, '655.36 Hz'],
      [13, '512.0 Hz'],
      [14, '409.6 Hz'],
      [15, '327.68 Hz'],
      [16, '256.0 Hz'],
      [17, '204.8 Hz'],
      [18, '163.84 Hz'],
      [19, '128.0 Hz'],
      [20, '102.4 Hz'],
      [21, '81.92 Hz'],
      [22, '64.0 Hz'],
      [23, '51.2 Hz'],
      [24, '40.96 Hz'],
      [25, '32.0 Hz'],
      [26, '25.6 Hz'],
      [27, '20.48 Hz'],
      [28, '16.0 Hz'],
      [29, '12.8 Hz'],
      [30, '10.24 Hz'],
      [31, '8.0 Hz'],
      [32, '6.4 Hz'],
      [33, '5.12 Hz'],
      [34, '4.0 Hz'],
      [35, '3.2 Hz'],
      [36, '2.56 Hz'],
      [37, '2.0 Hz'],
      [38, '1.6 Hz'],
      [39, '1.28 Hz'],
      [40, '1.0 Hz'],
      [41, '0.8 Hz'],
      [42, '0.64 Hz'],
    ],
  },
  {
    key: 'ADC_OVERSAMPLE_RATE',
    label: 'ADC Oversample',
    desc: 'ADC oversampling',
    kind: 'bit',
    index: OP_IDX.ADC_CHANNEL_SETTINGS_1,
    shift: 4,
    width: 4,
    options: [
      [0, 'Disabled'],
      [1, '2x'],
      [2, '4x'],
      [3, '8x'],
      [4, '16x'],
      [5, '32x'],
      [6, '64x'],
      [7, '128x'],
      [8, '256x'],
    ],
  },
  {
    key: 'GSR_RANGE_SETTING',
    label: 'GSR Range',
    desc: '0:40k, 1:287k, 2:1M, 3:3.3M, 4:Auto',
    kind: 'bit',
    index: OP_IDX.ADC_CHANNEL_SETTINGS_1,
    shift: 0,
    width: 3,
    options: [
      [0, 'Range 0 (40k)'],
      [1, 'Range 1 (287k)'],
      [2, 'Range 2 (1M)'],
      [3, 'Range 3 (3.3M)'],
      [4, 'Auto'],
    ],
  },
  {
    key: 'ADAPTIVE_SCHEDULER_INTERVAL',
    label: 'Adaptive Scheduler Interval',
    desc: '16-bit adaptive scheduler interval',
    kind: 'u16',
    index: OP_IDX.ADAPTIVE_SCHEDULER_INT,
    min: 0,
    max: 65535,
  },
  {
    key: 'ADAPTIVE_SCHEDULER_FAILCOUNT_MAX',
    label: 'Adaptive Scheduler Failcount Max',
    desc: 'Maximum failed attempts',
    kind: 'u8',
    index: OP_IDX.ADAPTIVE_SCHEDULER_FAILCOUNT_MAX,
    min: 0,
    max: 255,
  },
  {
    key: 'PPG_REC_DUR_SECS',
    label: 'PPG Record Duration (s)',
    desc: '0 = always on',
    kind: 'u16',
    index: OP_IDX.PPG_REC_DUR_SECS_LSB,
    min: 0,
    max: 65535,
  },
  {
    key: 'PPG_REC_INT_MINS',
    label: 'PPG Record Interval (min)',
    desc: '0 = always on',
    kind: 'u16',
    index: OP_IDX.PPG_REC_INT_MINS_LSB,
    min: 0,
    max: 65535,
  },
  {
    key: 'SMP_AVE',
    label: 'PPG Sample Averaging',
    desc: 'FIFO sample averaging',
    kind: 'bit',
    index: OP_IDX.PPG_FIFO_CONFIG,
    shift: 5,
    width: 3,
    options: [
      [0, '1'],
      [1, '2'],
      [2, '4'],
      [3, '8'],
      [4, '16'],
      [5, '32'],
      [6, '32'],
      [7, '32'],
    ],
  },
  {
    key: 'PPG_ADC_RGE',
    label: 'PPG ADC Range',
    desc: 'ADC range / full-scale',
    kind: 'bit',
    index: OP_IDX.PPG_MODE_CONFIG2,
    shift: 5,
    width: 2,
    options: [
      [0, '7.8125 / 4096'],
      [1, '15.625 / 8192'],
      [2, '31.25 / 16384'],
      [3, '62.5 / 32768'],
    ],
  },
  {
    key: 'PPG_SR',
    label: 'PPG Sample Rate',
    desc: 'PPG sample rate',
    kind: 'bit',
    index: OP_IDX.PPG_MODE_CONFIG2,
    shift: 2,
    width: 3,
    options: [
      [0, '50 Hz'],
      [1, '100 Hz'],
      [2, '200 Hz'],
      [3, '400 Hz'],
      [4, '800 Hz'],
      [5, '1000 Hz'],
      [6, '1600 Hz'],
      [7, '3200 Hz'],
    ],
  },
  {
    key: 'PPG_LED_PW',
    label: 'PPG LED Pulse Width',
    desc: '50/100/200/400 us',
    kind: 'bit',
    index: OP_IDX.PPG_MODE_CONFIG2,
    shift: 0,
    width: 2,
    options: [
      [0, '50 us'],
      [1, '100 us'],
      [2, '200 us'],
      [3, '400 us'],
    ],
  },
  {
    key: 'PPG_MA_DEFAULT',
    label: 'PPG MA Default',
    desc: 'Default LED current (mA)',
    kind: 'u8',
    index: OP_IDX.PPG_MA_DEFAULT,
    min: 0,
    max: 255,
  },
  {
    key: 'PPG_MA_MAX_RED_IR',
    label: 'PPG MA Max Red/IR',
    desc: 'Max current for Red/IR (mA)',
    kind: 'u8',
    index: OP_IDX.PPG_MA_MAX_RED_IR,
    min: 0,
    max: 255,
  },
  {
    key: 'PPG_MA_MAX_GREEN_BLUE',
    label: 'PPG MA Max Green/Blue',
    desc: 'Max current for Green/Blue (mA)',
    kind: 'u8',
    index: OP_IDX.PPG_MA_MAX_GREEN_BLUE,
    min: 0,
    max: 255,
  },
  {
    key: 'PPG_AGC_TARGET_PERCENT_OF_RANGE',
    label: 'PPG AGC Target %',
    desc: 'AGC target percent of range',
    kind: 'u8',
    index: OP_IDX.PPG_AGC_TARGET_PERCENT_OF_RANGE,
    min: 0,
    max: 100,
  },
  {
    key: 'PPG_UNUSED_BYTE',
    label: 'PPG Unused Byte',
    desc: 'Reserved byte 65',
    kind: 'u8',
    index: 65,
    min: 0,
    max: 255,
  },
  {
    key: 'PPG_MA_LED_PILOT',
    label: 'PPG MA LED Pilot',
    desc: 'Pilot/proximity LED current',
    kind: 'u8',
    index: OP_IDX.PPG_MA_LED_PILOT,
    min: 0,
    max: 255,
  },
  {
    key: 'XTALK_DAC1',
    label: 'PPG DAC1 Crosstalk',
    desc: '5-bit value',
    kind: 'u8',
    index: OP_IDX.PPG_DAC1_CROSSTALK,
    min: 0,
    max: 31,
  },
  {
    key: 'XTALK_DAC2',
    label: 'PPG DAC2 Crosstalk',
    desc: '5-bit value',
    kind: 'u8',
    index: OP_IDX.PPG_DAC2_CROSSTALK,
    min: 0,
    max: 31,
  },
  {
    key: 'XTALK_DAC3',
    label: 'PPG DAC3 Crosstalk',
    desc: '5-bit value',
    kind: 'u8',
    index: OP_IDX.PPG_DAC3_CROSSTALK,
    min: 0,
    max: 31,
  },
  {
    key: 'XTALK_DAC4',
    label: 'PPG DAC4 Crosstalk',
    desc: '5-bit value',
    kind: 'u8',
    index: OP_IDX.PPG_DAC4_CROSSTALK,
    min: 0,
    max: 31,
  },
  {
    key: 'PROX_AGC_MODE',
    label: 'Proximity/AGC Mode',
    desc: '0 Disabled, 1 Driver approach, 2 Hybrid',
    kind: 'u8',
    index: OP_IDX.PROX_AGC_MODE,
    options: [
      [0, 'AGC Off / Prox Off'],
      [1, 'AGC On / Driver Prox'],
      [2, 'AGC On / Hybrid Prox'],
    ],
  },

  // -------------------------------------------------------------------------
  // v9 second-generation sensor settings (light / skin-temp / algo-hub / LED)
  // -------------------------------------------------------------------------
  // OP_CONFIG_VERSION (byte 9) is an internal layout marker, not a user setting.
  // It is auto-stamped on serialize (see VERISENSE_OP_CONFIG_VERSION_V9 /
  // createBlankVerisenseOperationalConfig), so it is intentionally NOT an
  // editable field here.
  // AMBIENT_LIGHT_EN / SKIN_TEMP_EN / ALGO_HUB_EN are sensor enables and are
  // rendered as checkboxes (see VERISENSE_SENSOR_ENABLE_FIELDS), not here.
  // GEN_CFG_3 bit 6 is reserved (was PPG_VIA_HUB): the MAX86176 is hardwired to
  // the hub, so raw PPG always arrives under the PPG sensor id (4) when a PPG
  // channel is enabled, and the algorithm output under id 8 when ALGO_HUB_EN is
  // set - no routing bit is needed.
  {
    key: 'LIGHT_GAIN_INDEX',
    label: 'Light Gain',
    desc: 'VD6283 gain index (0=1.0x .. 7=66.67x)',
    kind: 'u8',
    index: OP_IDX.LIGHT_GAIN_INDEX,
    min: 0,
    max: 7,
  },
  {
    key: 'LIGHT_EXPOSURE_INDEX',
    label: 'Light Exposure',
    desc: 'VD6283 exposure time index (0=default)',
    kind: 'u8',
    index: OP_IDX.LIGHT_EXPOSURE_INDEX,
    min: 0,
    max: 7,
  },
  {
    key: 'LIGHT_CONTINUOUS_MODE',
    label: 'Light Continuous Mode',
    desc: '0 = single-shot, 1 = continuous',
    kind: 'bit',
    index: OP_IDX.LIGHT_CONFIG,
    shift: 0,
    width: 1,
    options: [
      [0, 'Single-shot'],
      [1, 'Continuous'],
    ],
  },
  {
    key: 'LIGHT_DARK_ENABLE',
    label: 'Light Dark Channel',
    desc: 'Expose the dark/background channel',
    kind: 'bit',
    index: OP_IDX.LIGHT_CONFIG,
    shift: 1,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'LIGHT_FLICKER_EN',
    label: 'Light Flicker Detect',
    desc: 'RESERVED: VD6283 flicker detection (host PDM path pending nRF SDK v17 — not yet active)',
    kind: 'bit',
    index: OP_IDX.LIGHT_CONFIG,
    shift: 2,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled (reserved)'],
    ],
  },
  {
    key: 'LIGHT_SAMPLE_RATE_INDEX',
    label: 'Light Sample Rate',
    desc: 'Ambient-light polling rate (max ~10 Hz — the VD6283 continuous-mode period is bounded by the fixed 100 ms inter-measurement time, so 20 Hz is never reachable). A long exposure lowers the achievable rate further.',
    kind: 'u8',
    index: OP_IDX.LIGHT_SAMPLE_RATE_INDEX,
    min: 0,
    max: 5,
    options: [
      [0, 'Off'],
      [1, '0.5 Hz'],
      [2, '1 Hz'],
      [3, '2 Hz'],
      [4, '5 Hz'],
      [5, '10 Hz'],
    ],
  },
  {
    key: 'SKIN_TEMP_MEAS_TYPE',
    label: 'Skin Temp Mode',
    desc: 'MLX90632 measurement type (default Medical for skin/body temperature)',
    kind: 'bit',
    index: OP_IDX.SKIN_TEMP_CONFIG,
    shift: 0,
    width: 1,
    options: [
      [0, 'Medical (25–42.5 °C, ±0.2 °C)'],
      [1, 'Extended (wider range, lower accuracy)'],
    ],
  },
  {
    // Single skin-temp rate setting. Stored as the MLX90632 refresh-rate code
    // (byte 76 bits 3:1); the firmware sets the chip refresh AND derives the read
    // poll from it. Shown as the *medical* output rate (= refresh ÷ 2; extended
    // mode is ÷ 3). The legacy poll field (byte 77) and power-mode bits (byte 76
    // bits 5:4) are now unused (free to repurpose) — continuous mode is required
    // and set automatically.
    key: 'SKIN_TEMP_SAMPLE_RATE',
    label: 'Skin Temp Sample Rate',
    desc: 'MLX90632 sample rate (medical output = chip refresh ÷2; extended ÷3). Drives both the chip refresh and the read poll. Byte 76 bits 3:1.',
    kind: 'bit',
    index: OP_IDX.SKIN_TEMP_CONFIG,
    shift: 1,
    width: 3,
    options: [
      [0, '0.25 Hz'],
      [1, '0.5 Hz'],
      [2, '1 Hz'],
      [3, '2 Hz'],
      [4, '4 Hz'],
      [5, '8 Hz'],
      [6, '16 Hz'],
      [7, '32 Hz'],
    ],
  },
  {
    key: 'ALGO_OP_MODE',
    label: 'Algo Operation Mode',
    desc: 'MAX32674 sensor-hub operation mode',
    kind: 'u8',
    index: OP_IDX.ALGO_OP_MODE,
    min: 0,
    max: 5,
    options: [
      [0, 'Raw'],
      [1, 'WHRM (HR)'],
      [3, 'IRN'],
      [4, 'HRV'],
      [5, 'RR'],
    ],
  },
  {
    key: 'ALGO_REPORT_MODE',
    label: 'Algo Report Mode',
    desc: 'Sensor-hub report mode',
    kind: 'bit',
    index: OP_IDX.ALGO_REPORT_MODE_RATE,
    shift: 0,
    width: 2,
    options: [
      [1, 'Basic'],
      [2, 'Extended'],
    ],
  },
  {
    key: 'ALGO_REPORT_PERIOD',
    label: 'Algo Report Period',
    desc: 'Sensor-hub report period code',
    kind: 'bit',
    index: OP_IDX.ALGO_REPORT_MODE_RATE,
    shift: 2,
    width: 6,
  },
  {
    key: 'ALGO_AFE_ENABLE',
    label: 'Algo AFE Enable',
    desc: 'Let the hub drive the AFE',
    kind: 'bit',
    index: OP_IDX.ALGO_CONTROL,
    shift: 0,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'ALGO_SCD_ENABLE',
    label: 'Algo Skin Contact Detect',
    desc: 'Enable skin-contact detection',
    kind: 'bit',
    index: OP_IDX.ALGO_CONTROL,
    shift: 1,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'ALGO_AUTO_PD_ENABLE',
    label: 'Algo Auto PD Current',
    desc: 'Enable automatic photodiode current control',
    kind: 'bit',
    index: OP_IDX.ALGO_CONTROL,
    shift: 2,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'ALGO_INITIAL_HR',
    label: 'Algo Initial HR',
    desc: 'Optional WHRM initial heart-rate seed (bpm, 0 = none)',
    kind: 'u8',
    index: OP_IDX.ALGO_INITIAL_HR,
    min: 0,
    max: 255,
  },
  {
    key: 'LED_AUTO_BRIGHTNESS_ENABLE',
    label: 'LED Auto-Brightness',
    desc: 'Drive RGB LED brightness from ambient light',
    kind: 'bit',
    index: OP_IDX.LED_AUTO_BRIGHTNESS_CFG,
    shift: 0,
    width: 1,
    options: [
      [0, 'Disabled'],
      [1, 'Enabled'],
    ],
  },
  {
    key: 'LED_MAX_BRIGHTNESS',
    label: 'LED Max Brightness',
    desc: 'Ceiling for auto-brightness mode (0-255)',
    kind: 'u8',
    index: OP_IDX.LED_MAX_BRIGHTNESS,
    min: 0,
    max: 255,
  },
  {
    key: 'LED_LUX_THRESHOLD',
    label: 'LED Lux Threshold',
    desc: 'Below this ambient level the LED stays at max brightness',
    kind: 'u16',
    index: OP_IDX.LED_LUX_THRESHOLD,
    min: 0,
    max: 65535,
  },
];

export const VERISENSE_OP_CONFIG_BYTE_SIZE = 86;
export type VerisenseOperationalField = VerisenseOperationalFieldDefinition;

export function createBlankVerisenseOperationalConfig(
  byteSize = VERISENSE_OP_CONFIG_BYTE_SIZE,
): Uint8Array {
  const blank = new Uint8Array(byteSize);
  blank[0] = 0x5a;
  // Stamp the layout version so v9-sized configs are recognised as second-gen.
  if (byteSize >= VERISENSE_OP_CONFIG_BYTE_SIZE) {
    blank[OP_IDX.OP_CONFIG_VERSION] = OP_CONFIG_VERSION_V9;
  }
  return blank;
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function readVerisenseOperationalFieldValue(
  op: Uint8Array,
  field: VerisenseOperationalField,
): number {
  if (field.kind === 'bit') {
    const width = field.width ?? 1;
    const shift = field.shift ?? 0;
    const mask = (1 << width) - 1;
    return (op[field.index] >> shift) & mask;
  }
  if (field.kind === 'u8') return op[field.index] & 0xff;
  if (field.kind === 'u16') {
    return (op[field.index] & 0xff) | ((op[field.index + 1] & 0xff) << 8);
  }
  if (field.kind === 'u32') {
    return (
      ((op[field.index] & 0xff) |
        ((op[field.index + 1] & 0xff) << 8) |
        ((op[field.index + 2] & 0xff) << 16) |
        ((op[field.index + 3] & 0xff) << 24)) >>>
      0
    );
  }
  if (field.kind === 'inactiveResume') {
    return op[field.index] & (0x01 << 6) ? 1 : 0;
  }
  if (field.kind === 'inactiveMinutes') {
    return op[field.index] & 0x3f;
  }
  return 0;
}

export function writeVerisenseOperationalFieldValue(
  op: Uint8Array,
  field: VerisenseOperationalField,
  rawValue: unknown,
): void {
  if (field.kind === 'bit') {
    const width = field.width ?? 1;
    const shift = field.shift ?? 0;
    const mask = (1 << width) - 1;
    const value = clampInt(rawValue, 0, mask);
    op[field.index] = (op[field.index] & ~(mask << shift)) | ((value & mask) << shift);
    return;
  }
  if (field.kind === 'u8') {
    op[field.index] = clampInt(rawValue, field.min ?? 0, field.max ?? 255) & 0xff;
    return;
  }
  if (field.kind === 'u16') {
    const value = clampInt(rawValue, field.min ?? 0, field.max ?? 65535);
    op[field.index] = value & 0xff;
    op[field.index + 1] = (value >> 8) & 0xff;
    return;
  }
  if (field.kind === 'u32') {
    const value = clampInt(rawValue, field.min ?? 0, field.max ?? 4294967295) >>> 0;
    op[field.index] = value & 0xff;
    op[field.index + 1] = (value >> 8) & 0xff;
    op[field.index + 2] = (value >> 16) & 0xff;
    op[field.index + 3] = (value >> 24) & 0xff;
    return;
  }
  if (field.kind === 'inactiveResume') {
    const enabled = clampInt(rawValue, 0, 1) === 1;
    op[field.index] = enabled ? op[field.index] | (0x01 << 6) : op[field.index] & ~(0x01 << 6);
    return;
  }
  if (field.kind === 'inactiveMinutes') {
    const minutes = clampInt(rawValue, field.min ?? 0, field.max ?? 63) & 0x3f;
    op[field.index] = (op[field.index] & 0xc0) | minutes;
  }
}

export function setVerisenseOperationalBitRange(
  op: Uint8Array,
  index: number,
  shift: number,
  width: number,
  rawValue: unknown,
): void {
  const mask = (1 << width) - 1;
  const value = clampInt(rawValue, 0, mask);
  op[index] = (op[index] & ~(mask << shift)) | ((value & mask) << shift);
}

export interface VerisenseOperationalSensorEnableField {
  readonly key: string;
  readonly index: number;
  readonly shift: number;
}

export const VERISENSE_SENSOR_ENABLE_FIELDS: readonly VerisenseOperationalSensorEnableField[] = [
  { key: 'ACCEL_1_EN', index: OP_IDX.GEN_CFG_0, shift: 7 },
  { key: 'ACCEL_2_EN', index: OP_IDX.GEN_CFG_0, shift: 6 },
  { key: 'GYRO_EN', index: OP_IDX.GEN_CFG_0, shift: 5 },
  { key: 'MAG_EN', index: OP_IDX.GEN_CFG_3, shift: 2 },
  { key: 'GSR_EN', index: OP_IDX.GEN_CFG_1, shift: 7 },
  { key: 'PPG_GREEN_EN', index: OP_IDX.GEN_CFG_1, shift: 6 },
  { key: 'PPG_RED_EN', index: OP_IDX.GEN_CFG_1, shift: 5 },
  { key: 'PPG_IR_EN', index: OP_IDX.GEN_CFG_1, shift: 4 },
  { key: 'ECG_EN', index: OP_IDX.GEN_CFG_1, shift: 3 },
  { key: 'PPG_BLUE_EN', index: OP_IDX.GEN_CFG_1, shift: 2 },
  { key: 'VPROG_EN', index: OP_IDX.GEN_CFG_2, shift: 2 },
  { key: 'VBATT_EN', index: OP_IDX.GEN_CFG_2, shift: 1 },
  // v9 second-generation sensors. On 2nd-gen the raw PPG (id 4) is gated by the
  // existing PPG channel enables above; ALGO_HUB_EN gates the algorithm (id 8).
  { key: 'AMBIENT_LIGHT_EN', index: OP_IDX.GEN_CFG_3, shift: 3 },
  { key: 'SKIN_TEMP_EN', index: OP_IDX.GEN_CFG_3, shift: 4 },
  { key: 'ALGO_HUB_EN', index: OP_IDX.GEN_CFG_3, shift: 5 },
];

export interface VerisenseOperationalFieldGroupDefinition {
  readonly id: string;
  readonly title: string;
  readonly openByDefault: boolean;
  readonly keys: readonly string[];
}

export const VERISENSE_OPERATIONAL_FIELD_GROUPS: readonly VerisenseOperationalFieldGroupDefinition[] =
  [
    {
      id: 'gen',
      title: 'General / Sensors',
      openByDefault: false,
      keys: [
        'BLUETOOTH_EN',
        'USB_EN',
        'PRIORITISE_LONG_TERM_FLASH',
        'DEVICE_EN',
        'RECORDING_EN',
        'DATA_COMPRESSION_MODE',
        'HR_PPG_CHANNEL',
        'STEP_COUNT_EN',
        'PENDING_EVENTS_SCHEDULER_DISABLED',
        'BATT_TYPE',
        'MAG_EN',
        'LED_MODE',
      ],
    },
    {
      id: 'accel1',
      title: 'Accel1',
      openByDefault: false,
      keys: [
        'ODR',
        'MODE',
        'LP_MODE',
        'BW_FILT',
        'FS',
        'FDS',
        'LOW_NOISE',
        'HP_REF_MODE',
        'FMode',
        'FTH',
      ],
    },
    {
      id: 'gyro_accel2',
      title: 'Gyro / Accel2',
      openByDefault: false,
      keys: [
        'FTH_LSB',
        'TIMER_PEDO_FIFDO_EN',
        'TIMER_PEDO_FIFO_DRDY',
        'FTH_MSB',
        'DEC_FIFO_GYRO',
        'DEC_FIFO_XL',
        'ODR_FIFO',
        'FIFO_MODE',
        'ODR_XL',
        'FS_XL',
        'BW_XL',
        'ODR_G',
        'FS_G',
        'FS_125',
        'G_HM_MODE',
        'HP_G_EN',
        'HPCF_G',
        'HP_G_RST',
        'ROUNDING_STATUS',
        'LPF2_XL_EN',
        'HPCF_XL',
        'HP_SLOPE_XL_EN',
        'LOW_PASS_ON_6D',
      ],
    },
    {
      id: 'lsm6dsv',
      title: 'LSM6DSV / LIS2MDL',
      openByDefault: false,
      keys: ['LSM6DSV_ODR_XL', 'LSM6DSV_FS_XL', 'LSM6DSV_ODR_G', 'LSM6DSV_FS_G', 'LIS2MDL_ODR'],
    },
    {
      id: 'scheduler_ble',
      title: 'Schedule / BLE Wake',
      openByDefault: false,
      keys: [
        'START_TIME',
        'END_TIME',
        'RESUME_REC_ON_ACTIVITY',
        'INACTIVE_TIMEOUT_MINUTES',
        'BLE_CONNECTION_TRIES_PER_DAY',
        'BLE_TX_POWER',
        'BLE_DATA_TRANS_WKUP_INT_HOURS',
        'BLE_DATA_TRANS_WKUP_TIME',
        'BLE_DATA_TRANS_WKUP_DUR',
        'BLE_DATA_TRANS_RETRY_INT',
        'BLE_STATUS_WKUP_INT_HOURS',
        'BLE_STATUS_WKUP_TIME',
        'BLE_STATUS_WKUP_DUR',
        'BLE_STATUS_RETRY_INT',
        'BLE_RTC_SYNC_WKUP_INT_HOURS',
        'BLE_RTC_SYNC_WKUP_TIME',
        'BLE_RTC_SYNC_WKUP_DUR',
        'BLE_RTC_SYNC_RETRY_INT',
      ],
    },
    {
      id: 'adc_gsr',
      title: 'ADC / GSR',
      openByDefault: false,
      keys: [
        'ADC_SAMPLE_RATE',
        'ADC_OVERSAMPLE_RATE',
        'GSR_RANGE_SETTING',
        'ADAPTIVE_SCHEDULER_INTERVAL',
        'ADAPTIVE_SCHEDULER_FAILCOUNT_MAX',
      ],
    },
    {
      id: 'ppg',
      title: 'PPG',
      openByDefault: false,
      keys: [
        'PPG_REC_DUR_SECS',
        'PPG_REC_INT_MINS',
        'SMP_AVE',
        'PPG_ADC_RGE',
        'PPG_SR',
        'PPG_LED_PW',
        'PPG_MA_DEFAULT',
        'PPG_MA_MAX_RED_IR',
        'PPG_MA_MAX_GREEN_BLUE',
        'PPG_AGC_TARGET_PERCENT_OF_RANGE',
        'PPG_UNUSED_BYTE',
        'PPG_MA_LED_PILOT',
        'XTALK_DAC1',
        'XTALK_DAC2',
        'XTALK_DAC3',
        'XTALK_DAC4',
        'PROX_AGC_MODE',
      ],
    },
    {
      id: 'light',
      title: 'Ambient Light (VD6283)',
      openByDefault: false,
      keys: [
        'LIGHT_GAIN_INDEX',
        'LIGHT_EXPOSURE_INDEX',
        'LIGHT_CONTINUOUS_MODE',
        'LIGHT_DARK_ENABLE',
        'LIGHT_FLICKER_EN',
        'LIGHT_SAMPLE_RATE_INDEX',
      ],
    },
    {
      id: 'skin_temp',
      title: 'Skin Temperature (MLX90632)',
      openByDefault: false,
      keys: ['SKIN_TEMP_MEAS_TYPE', 'SKIN_TEMP_SAMPLE_RATE'],
    },
    {
      id: 'algo',
      title: 'Algorithm Hub (MAX32674)',
      openByDefault: false,
      keys: [
        'ALGO_OP_MODE',
        'ALGO_REPORT_MODE',
        'ALGO_REPORT_PERIOD',
        'ALGO_AFE_ENABLE',
        'ALGO_SCD_ENABLE',
        'ALGO_AUTO_PD_ENABLE',
        'ALGO_INITIAL_HR',
      ],
    },
    {
      id: 'led',
      title: 'LED Auto-Brightness',
      openByDefault: false,
      keys: ['LED_AUTO_BRIGHTNESS_ENABLE', 'LED_MAX_BRIGHTNESS', 'LED_LUX_THRESHOLD'],
    },
  ];

export const VERISENSE_OPERATIONAL_FIELD_FALLBACK_GROUP_ID = 'gen';
