"""One-shot fixture generator for the TypeScript PPK2 codec tests.

Runs the *original Python* ppk2_api implementation (no PPK2 hardware needed --
the serial port is mocked) over synthetic inputs and dumps its outputs as the
ground truth that tests/instruments/ppk2/*.test.ts compare the TypeScript port
against.

Usage (from this directory):
    python generate_fixtures.py

Requires the ppk2-api package (the production test PC setup already has it:
C:\\Python310\\Lib\\site-packages\\ppk2_api).
"""

import base64
import json
import os
from unittest import mock

import serial  # noqa: F401  (pyserial; only mocked, never opened)
from ppk2_api.ppk2_api import PPK2_API

HERE = os.path.dirname(os.path.abspath(__file__))

# Plausible calibrated-device modifiers (shape matches a real metadata blob).
CALIBRATED_MODIFIERS = {
    "Calibrated": "0",
    "R": {"0": 1003.3506, "1": 101.5865, "2": 10.2101, "3": 0.9433, "4": 0.0422},
    "GS": {"0": 0.0, "1": 0.0, "2": 0.0001, "3": 0.0154, "4": 0.07},
    "GI": {"0": 1.0, "1": 0.9997, "2": 0.9973, "3": 0.9905, "4": 0.9388},
    "O": {"0": 112.942, "1": 75.4848, "2": 64.5762, "3": 50.4691, "4": 27.0347},
    "S": {"0": 0.000000375, "1": 0.0000039, "2": 0.0000287, "3": 0.000278, "4": 0.005151},
    "I": {"0": -0.0000000037, "1": -0.0000009, "2": 0.0000119, "3": 0.0001945, "4": 0.0175},
    "UG": {"0": 1.0, "1": 1.0, "2": 1.0004, "3": 1.0027, "4": 1.0058},
    "HW": "9173",
    "IA": "56",
}

METADATA_TEXT = (
    "Calibrated: 0\n"
    "R0: 1003.3506\n"
    "R1: 101.5865\n"
    "R2: 0\n"  # broken zero calibration -> must be ignored (default retained)
    "R3: 0.9433\n"
    "R4: 0.0422\n"
    "GS0: 0.0\n"
    "GS1: 0.0\n"
    "GS2: 0.0001\n"
    "GS3: 0.0154\n"
    "GS4: 0.07\n"
    "GI0: 1.0\n"
    "GI1: 0.9997\n"
    "GI2: 0.9973\n"
    "GI3: 0.9905\n"
    "GI4: 0.9388\n"
    "O0: 112.9420\n"
    "O1: 75.4848\n"
    "O2: 64.5762\n"
    "O3: 50.4691\n"
    "O4: 27.0347\n"
    "S0: 0.000000375\n"
    "S1: 0.0000039\n"
    "S2: 0.0000287\n"
    "S3: 0.000278\n"
    "S4: 0.005151\n"
    "I0: -0.0000000037\n"
    "I1: -0.0000009\n"
    "I2: 0.0000119\n"
    "I3: 0.0001945\n"
    "I4: 0.0175\n"
    "UG0: 1.0\n"
    "UG1: 1.0\n"
    "UG2: 1.0004\n"
    "UG3: 1.0027\n"
    "UG4: 1.0058\n"
    "VDD: 3700\n"
    "mode: 2\n"
    "HW: 9173\n"
    "IA: 56\n"
    "END\n"
)


def make_api(modifiers=None, vdd_mv=3700):
    with mock.patch.object(serial, "Serial"):
        api = PPK2_API("MOCK")
    if modifiers is not None:
        # Deep-ish copy so each vector starts from clean state
        api.modifiers = json.loads(json.dumps(modifiers))
    api.current_vdd = vdd_mv
    return api


def word(adc14, rng, logic=0):
    value = (adc14 & 0x3FFF) | ((rng & 0x7) << 14) | ((logic & 0xFF) << 24)
    return value.to_bytes(4, "little")


def modifiers_to_arrays(modifiers):
    def table(key):
        return [modifiers[key][str(i)] for i in range(5)]

    return {
        "calibrated": modifiers.get("Calibrated"),
        "hw": modifiers.get("HW"),
        "ia": modifiers.get("IA"),
        "r": table("R"),
        "gs": table("GS"),
        "gi": table("GI"),
        "o": table("O"),
        "s": table("S"),
        "i": table("I"),
        "ug": table("UG"),
    }


def decode_vector(name, modifiers, vdd_mv, raw):
    api = make_api(modifiers, vdd_mv)
    samples, raw_digital = api.get_samples(raw)
    return {
        "name": name,
        "vddMv": vdd_mv,
        "modifiers": modifiers_to_arrays(api.modifiers),
        "rawBase64": base64.b64encode(raw).decode("ascii"),
        "expectedMicroAmps": samples,
        "expectedLogic": raw_digital,
    }


def build_decode_vectors():
    vectors = []

    # 1. Default (uncalibrated) modifiers, single range, ADC ramp.
    raw = b"".join(word(100 + 37 * i, 2) for i in range(48))
    vectors.append(decode_vector("uncalibrated_single_range", None, 3700, raw))

    # 2. Calibrated modifiers, range transitions engaging the spike filter,
    #    including range 4 (the rolling-average restore branch) and a return
    #    to lower ranges.
    seq = (
        [(3000, 0)] * 6
        + [(2900, 1)] * 5
        + [(2800, 2)] * 5
        + [(2700, 3)] * 5
        + [(2600, 4)] * 2  # < 2 consecutive samples in range 4
        + [(2500, 3)] * 4
        + [(2400, 4)] * 8  # sustained range 4
        + [(2300, 2)] * 6
        + [(2200, 4)] * 1  # single-sample spike into range 4
        + [(2100, 2)] * 6
    )
    raw = b"".join(word(a, r) for a, r in seq)
    vectors.append(decode_vector("calibrated_range_transitions", CALIBRATED_MODIFIERS, 3700, raw))

    # 3. Logic-port bits preserved alongside the analog samples.
    raw = b"".join(word(1234, 3, logic=(i * 17) & 0xFF) for i in range(32))
    vectors.append(decode_vector("logic_bits", CALIBRATED_MODIFIERS, 5000, raw))

    # 4. Low source voltage exercises the S*(vdd/1000) term differently.
    raw = b"".join(word(600 + 11 * i, 1) for i in range(24))
    vectors.append(decode_vector("uncalibrated_low_vdd", None, 800, raw))

    return vectors


def build_voltage_vectors():
    api = make_api()
    vectors = []
    for mv in [500, 800, 801, 1000, 1056, 2000, 3000, 3300, 3700, 4200, 5000, 6000]:
        b1, b2 = api._convert_source_voltage(mv)
        vectors.append({"mv": mv, "bytes": [b1, b2]})
    return vectors


def build_metadata_fixture():
    api = make_api()
    ok = api._parse_metadata(METADATA_TEXT)
    assert ok, "Python metadata parse failed"
    return {"text": METADATA_TEXT, "expected": modifiers_to_arrays(api.modifiers)}


def main():
    fixture = {
        "generatedBy": "generate_fixtures.py against ppk2_api (Python reference)",
        "voltageVectors": build_voltage_vectors(),
        "metadata": build_metadata_fixture(),
        "decodeVectors": build_decode_vectors(),
    }
    out_path = os.path.join(HERE, "ppk2-fixtures.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=1)
    print(f"Wrote {out_path}")
    for v in fixture["decodeVectors"]:
        print(f"  {v['name']}: {len(v['expectedMicroAmps'])} samples")


if __name__ == "__main__":
    main()
