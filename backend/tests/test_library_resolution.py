"""Transitive library resolution: probes, platform dispatch, and quarantine.

An eight-LED FastLED blink on an ESP32-S3 merged FIFTEEN libraries and died
inside Adafruit TinyUSB, a library the sketch never named. Four independent
mechanisms produced that, each verified against the 1232-library production
cache, and each covered here.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.services.espidf_compiler import ESPIDFCompiler


@pytest.fixture
def c() -> ESPIDFCompiler:
    return ESPIDFCompiler()


# ── has_include is a PROBE, not a dependency ─────────────────────────────
# `#if __has_include(<X.h>)` asks "did the user install X?". Answering it by
# merging X makes it true for the real compiler: we manufacture our own
# premise, and pay for the library and every one of its sources.

@pytest.mark.parametrize(
    "expr, live, why",
    [
        # Wrapper-existence tests: the operator itself, no parens. MUST stay live.
        ("defined __has_include", True, "gxepd2 src/GxEPD2_4C.h:38"),
        ("__has_include", True, "lvgl src/lv_conf_internal.h:22"),
        # Invocations: the probe itself.
        ("__has_include(<Adafruit_NeoPixel.h>)", False, "a bare probe"),
        ("FL_HAS_INCLUDE(<Adafruit_NeoPixel.h>)", False, "FastLED's wrapper spelling"),
        # Substitution, not "mentions it therefore dead": killing this branch
        # would kill everything to its #endif.
        ("!defined(HOST) || __has_include(<lwip/tcpbase.h>)", True,
         "espasyncwebserver src/ESPAsyncWebServer.h:9"),
        # One false conjunct sinks the term whatever else it says.
        ("__has_include(<A.h>) && defined(ESP32)", False, "probe AND ours"),
        ("defined(ESP32) && __has_include(<A.h>)", False, "order must not matter"),
        # A NEGATED probe is true, and must not be read as the literal 0.
        ("!__has_include(<A.h>)", True, "negated probe"),
        ("__has_include(<A.h>) || defined(ESP32)", True, "one live term is enough"),
        # Pre-existing behaviour, unchanged.
        ("ENABLE_GxEPD2_GFX", True, "unknown macro stays live"),
        ("defined(ESP8266)", False, "foreign platform"),
        ("defined(ESP32)", True, "ours"),
        # arduino-esp32 defines USE_TINYUSB only for ARDUINO_USB_MODE=0; we
        # hardcode 1. This is the edge Adafruit_NeoPixel.h:42 guards.
        ("USE_TINYUSB", False, "opt-in we never set"),
    ],
)
def test_branch_liveness(c: ESPIDFCompiler, expr: str, live: bool, why: str) -> None:
    assert c._pp_branch_is_live(expr) is live, why


def test_a_probe_is_never_provably_true(c: ESPIDFCompiler) -> None:
    """So its #else arm keeps being scanned (FastLED's clockless_fake.hpp)."""
    assert c._pp_branch_is_provably_true("FL_HAS_INCLUDE(<Adafruit_NeoPixel.h>)") is False


def test_probe_else_arm_stays_live(c: ESPIDFCompiler) -> None:
    code = (
        "#if FL_HAS_INCLUDE(<Adafruit_NeoPixel.h>)\n"
        "#include <Adafruit_NeoPixel.h>\n"
        "#else\n"
        "#include <FallbackDriver.h>\n"
        "#endif\n"
    )
    got = c._detect_external_includes(code)
    assert "Adafruit_NeoPixel.h" not in got
    assert "FallbackDriver.h" in got


# ── platform dispatch: the arm we take is rarely the first ───────────────

def test_arms_before_a_provably_true_arm_are_dead(c: ESPIDFCompiler) -> None:
    """FastLED src/platforms.h: ten foreign platforms, then ESP32.

    A single forward pass can only prune arms AFTER a taken one, so the whole
    ARM tree was walked and <FreeRTOS.h> (an ARM RTOS port header) resolved to
    esp32blearduino, whose src/FreeRTOS.h then failed to compile.
    """
    code = (
        "#if defined(FL_IS_ARM_LPC)\n"
        "#include <LPC804.h>\n"
        "#elif defined(NRF51)\n"
        "#include <nrf.h>\n"
        "#elif defined(__MK20DX128__)\n"
        "#include <DMAChannel.h>\n"
        "#elif defined(ESP32)\n"
        "#include <RealDep.h>\n"
        "#endif\n"
    )
    got = c._detect_external_includes(code)
    assert got == ["RealDep.h"], got


def test_chain_without_a_true_arm_keeps_every_unknown_arm_live(c: ESPIDFCompiler) -> None:
    """Nothing is proven, so nothing may be pruned."""
    code = (
        "#if defined(FEATURE_A)\n#include <A.h>\n"
        "#elif defined(FEATURE_B)\n#include <B.h>\n#endif\n"
    )
    assert set(c._detect_external_includes(code)) == {"A.h", "B.h"}


def test_a_true_arm_kills_the_else(c: ESPIDFCompiler) -> None:
    code = "#if defined(ESP8266)\n#include <A.h>\n#elif defined(ESP32)\n#include <B.h>\n#else\n#include <C.h>\n#endif\n"
    assert c._detect_external_includes(code) == ["B.h"]


def test_the_gxepd2_landmine_still_holds(c: ESPIDFCompiler) -> None:
    """ENABLE_GxEPD2_GFX defaults to 0; treating the unknown #if as taken
    pruned the #else and dropped Adafruit_GFX from every e-paper example
    (2026-08-15)."""
    code = (
        "#if ENABLE_GxEPD2_GFX\n#include <GFXBase.h>\n"
        "#else\n#include <Adafruit_GFX.h>\n#endif\n"
    )
    assert "Adafruit_GFX.h" in c._detect_external_includes(code)


# ── a root-level source is not part of a src/-layout library ─────────────

def test_quarantine_reads_only_diagnostic_lines(c: ESPIDFCompiler) -> None:
    """The failing compiler command line is echoed into the output and names
    EVERY merged library as a -I flag. Matching the whole blob would
    quarantine the build, including the library the sketch asked for."""
    result = {
        "error": (
            "ccache g++ -I../user_libs/user_libs_all/fastled@1.0-aaa/src "
            "-I../user_libs/user_libs_all/dmxsimple@3.1-bbb -c foo.cpp\n"
            "../user_libs/user_libs_all/dmxsimple@3.1-bbb/DmxSimple.cpp:7:10: "
            "fatal error: avr/io.h: No such file or directory\n"
        ),
    }
    spec = {"fastled@1.0-aaa", "dmxsimple@3.1-bbb"}
    assert c._quarantine_from_error(result, spec) == ["dmxsimple@3.1-bbb"]


def test_quarantine_ignores_a_library_the_sketch_named(c: ESPIDFCompiler) -> None:
    """Only resolver guesses are droppable. A real error must surface."""
    result = {"error": "../user_libs/user_libs_all/fastled@1.0-aaa/src/x.cpp:9:1: error: boom\n"}
    assert c._quarantine_from_error(result, set()) == []
    assert c._quarantine_from_error(result, {"other@1-b"}) == []


def test_quarantine_collects_every_offender_in_one_pass(c: ESPIDFCompiler) -> None:
    """Converges in one rebuild instead of one per library."""
    result = {"error": (
        "../user_libs/user_libs_all/a@1-x/f.cpp:1:1: error: boom\n"
        "../user_libs/user_libs_all/b@1-y/g.cpp:2:2: error: bang\n"
    )}
    assert c._quarantine_from_error(result, {"a@1-x", "b@1-y"}) == ["a@1-x", "b@1-y"]


def test_quarantine_is_silent_without_diagnostics(c: ESPIDFCompiler) -> None:
    assert c._quarantine_from_error({"error": ""}, {"a@1-x"}) == []


# ── the include-graph walk ───────────────────────────────────────────────

def _mklib(root: Path, files: dict[str, str], src_layout: bool = True) -> Path:
    for rel, body in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
    return root


def _accept_all(rel: Path) -> bool:
    return rel.suffix.lower() in ('.h', '.hpp', '.c', '.cpp', '.inc')


def test_a_librarys_own_quoted_header_is_not_external(c: ESPIDFCompiler, tmp_path: Path) -> None:
    """FastLED.h:189 does `#include "lib8tion.h"` and ships src/lib8tion.h.
    Resolved globally it scored UncleRus (architectures=esp32, +40) over
    FastLED (architectures=*, 0) and merged an unrelated sensor bundle."""
    lib = _mklib(tmp_path / "fastled", {
        "src/FastLED.h": '#include "lib8tion.h"\n#include <SPI.h>\n',
        "src/lib8tion.h": "// math\n",
    })
    got = c._walk_library_includes(lib, True, _accept_all)
    assert "lib8tion.h" not in got
    assert "SPI.h" in got


def test_an_angled_self_include_stays_external_from_a_subdirectory(
    c: ESPIDFCompiler, tmp_path: Path
) -> None:
    """Only the QUOTED form gets the includer's own directory. Giving it to
    the angled form too creates a new hard-failure class."""
    lib = _mklib(tmp_path / "l", {
        "src/sub/a.h": "#include <sibling.h>\n",
        "src/sub/sibling.h": "// not on -I\n",
        "src/l.h": '#include "sub/a.h"\n',
    })
    assert "sibling.h" in c._walk_library_includes(lib, True, _accept_all)


def test_a_quoted_sibling_in_a_subdirectory_resolves(c: ESPIDFCompiler, tmp_path: Path) -> None:
    lib = _mklib(tmp_path / "l", {
        "src/l.h": '#include "sub/a.h"\n',
        "src/sub/a.h": '#include "sibling.h"\n',
        "src/sub/sibling.h": "// same dir\n",
    })
    assert c._walk_library_includes(lib, True, _accept_all) == []


def test_a_guard_one_file_up_is_now_visible(c: ESPIDFCompiler, tmp_path: Path) -> None:
    """The whole point of the walk. clockless_real.hpp includes
    <Adafruit_NeoPixel.h> unguarded, but is only reachable from inside a
    probe. Read standalone it looks like an unconditional dependency."""
    lib = _mklib(tmp_path / "fastled", {
        "src/FastLED.h": '#include "platforms/probe.hpp"\n',
        "src/platforms/probe.hpp": (
            "#if FL_HAS_INCLUDE(<Adafruit_NeoPixel.h>)\n"
            '#include "real.hpp"\n#endif\n'
        ),
        "src/platforms/real.hpp": "#include <Adafruit_NeoPixel.h>\n",
    })
    assert c._walk_library_includes(lib, True, _accept_all) == []


def test_a_header_only_library_is_still_entered(c: ESPIDFCompiler, tmp_path: Path) -> None:
    """ArduinoJson has zero .cpp. Entering only from compiled sources reaches
    nothing at all, which reads as 'no dependencies' for the wrong reason."""
    lib = _mklib(tmp_path / "aj", {
        "src/ArduinoJson.h": "#include <RealDep.h>\n",
    })
    assert c._walk_library_includes(lib, True, _accept_all) == ["RealDep.h"]


def test_the_walk_confines_itself_to_the_library(c: ESPIDFCompiler, tmp_path: Path) -> None:
    """lvgl writes ../../../../src/... chains that, unnormalised, grow until
    the OS refuses the name."""
    lib = _mklib(tmp_path / "l", {
        "src/a.h": '#include "../../../../etc/passwd"\n#include "../../src/a.h"\n',
    })
    got = c._walk_library_includes(lib, True, _accept_all)   # must not raise
    assert "passwd" not in " ".join(got)


def test_flat_layout_resolves_through_utility(c: ESPIDFCompiler, tmp_path: Path) -> None:
    lib = _mklib(tmp_path / "old", {
        "Old.h": "#include <helper.h>\n",
        "utility/helper.h": "// the other root a flat library gets\n",
    })
    assert c._walk_library_includes(lib, False, _accept_all) == []


# ── A library the user configures ────────────────────────────────────────
# LVGL wants an lv_conf.h, TFT_eSPI a User_Setup.h, NimBLE a nimconfig.h: the
# user writes the header, the LIBRARY includes it, and arduino-cli makes that
# work by putting the sketch folder on the include path of every translation
# unit. A project with its own lv_conf.h died on "LV_MEM_SIZE >= 2kB is
# required" with the file sitting right there, unread (issue #352). Three
# things were wrong, and all three are this shape rather than LVGL's.

def test_an_installed_library_is_not_fetched_from_the_registry_as_well(
    c: ESPIDFCompiler,
) -> None:
    """One library, one copy.

    `lvgl/lvgl` in the registry and the LVGL the user installed from the
    Library Manager are the same project. With both in the build the sketch's
    `#include <lvgl.h>` resolves to whichever include root comes first while
    the project's lv_conf.h configures the other one.
    """
    deps = {'lvgl/lvgl': '*', 'espressif/esp32-camera': '*'}
    merged = {'lvgl.h': 'lvgl'}  # header -> library folder, as the resolver reports
    kept = c._without_merged_duplicates(deps, merged)
    assert 'lvgl/lvgl' not in kept, 'the installed library wins'
    assert kept['espressif/esp32-camera'] == '*', 'nobody installed that one'


def test_a_registry_component_survives_when_no_library_provides_it(
    c: ESPIDFCompiler,
) -> None:
    deps = {'lvgl/lvgl': '*'}
    assert c._without_merged_duplicates(deps, {}) == deps
    assert c._without_merged_duplicates(deps, None) == deps
    assert c._without_merged_duplicates(deps, {'Wire.h': 'Wire'}) == deps


@pytest.mark.parametrize(
    "dep, reported",
    [
        ('lvgl/lvgl', 'LVGL'),          # registry lowercase, properties uppercase
        ('someone/my-lib', 'My Lib'),   # dashes in one, spaces in the other
        ('someone/my_lib', 'my-lib'),
    ],
)
def test_library_name_matching_survives_spelling(
    c: ESPIDFCompiler, dep: str, reported: str
) -> None:
    """Registry names, folder names and library.properties names disagree
    about case, dashes and spaces; the same project is still one copy."""
    assert c._without_merged_duplicates({dep: '*'}, {'x.h': reported}) == {}


def test_the_project_config_header_beats_the_idf_kconfig(c: ESPIDFCompiler) -> None:
    """A library that finds a Kconfig prefers it — right on a real IDF
    project, wrong for an Arduino library the user configured by hand. The
    escape hatch is the library's own, and it is spent only when the project
    actually ships the header."""
    assert 'lv_conf.h' in c._ARDUINO_CONFIG_WINS
    assert c._ARDUINO_CONFIG_WINS['lv_conf.h'] == ('LV_KCONFIG_IGNORE',)
    # Every switch names a macro the library documents, never a source patch.
    for header, macros in c._ARDUINO_CONFIG_WINS.items():
        assert header.endswith('.h')
        assert macros and all(m.isidentifier() for m in macros)
