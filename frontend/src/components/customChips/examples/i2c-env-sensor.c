/*
 * I2C environment sensor — temperature + humidity behind an I2C register
 * map, with LIVE sliders (chip.json `controls`).
 *
 * Register map (7-bit address 0x44):
 *     0x00  temperature, signed, 0.1 C units, little-endian int16
 *     0x02  humidity, 0.1 %RH units, little-endian uint16
 *
 * A master sets the register pointer with a 1-byte write, then reads bytes;
 * the pointer auto-increments. Values are sampled from the attributes at
 * read time, so slider moves show up on the very next transaction.
 *
 *     Wire.beginTransmission(0x44); Wire.write(0x00); Wire.endTransmission();
 *     Wire.requestFrom(0x44, 4);   // t_lo t_hi h_lo h_hi
 */
#include "velxio-chip.h"
#include <string.h>

#define I2C_ADDR 0x44

typedef struct {
  vx_attr temp;      /* degrees C */
  vx_attr humidity;  /* %RH */
  uint8_t reg;       /* register pointer */
  uint8_t regs[4];   /* latched at pointer write */
} chip_state_t;

static chip_state_t S;

static void latch_registers(void) {
  /* Re-read the attributes NOW — the sliders may have moved. */
  int16_t t = (int16_t)(vx_attr_read(S.temp) * 10.0);
  uint16_t h = (uint16_t)(vx_attr_read(S.humidity) * 10.0);
  S.regs[0] = (uint8_t)(t & 0xFF);
  S.regs[1] = (uint8_t)((t >> 8) & 0xFF);
  S.regs[2] = (uint8_t)(h & 0xFF);
  S.regs[3] = (uint8_t)((h >> 8) & 0xFF);
}

static bool on_connect(void *ud, uint8_t addr, bool is_read) {
  (void)ud; (void)addr;
  if (is_read) latch_registers();
  return true;
}

static uint8_t on_read(void *ud) {
  (void)ud;
  uint8_t v = S.reg < sizeof(S.regs) ? S.regs[S.reg] : 0xFF;
  S.reg++;
  return v;
}

static bool on_write(void *ud, uint8_t byte) {
  (void)ud;
  S.reg = byte;
  return true;
}

static void on_stop(void *ud) { (void)ud; }

void chip_setup(void) {
  S.temp = vx_attr_register("temperature", 25);
  S.humidity = vx_attr_register("humidity", 50);

  vx_i2c_config cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.address = I2C_ADDR;
  cfg.scl = vx_pin_register("SCL", VX_INPUT);
  cfg.sda = vx_pin_register("SDA", VX_INPUT);
  cfg.on_connect = on_connect;
  cfg.on_read = on_read;
  cfg.on_write = on_write;
  cfg.on_stop = on_stop;
  vx_i2c_attach(&cfg);
  vx_log("i2c env sensor at 0x44");
}
