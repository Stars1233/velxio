"""Uc8179EpaperSlave against the golden streams it shares with the browser
decoder (test/fixtures/uc8179_vectors.json, frontend uc8179-decoder.test.ts).

The same SPI stream must not render differently depending on which board
drives the panel: an ESP32 goes through this slave, every other board through
the TypeScript decoder.
"""
import json
from pathlib import Path

import pytest

from app.services.esp32_spi_slaves import Uc8179EpaperSlave

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "uc8179_vectors.json").read_text()
)


def _run(vector):
    frames = []
    slave = Uc8179EpaperSlave(
        component_id="epd", width=FIXTURE["width"], height=FIXTURE["height"],
        on_flush=frames.append,
    )
    for step in vector["steps"]:
        slave.feed(step["cmd"], dc_high=False)
        for byte in step["data"]:
            slave.feed(byte, dc_high=True)
    frame = frames[-1]
    rows = [
        "".join("#" if frame.pixels[y * frame.width + x] == 0 else "."
                for x in range(frame.width))
        for y in range(frame.height)
    ]
    return rows, slave


@pytest.mark.parametrize("vector", FIXTURE["vectors"], ids=lambda v: v["name"][:60])
def test_golden_stream(vector):
    rows, slave = _run(vector)
    assert rows == vector["rows"]
    assert slave.last_refresh_old_plane_only is vector["old_plane_only"]


def test_reset_puts_the_data_polarity_back():
    slave = Uc8179EpaperSlave(component_id="epd", width=8, height=1)
    slave.feed(0x50, dc_high=False)
    slave.feed(0x10, dc_high=True)
    assert slave.set_bit_is_white is False
    slave.reset()
    assert slave.set_bit_is_white is True
