/*
 * CO2 sensor — a programmable analog sensor with a LIVE slider.
 *
 * chip.json declares a `controls` entry for the `ppm` attribute, so while
 * the simulation runs the user gets a slider (click the chip); every tick
 * the chip re-reads the attribute and drives OUT with the mapped voltage:
 *
 *     0 V at 400 ppm ... 5 V at 5000 ppm (linear)
 *
 * Wire OUT to a board analog pin (e.g. Arduino A0) and read it back:
 *
 *     ppm = 400 + analogRead(A0) * (5.0 / 1023.0) / 5.0 * 4600
 *
 * The pattern to copy for any programmable sensor: attribute + repeating
 * timer + vx_pin_dac_write, re-reading the attribute inside the callback
 * (never cache it — the slider changes it mid-run).
 */
#include "velxio-chip.h"

#define PPM_MIN 400.0
#define PPM_MAX 5000.0
#define VOLTS_MAX 5.0

typedef struct {
  vx_pin out;
  vx_attr ppm;
  vx_timer timer;
} chip_state_t;

static chip_state_t S;

static void on_tick(void *user_data) {
  (void)user_data;
  double ppm = vx_attr_read(S.ppm);          /* live slider value */
  if (ppm < PPM_MIN) ppm = PPM_MIN;
  if (ppm > PPM_MAX) ppm = PPM_MAX;
  double volts = (ppm - PPM_MIN) / (PPM_MAX - PPM_MIN) * VOLTS_MAX;
  vx_pin_dac_write(S.out, volts);
}

void chip_setup(void) {
  S.out = vx_pin_register("OUT", VX_ANALOG);
  S.ppm = vx_attr_register("ppm", 1000);
  S.timer = vx_timer_create(on_tick, 0);
  vx_timer_start(S.timer, 50000000ULL, true);  /* every 50 ms (nanoseconds) */
  on_tick(0);                                  /* drive the initial level */
  vx_log("co2 sensor ready");
}
