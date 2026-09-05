"""
test_dht22_worker.py — the DHT22 reply the QEMU ESP32 worker drives
(`app.services.esp32_dht22`), and the run policy around it.

Two guests read the same frame here, the way the two driver families do on the
real chip:

  * MicroPython's `dht_readinto` (drivers/dht/dht.c, v1.28) times pulses with
    `machine_time_pulse_us`: 100 us per phase, a '1' is a HIGH over 48 us.
  * Adafruit's DHT.h counts `digitalRead()` iterations per pulse and compares
    the HIGH count against the preceding 50 us LOW count.

The reply must decode under both, at read spacings from the ~0.5 us a guest
gets under `-icount` to the 40-90 us it gets without (issue #291).
"""

from __future__ import annotations

import unittest

from app.services.esp32_dht22 import (
    BIT0_HIGH_US,
    BIT1_HIGH_US,
    BIT_LOW_US,
    RESPONSE_HIGH_US,
    RESPONSE_LOW_US,
    STALL_CAP_US,
    Dht22Reply,
    Dht22Trigger,
    coerce_number,
    dht22_payload,
    dht22_phases,
)
from app.services.esp32_flash_image import firmware_is_micropython
from app.services.esp32_worker import (
    ICOUNT_SHIFT_C3,
    ICOUNT_SHIFT_LINE_SENSORS,
    icount_shift_for_run,
)


# ── the two guests ───────────────────────────────────────────────────────────

class Pad:
    """The pad as QEMU holds it: the level the host last drove."""

    def __init__(self) -> None:
        self.level = 1
        self.edges: list[tuple[float, int]] = []

    def set(self, level: int) -> None:
        self.level = level


class GuestClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t


def run_guest(reply: Dht22Reply, pad: Pad, clock: GuestClock, decoder,
              first_read_delay_us: float, read_interval_us: float,
              stall_at_read: int | None = None, stall_us: float = 0.0,
              max_reads: int = 200_000):
    """Drive `reply` the way QEMU does: one step per guest read, the guest
    reading the pad right after. `decoder.sample(t, level)` returns None to keep
    reading or a result."""
    clock.t += first_read_delay_us
    for n in range(max_reads):
        if stall_at_read is not None and n == stall_at_read:
            clock.t += stall_us
        reply.step()
        pad.edges.append((clock.t, pad.level))
        r = decoder.sample(clock.t, pad.level)
        if r is not None:
            return r
        clock.t += read_interval_us
    raise AssertionError('the guest never finished')


class MicroPythonDht:
    """drivers/dht/dht.c after the release: wait for LOW (100 us), one pulse of
    150 us budget, then 40 pulses of 100 us budget, bit = HIGH > 48 us.
    `machine_time_pulse_us` samples the clock BEFORE each read, as the C does."""

    def __init__(self) -> None:
        self.state = 'wait_low'
        self.t0 = None
        self.pulse_level = 1
        self.nchanges = 2
        self.timeout = 150
        self.bits: list[int] = []

    def sample(self, t: float, level: int):
        if self.state == 'wait_low':
            if self.t0 is None:
                self.t0 = t
            if level == 0:
                self._start_pulse(t, 150)
                return None
            return 'timeout' if t - self.t0 > 100 else None
        # inside machine_time_pulse_us
        if level == self.pulse_level:
            self.pulse_level = 1 - self.pulse_level
            self.nchanges -= 1
            if self.nchanges == 0:
                dur = t - self.t0
                if self.state == 'preamble':
                    self._start_pulse(t, 100)
                    self.state = 'bits'
                    return None
                self.bits.append(1 if dur > 48 else 0)
                if len(self.bits) == 40:
                    out = bytes(int(''.join(map(str, self.bits[i:i + 8])), 2) for i in range(0, 40, 8))
                    return out
                self._start_pulse(t, 100)
                return None
            self.t0 = t
            return None
        if t - self.t0 >= self.timeout:
            return 'timeout'
        return None

    def _start_pulse(self, t: float, timeout: int) -> None:
        if self.state == 'wait_low':
            self.state = 'preamble'
        self.t0 = t
        self.pulse_level = 1
        self.nchanges = 2
        self.timeout = timeout


class AdafruitDht:
    """DHT.h: expectPulse(LOW), expectPulse(HIGH), then 40 x (LOW count, HIGH
    count); bit = highCount > lowCount. Counts reads, never the clock."""

    MAXCYCLES = 240_000

    def __init__(self) -> None:
        self.expect = 0
        self.count = 0
        self.pulses: list[int] = []

    def sample(self, t: float, level: int):
        if level == self.expect:
            self.count += 1
            if self.count >= self.MAXCYCLES:
                return 'timeout'
            return None
        self.pulses.append(self.count)
        self.count = 0
        self.expect = 1 - self.expect
        if len(self.pulses) == 82:
            data = self.pulses[2:]
            bits = [1 if data[2 * i + 1] > data[2 * i] else 0 for i in range(40)]
            return bytes(int(''.join(map(str, bits[i:i + 8])), 2) for i in range(0, 40, 8))
        return None


def make_reply(temp=28.0, hum=55.0):
    pad, clock = Pad(), GuestClock()
    reply = Dht22Reply(dht22_phases(dht22_payload(temp, hum)), pad.set, clock.now)
    return reply, pad, clock


EXPECTED = bytes(dht22_payload(28.0, 55.0))


# ── payload ──────────────────────────────────────────────────────────────────

class TestPayload(unittest.TestCase):
    def test_positive(self):
        self.assertEqual(dht22_payload(28.0, 55.0), [2, 38, 1, 24, 65])

    def test_negative_temperature_sets_sign_bit(self):
        p = dht22_payload(-10.5, 30.0)
        self.assertEqual(p[2] & 0x80, 0x80)
        self.assertEqual(((p[2] & 0x7F) << 8) | p[3], 105)

    def test_checksum_wraps(self):
        p = dht22_payload(99.9, 99.9)
        self.assertEqual(p[4], sum(p[:4]) & 0xFF)

    def test_phase_shape(self):
        ph = dht22_phases(dht22_payload(28.0, 55.0))
        self.assertEqual(len(ph), 2 + 80 + 1)
        self.assertEqual(ph[0], (0, RESPONSE_LOW_US))
        self.assertEqual(ph[1], (1, RESPONSE_HIGH_US))
        self.assertEqual(ph[2], (0, BIT_LOW_US))
        highs = {ph[i][1] for i in range(3, 83, 2)}
        self.assertEqual(highs, {BIT0_HIGH_US, BIT1_HIGH_US})

    def test_coerce_number(self):
        self.assertEqual(coerce_number('28', 25.0), 28.0)
        self.assertEqual(coerce_number(' 55.5 ', 50.0), 55.5)
        self.assertEqual(coerce_number(None, 25.0), 25.0)
        self.assertEqual(coerce_number('abc', 25.0), 25.0)
        self.assertEqual(coerce_number(True, 25.0), 25.0)
        self.assertEqual(coerce_number(30, 25.0), 30.0)


# ── trigger: both release idioms ─────────────────────────────────────────────

class TestTrigger(unittest.TestCase):
    def test_open_drain_release_arms(self):
        t = Dht22Trigger()
        self.assertFalse(t.on_write(1))          # od_high before the start
        self.assertFalse(t.on_write(0))          # start signal
        self.assertTrue(t.on_write(1))           # release by writing a 1
        self.assertFalse(t.on_write(1))          # armed once

    def test_push_pull_release_arms(self):
        t = Dht22Trigger()
        self.assertFalse(t.on_direction(True))   # pinMode(OUTPUT)
        self.assertFalse(t.on_write(0))
        self.assertTrue(t.on_direction(False))   # pinMode(INPUT_PULLUP)
        self.assertFalse(t.on_direction(False))

    def test_write_high_then_input_arms_once(self):
        """SimpleDHT-style: digitalWrite(HIGH) then pinMode(INPUT)."""
        t = Dht22Trigger()
        t.on_write(0)
        self.assertTrue(t.on_write(1))
        self.assertFalse(t.on_direction(False))

    def test_input_without_low_does_not_arm(self):
        t = Dht22Trigger()
        self.assertFalse(t.on_direction(False))
        self.assertFalse(t.on_write(1))


# ── the reply under both drivers ─────────────────────────────────────────────

class TestReplyDecodes(unittest.TestCase):
    DENSE = (0.45, 0.9, 1.8)          # -icount shift 3, 4, 5: guest-time reads
    SPARSE = (36.0, 70.0, 120.0)      # no -icount: host-time reads

    def test_micropython_decodes_under_icount(self):
        for gap in self.DENSE:
            reply, pad, clock = make_reply()
            got = run_guest(reply, pad, clock, MicroPythonDht(), 10.0, gap)
            self.assertEqual(got, EXPECTED, f'gap {gap}')
            self.assertEqual(reply.stalls, 0)

    def test_adafruit_decodes_under_icount(self):
        for gap in self.DENSE:
            reply, pad, clock = make_reply()
            got = run_guest(reply, pad, clock, AdafruitDht(), 55.0, gap)
            self.assertEqual(got, EXPECTED, f'gap {gap}')

    def test_adafruit_decodes_at_host_time_read_spacing(self):
        """Without -icount every gap hits the cap: the frame is a fixed number
        of reads per phase, whatever the host is doing."""
        for gap in self.SPARSE:
            reply, pad, clock = make_reply()
            dec = AdafruitDht()
            got = run_guest(reply, pad, clock, dec, 55.0, gap)
            self.assertEqual(got, EXPECTED, f'gap {gap}')
            # One read per credited cap: the counts are the phase lengths in
            # caps (the guest sees the edge on the read that ends the phase).
            lows = dec.pulses[2::2]
            highs = dec.pulses[3::2]
            self.assertEqual(len(set(lows)), 1, lows)
            self.assertAlmostEqual(lows[0], BIT_LOW_US / STALL_CAP_US, delta=1)
            for h in highs:
                self.assertTrue(abs(h - BIT0_HIGH_US / STALL_CAP_US) <= 1
                                or abs(h - BIT1_HIGH_US / STALL_CAP_US) <= 1, h)

    def test_micropython_timing_is_the_datasheet(self):
        reply, pad, clock = make_reply()
        dec = MicroPythonDht()
        run_guest(reply, pad, clock, dec, 10.0, 0.45)
        # Reconstruct HIGH lengths off the recorded edges.
        edges = pad.edges
        highs, start = [], None
        for t, lvl in edges:
            if lvl == 1 and start is None:
                start = t
            elif lvl == 0 and start is not None:
                highs.append(round(t - start, 1))
                start = None
        self.assertAlmostEqual(highs[0], RESPONSE_HIGH_US, delta=1.0)
        for h in highs[1:41]:
            self.assertTrue(abs(h - BIT0_HIGH_US) <= 1.0 or abs(h - BIT1_HIGH_US) <= 1.0, h)

    def test_stall_is_credited_at_the_cap(self):
        """A host stall between two reads moves the phase clock by the cap only,
        so the read-counting driver still decodes; the timing driver sees the
        stall on its own clock and times out, then decodes a fresh frame."""
        reply, pad, clock = make_reply()
        got = run_guest(reply, pad, clock, AdafruitDht(), 55.0, 36.0, stall_at_read=40, stall_us=3000.0)
        self.assertEqual(got, EXPECTED)
        self.assertEqual(reply.stalls, len(reply.gaps_us))   # every sparse gap is a "stall"

        reply, pad, clock = make_reply()
        got = run_guest(reply, pad, clock, MicroPythonDht(), 10.0, 0.45, stall_at_read=400, stall_us=150.0)
        self.assertEqual(got, 'timeout')
        self.assertEqual(reply.stalls, 1)
        reply2, pad2, clock2 = make_reply()
        self.assertEqual(run_guest(reply2, pad2, clock2, MicroPythonDht(), 10.0, 0.45), EXPECTED)

    def test_first_edge_waits_for_the_first_read(self):
        reply, pad, clock = make_reply()
        self.assertEqual(pad.level, 1)
        self.assertEqual(reply.phase, -1)
        reply.step()
        self.assertEqual(pad.level, 0)
        self.assertEqual(reply.phase, 0)

    def test_settle_releases_the_tail(self):
        """Adafruit returns on the last falling edge and never reads again: the
        tail LOW stays on the pad until the settle timer releases it."""
        reply, pad, clock = make_reply()
        run_guest(reply, pad, clock, AdafruitDht(), 55.0, 36.0)
        self.assertFalse(reply.done)
        self.assertEqual(pad.level, 0)
        self.assertTrue(reply.settle())
        self.assertTrue(reply.done)
        self.assertEqual(pad.level, 1)
        self.assertFalse(reply.settle())
        self.assertTrue(reply.step())        # a late read changes nothing

    def test_settle_before_any_read_is_a_no_op(self):
        reply, pad, clock = make_reply()
        self.assertFalse(reply.settle())
        self.assertEqual(pad.level, 1)

    def test_diag_reports_reads_and_gaps(self):
        reply, pad, clock = make_reply()
        run_guest(reply, pad, clock, MicroPythonDht(), 10.0, 0.9)
        d = reply.diag()
        self.assertGreater(d['reads'], 3000)
        self.assertAlmostEqual(d['gap_p50_us'], 0.9, delta=0.01)
        self.assertEqual(d['stalls'], 0)


# ── run policy ───────────────────────────────────────────────────────────────

class TestIcountPolicy(unittest.TestCase):
    DHT = [{'sensor_type': 'dht22', 'pin': 15}]

    def test_c3_always(self):
        self.assertEqual(icount_shift_for_run('esp32c3-picsimlab', True, [], False), ICOUNT_SHIFT_C3)

    def test_micropython_with_line_sensor(self):
        self.assertEqual(icount_shift_for_run('esp32-picsimlab', False, self.DHT, True), ICOUNT_SHIFT_LINE_SENSORS)
        self.assertEqual(icount_shift_for_run('esp32s3-picsimlab', False, [{'sensor_type': 'hc-sr04', 'pin': 5}], True), ICOUNT_SHIFT_LINE_SENSORS)

    def test_arduino_keeps_host_time(self):
        self.assertIsNone(icount_shift_for_run('esp32-picsimlab', False, self.DHT, False))

    def test_wifi_keeps_host_time(self):
        self.assertIsNone(icount_shift_for_run('esp32-picsimlab', True, self.DHT, True))

    def test_no_line_sensor_keeps_host_time(self):
        self.assertIsNone(icount_shift_for_run('esp32-picsimlab', False, [{'sensor_type': 'ssd1306', 'pin': 200}], True))
        self.assertIsNone(icount_shift_for_run('esp32-picsimlab', False, [], True))


class TestFirmwareIsMicroPython(unittest.TestCase):
    def test_banner_string(self):
        self.assertTrue(firmware_is_micropython(b'\xff' * 100 + b'MicroPython v1.28.0 on 2026-04-06; Generic ESP32 module with ESP32' + b'\x00' * 100))

    def test_arduino_image(self):
        self.assertFalse(firmware_is_micropython(b'\xe9\x06\x02\x20' + b'\x00' * 4096 + b'Failed to read from DHT sensor!'))
        self.assertFalse(firmware_is_micropython(b''))


if __name__ == '__main__':
    unittest.main()
