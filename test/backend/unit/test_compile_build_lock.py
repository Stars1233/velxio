"""
The compile route holds NO build lock of its own; the compiler does.

Until 2026-09 `routes/compile.py` took a per-target `asyncio.Lock` keyed on
(idf_target, arduino variant) INSIDE the lane slot. The compiler has since
grown its own lock per persistent build dir (`_variant_lock`, one per variant
or replica), which protects exactly the shared resource. Keeping the coarser
route lock on top cost velxio.dev its second heavy slot: 78% of ESP-IDF builds
are esp32:esp32:esp32, so the second slot spent whole hours holding a slot
while blocked on the lock (2026-09-02 12:00: one slot 3647 s of build time,
the other 943 s, queue p50 43 minutes).

`_build_identity` stays: the duration estimate is keyed on it, and it still
has to name the build DIRECTORY (esp32 and esp32cam share one) rather than the
FQBN.

Run from the repo root:
    python -m pytest test/backend/unit/test_compile_build_lock.py -v
"""

import inspect
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.api.routes import compile as compile_module


class RouteHoldsNoBuildLockTests(unittest.TestCase):
    def test_the_route_level_target_lock_is_gone(self):
        self.assertFalse(
            hasattr(compile_module, '_target_lock'),
            'the per-target lock is back in the route; it serialises every '
            'esp32 build and wastes the second heavy slot (see module docstring)',
        )
        self.assertFalse(hasattr(compile_module, '_TARGET_LOCKS'))

    def test_the_job_runner_does_not_lock_inside_the_slot(self):
        source = inspect.getsource(compile_module._compile_job)
        self.assertNotIn('_target_lock', source)
        self.assertIn('lane.slot(', source)

    def test_the_sync_route_does_not_lock_inside_the_slot(self):
        source = inspect.getsource(compile_module.compile_sketch)
        self.assertNotIn('_target_lock', source)


class BuildIdentityTests(unittest.TestCase):
    def test_boards_sharing_a_variant_share_one_identity(self):
        """esp32 and esp32cam build in the same dir (both build.variant=esp32)."""
        self.assertEqual(
            compile_module._build_identity('esp32:esp32:esp32'),
            compile_module._build_identity('esp32:esp32:esp32cam'),
        )

    def test_different_chips_have_different_identities(self):
        self.assertNotEqual(
            compile_module._build_identity('esp32:esp32:esp32'),
            compile_module._build_identity('esp32:esp32:esp32c3'),
        )

    def test_non_esp32_boards_keep_their_own_identity(self):
        """`_idf_target` defaults unknown boards to esp32; a non-ESP32 FQBN
        must not collapse onto that pair (it would share the esp32 estimate)."""
        self.assertNotEqual(
            compile_module._build_identity('definitely:not:a:board'),
            compile_module._build_identity('also:not:a:board'),
        )
        self.assertEqual(
            compile_module._build_identity('arduino:avr:uno'), 'arduino:avr:uno',
        )


if __name__ == '__main__':
    unittest.main()
