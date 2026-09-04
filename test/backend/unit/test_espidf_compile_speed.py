"""Compile-speed mechanics in espidf_compiler (2026-09).

Three things a warm ESP-IDF build depends on, none of which the toolchain is
needed to check:

  1. Generated configure inputs are written only when their bytes change, so
     ninja's RERUN_CMAKE rule does not fire for a file that is the same.
  2. Variant eviction never removes a directory whose lock is held, and
     replicas of a variant are named / keyed consistently in both directions.
  3. A failed ninja run on a warm dir is told apart as "configure trouble"
     (fall back to an explicit cmake) vs. an error in the user's code.

Run from the repo root:
    python -m pytest test/backend/unit/test_espidf_compile_speed.py -v
"""

import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.services import espidf_compiler as ec  # noqa: E402


class WriteIfChangedTests(unittest.TestCase):
    def test_identical_bytes_keep_the_mtime(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'partitions.csv'
            p.write_text('a,b,c\n')
            old = time.time() - 3600
            os.utime(p, (old, old))
            self.assertFalse(ec._write_if_changed(p, 'a,b,c\n'))
            self.assertAlmostEqual(p.stat().st_mtime, old, delta=1)

    def test_different_bytes_are_written(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'partitions.csv'
            p.write_text('a,b,c\n')
            self.assertTrue(ec._write_if_changed(p, 'x\n'))
            self.assertEqual(p.read_text(), 'x\n')

    def test_missing_file_is_created(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'new.cmake'
            self.assertTrue(ec._write_if_changed(p, 'hi\n'))
            self.assertEqual(p.read_text(), 'hi\n')


class VariantNamingTests(unittest.TestCase):
    def test_dir_name_and_lock_key_round_trip(self):
        for replica in (0, 1, 3):
            name = ec._variant_dir_name('b6ef22a62ee4', replica)
            self.assertEqual(
                ec._lock_key_for_variant_dir('esp32', name),
                ec._variant_lock_key('esp32', 'b6ef22a62ee4', replica),
            )

    def test_replica_zero_keeps_the_legacy_name_and_key(self):
        self.assertEqual(ec._variant_dir_name('abc'), 'v_abc')
        self.assertEqual(ec._variant_lock_key('esp32s3', 'abc'), 'esp32s3/abc')
        self.assertEqual(ec._variant_dir_name('abc', 2), 'v_abc_r2')
        self.assertEqual(ec._variant_lock_key('esp32s3', 'abc', 2), 'esp32s3/abc/r2')

    def test_unrelated_dirs_have_no_key(self):
        self.assertIsNone(ec._lock_key_for_variant_dir('esp32', 'project'))


class EvictionTests(unittest.TestCase):
    def _make(self, root: Path, names: list[str]) -> None:
        for i, n in enumerate(names):
            d = root / n
            d.mkdir()
            stamp = time.time() - 1000 + i  # later names are warmer
            os.utime(d, (stamp, stamp))

    def test_locked_variant_is_never_evicted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'esp32'
            root.mkdir()
            # v_old is the coldest by mtime AND locked: eviction must skip it
            self._make(root, ['v_old', 'v_mid', 'v_new'])
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'old'))

            async def run() -> None:
                async with lock:
                    ec._evict_cold_variants(root, keep=2, idf_target='esp32')

            asyncio.run(run())
            self.assertTrue((root / 'v_old').exists(), 'evicted a variant under lock')
            self.assertFalse((root / 'v_mid').exists(), 'the next-coldest free one goes')
            self.assertTrue((root / 'v_new').exists())

    def test_replica_dirs_are_checked_against_their_own_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'esp32'
            root.mkdir()
            self._make(root, ['v_hot_r1', 'v_hot', 'v_other'])
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'hot', 1))

            async def run() -> None:
                async with lock:
                    ec._evict_cold_variants(root, keep=2, idf_target='esp32')

            asyncio.run(run())
            self.assertTrue((root / 'v_hot_r1').exists())
            self.assertFalse((root / 'v_hot').exists())

    def test_nothing_happens_under_the_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'esp32'
            root.mkdir()
            self._make(root, ['v_a', 'v_b'])
            ec._evict_cold_variants(root, keep=6, idf_target='esp32')
            self.assertEqual(sorted(p.name for p in root.iterdir()), ['v_a', 'v_b'])

    def test_per_target_cap_from_env(self):
        with mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANTS_ESP32': '12'}):
            self.assertEqual(ec._max_build_variants('esp32'), 12)
            self.assertEqual(ec._max_build_variants('esp32s3'), ec._MAX_BUILD_VARIANTS)
        with mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANTS': '9'}):
            self.assertEqual(ec._max_build_variants('esp32c3'), 9)


class ReplicaPickTests(unittest.TestCase):
    def setUp(self) -> None:
        ec._VARIANT_COLLISIONS.clear()
        ec._WARMING_REPLICAS.clear()

    def test_free_base_replica_wins(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            self.assertEqual(ec.ESPIDFCompiler._pick_replica('esp32', 'h1'), (0, None))

    def test_busy_base_goes_to_an_existing_free_replica(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            (Path(tmp) / 'esp32' / 'v_h2_r1').mkdir(parents=True)
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h2'))

            async def run() -> int:
                async with lock:
                    return ec.ESPIDFCompiler._pick_replica('esp32', 'h2')

            self.assertEqual(asyncio.run(run()), (1, None))

    def test_replica_is_warmed_only_after_a_collision_streak(self):
        """A busy variant queues on replica 0; the streak asks for r1 to be
        warmed in the background, and the job itself still builds in r0."""
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h3'))

            async def run() -> list:
                picks = []
                async with lock:
                    for _ in range(ec._REPLICA_COLLISION_THRESHOLD):
                        picks.append(ec.ESPIDFCompiler._pick_replica('esp32', 'h3'))
                return picks

            picks = asyncio.run(run())
            self.assertEqual(picks[:-1], [(0, None)] * (ec._REPLICA_COLLISION_THRESHOLD - 1))
            self.assertEqual(picks[-1], (0, 1))

    def test_a_replica_being_warmed_is_neither_picked_nor_recreated(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '2'}):
            (Path(tmp) / 'esp32' / 'v_h5_r1').mkdir(parents=True)
            ec._WARMING_REPLICAS.add(ec._variant_lock_key('esp32', 'h5', 1))
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h5'))

            async def run() -> list:
                async with lock:
                    return [ec.ESPIDFCompiler._pick_replica('esp32', 'h5') for _ in range(5)]

            self.assertEqual(asyncio.run(run()), [(0, None)] * 5)

    def test_replicas_off_means_always_zero(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ec, '_BUILD_ROOT', Path(tmp)), \
                mock.patch.dict(os.environ, {'VELXIO_BUILD_VARIANT_REPLICAS': '1'}):
            lock = ec._variant_lock(ec._variant_lock_key('esp32', 'h4'))

            async def run() -> list[int]:
                async with lock:
                    return [ec.ESPIDFCompiler._pick_replica('esp32', 'h4') for _ in range(5)]

            self.assertEqual(asyncio.run(run()), [(0, None)] * 5)


class NinjaArgsAndFallbackTests(unittest.TestCase):
    def test_no_env_means_ninjas_own_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('VELXIO_NINJA_JOBS', None)
            os.environ.pop('VELXIO_NINJA_LOAD_LIMIT', None)
            self.assertEqual(ec._ninja_parallelism_args(), [])

    def test_jobs_and_load_limit_from_env(self):
        with mock.patch.dict(os.environ, {'VELXIO_NINJA_JOBS': '4', 'VELXIO_NINJA_LOAD_LIMIT': '6'}):
            self.assertEqual(ec._ninja_parallelism_args(), ['-j', '4', '-l', '6.0'])

    def test_user_code_error_does_not_trigger_a_reconfigure(self):
        r = ec._RunResult(1, 'FAILED: esp-idf/main/sketch.ino.cpp.obj\n'
                             'sketch.ino.cpp:5:3: error: expected ; before }\n', '')
        self.assertFalse(ec._ninja_failure_wants_configure(r))

    def test_configure_trouble_triggers_a_reconfigure(self):
        for text in (
            'ninja: error: loading \'build.ninja\': No such file or directory',
            "ninja: error: 'sdkconfig', needed by 'build.ninja', missing and no known rule to make it",
            'CMake Error at /opt/esp-idf-v5/tools/cmake/build.cmake:123 (message):',
            'The downloaded component "espressif/mdns" is corrupted',
        ):
            r = ec._RunResult(1, text, '')
            self.assertTrue(ec._ninja_failure_wants_configure(r), text)


class NicePreexecTests(unittest.TestCase):
    def test_none_and_zero_inherit(self):
        self.assertIsNone(ec._nice_preexec(None))
        self.assertIsNone(ec._nice_preexec(0))

    def test_positive_nice_yields_a_callable(self):
        fn = ec._nice_preexec(10)
        self.assertTrue(callable(fn))


if __name__ == '__main__':
    unittest.main()
