"""RP2040 / RP2350 builds return BOTH artifacts: the raw .bin and the .uf2.

The browser emulator loads the .bin (the image from 0x10000000, byte for
byte). Everything that talks to REAL hardware wants the .uf2 picotool made
from the ELF: the BOOTSEL drive, `picotool load`, the download link in the
flash dialog. Until 2026-09 only the .bin came back, and the desktop flash
handed it to picotool under a .uf2 name:

    ERROR: UF2 file does not contain a valid RP2 executable image

These tests run pure-Python: subprocess.run is replaced by a fake that
drops the files a real arduino-cli build would leave in --output-dir.
"""
from __future__ import annotations

import asyncio
import base64
import subprocess
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_REPO / "backend"))

from app.services.arduino_cli import ArduinoCLIService  # noqa: E402

SKETCH = [{"name": "sketch.ino", "content": "void setup(){}\nvoid loop(){}\n"}]
FQBN = "rp2040:rp2040:rpipico2w:arch=riscv"

BIN_BYTES = bytes(range(256)) * 3
UF2_BYTES = b"UF2\n" + bytes(508)


def _service() -> ArduinoCLIService:
    svc = object.__new__(ArduinoCLIService)
    svc.cli_path = "arduino-cli"
    svc._installed_cores = ""
    return svc


def _fake_run(outputs: dict[str, bytes]):
    def run(cmd, **kwargs):
        out = Path(cmd[cmd.index("--output-dir") + 1])
        out.mkdir(parents=True, exist_ok=True)
        for name, data in outputs.items():
            (out / name).write_bytes(data)
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    return run


def _compile(monkeypatch, outputs):
    monkeypatch.setattr(subprocess, "run", _fake_run(outputs))
    return asyncio.run(_service().compile(SKETCH, FQBN))


def test_bin_and_uf2_both_come_back(monkeypatch):
    result = _compile(monkeypatch, {"sketch.ino.bin": BIN_BYTES, "sketch.ino.uf2": UF2_BYTES})
    assert result["success"] is True
    assert result["binary_type"] == "bin"
    assert base64.b64decode(result["binary_content"]) == BIN_BYTES
    assert base64.b64decode(result["uf2_content"]) == UF2_BYTES


def test_bin_only_leaves_uf2_content_empty(monkeypatch):
    result = _compile(monkeypatch, {"sketch.ino.bin": BIN_BYTES})
    assert result["success"] is True
    assert result["binary_type"] == "bin"
    assert base64.b64decode(result["binary_content"]) == BIN_BYTES
    assert result["uf2_content"] is None


def test_uf2_only_keeps_the_legacy_fallback(monkeypatch):
    """No .bin: binary_content falls back to the .uf2 as it always did, and
    uf2_content carries the same bytes."""
    result = _compile(monkeypatch, {"sketch.ino.uf2": UF2_BYTES})
    assert result["success"] is True
    assert result["binary_type"] == "uf2"
    assert base64.b64decode(result["binary_content"]) == UF2_BYTES
    assert base64.b64decode(result["uf2_content"]) == UF2_BYTES


def test_no_binary_is_still_an_error(monkeypatch):
    result = _compile(monkeypatch, {})
    assert result["success"] is False
    assert "not found" in result["error"]
