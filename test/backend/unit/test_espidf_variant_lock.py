"""Persistent build variants are single-writer, and a variant whose managed
component got truncated heals itself.

Real failure (deploy gate, 2026-09-03): the engine smoke fired the ESP32-S3
OLED example twice, 13 s apart. Both compiles hashed to the same variant and
ran in the same project dir; the second configure found the first one's
half-copied ``espressif/esp-serial-flasher`` and the component manager
declared it corrupted. From then on every compile of that variant failed with
"ESP-IDF cmake configure failed" until the directory was deleted by hand.
"""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services.espidf_compiler import (  # noqa: E402
    _corrupt_managed_component,
    _heal_corrupt_managed_components,
    _variant_lock,
)


_CMAKE_STDERR = '''CMake Error at /opt/esp-idf-v5/tools/cmake/build.cmake:631 (message):
  ERROR: The downloaded component "espressif/esp-serial-flasher" is
  corrupted.

  Please try running the command again.

  File "CMakeLists.txt" is missing in the component in


  "/var/lib/velxio-build/esp32s3/v_38f59ea9c73c/project/managed_components/espressif__esp-serial-flasher"
'''


class VariantLockTests(unittest.TestCase):
    def test_same_variant_shares_one_lock(self):
        a = _variant_lock('esp32s3/v_38f59ea9c73c')
        b = _variant_lock('esp32s3/v_38f59ea9c73c')
        self.assertIs(a, b)
        self.assertIsInstance(a, asyncio.Lock)

    def test_different_variants_do_not_block_each_other(self):
        self.assertIsNot(_variant_lock('esp32s3/v_a'), _variant_lock('esp32s3/v_b'))
        self.assertIsNot(_variant_lock('esp32/v_a'), _variant_lock('esp32s3/v_a'))

    def test_the_lock_serialises_two_compiles_of_one_variant(self):
        order: list[str] = []

        async def compile_once(tag: str, hold: float):
            async with _variant_lock('esp32c3/v_serial'):
                order.append(f'{tag}:in')
                await asyncio.sleep(hold)
                order.append(f'{tag}:out')

        async def run():
            await asyncio.gather(compile_once('first', 0.05), compile_once('second', 0))

        asyncio.run(run())
        self.assertEqual(order, ['first:in', 'first:out', 'second:in', 'second:out'])


class CorruptComponentTests(unittest.TestCase):
    def test_the_wrapped_message_names_the_component(self):
        self.assertEqual(_corrupt_managed_component(_CMAKE_STDERR), 'espressif/esp-serial-flasher')

    def test_other_cmake_failures_are_not_healed(self):
        self.assertIsNone(_corrupt_managed_component('CMake Error: sdkconfig has changed'))
        self.assertIsNone(_corrupt_managed_component(''))
        self.assertIsNone(_corrupt_managed_component(None))  # type: ignore[arg-type]

    def test_heal_drops_the_variant_copies_and_the_cmake_cache(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / 'project'
            build = project / 'build'
            comp = project / 'managed_components' / 'espressif__esp-serial-flasher'
            comp.mkdir(parents=True)
            (comp / 'README.md').write_text('half copied', encoding='utf-8')
            build.mkdir()
            (build / 'CMakeCache.txt').write_text('stale', encoding='utf-8')
            (build / 'build.ninja').write_text('keep', encoding='utf-8')

            self.assertTrue(_heal_corrupt_managed_components(project, build))
            self.assertFalse((project / 'managed_components').exists())
            self.assertFalse((build / 'CMakeCache.txt').exists())
            # The rest of build/ (ninja state, objects) is left for ccache/ninja.
            self.assertTrue((build / 'build.ninja').exists())
            # Nothing left to heal: say so, so the caller does not reconfigure twice.
            self.assertFalse(_heal_corrupt_managed_components(project, build))


if __name__ == '__main__':
    unittest.main()
