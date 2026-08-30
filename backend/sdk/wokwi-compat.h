/*
 * wokwi-compat.h — adapters for an alternate, legacy-style header naming
 * scheme over the native Velxio API (velxio-chip.h).
 *
 * CLEAN-ROOM: written for Velxio; no third-party simulator code. Everything
 * here is a thin static-inline / macro layer:
 *   - `chip_init()` maps to Velxio's required `chip_setup()` export.
 *   - Timer periods given in microseconds convert to nanoseconds.
 *   - Config structs (pin_watch_config_t, i2c_config_t, uart_config_t,
 *     spi_config_t, timer_config_t) are translated field by field, so their
 *     memory layout does not need to match anything.
 *
 * License: MIT (Velxio project).
 */

#ifndef WOKWI_COMPAT_H
#define WOKWI_COMPAT_H

#include "velxio-chip.h"
#include <stdint.h>
#include <stdbool.h>

/* ── Entry point ───────────────────────────────────────────────────────────
 * The chip author writes `void chip_init(void)`. Velxio's required export is
 * chip_setup; this macro renames the author's definition at compile time. */
#define chip_init chip_setup

/* ── Pins ────────────────────────────────────────────────────────────────── */

typedef vx_pin pin_t;

#define NO_PIN ((pin_t)-1)

/* Pin modes and values: numerically identical to the vx_ constants. */
#ifndef INPUT
#define INPUT          VX_INPUT
#endif
#ifndef OUTPUT
#define OUTPUT         VX_OUTPUT
#endif
#define INPUT_PULLUP   VX_INPUT_PULLUP
#define INPUT_PULLDOWN VX_INPUT_PULLDOWN
#define ANALOG         VX_ANALOG
#define OUTPUT_LOW     VX_OUTPUT_LOW
#define OUTPUT_HIGH    VX_OUTPUT_HIGH

#ifndef LOW
#define LOW  VX_LOW
#endif
#ifndef HIGH
#define HIGH VX_HIGH
#endif

/* Edge constants for pin_watch. */
#define RISING  VX_EDGE_RISING
#define FALLING VX_EDGE_FALLING
#define BOTH    VX_EDGE_BOTH

static inline pin_t pin_init(const char *name, uint32_t mode) {
  return vx_pin_register(name, (vx_pin_mode)mode);
}

static inline void pin_mode(pin_t pin, uint32_t mode) {
  vx_pin_set_mode(pin, (vx_pin_mode)mode);
}

static inline void pin_write(pin_t pin, uint32_t value) {
  vx_pin_write(pin, (int)value);
}

static inline uint32_t pin_read(pin_t pin) {
  return (uint32_t)vx_pin_read(pin);
}

static inline float pin_adc_read(pin_t pin) {
  return (float)vx_pin_read_analog(pin);
}

static inline void pin_dac_write(pin_t pin, float voltage) {
  vx_pin_dac_write(pin, (double)voltage);
}

typedef struct {
  void *user_data;
  uint32_t edge;
  void (*pin_change)(void *user_data, pin_t pin, uint32_t value);
} pin_watch_config_t;

static inline bool pin_watch(pin_t pin, const pin_watch_config_t *config) {
  if (!config || !config->pin_change) return false;
  /* uint32_t and int are both i32 in the wasm ABI, so the callback's
   * indirect-call signature matches the native watch dispatch exactly. */
  vx_pin_watch(
    pin,
    (vx_edge)config->edge,
    (void (*)(void *, vx_pin, int))config->pin_change,
    config->user_data
  );
  return true;
}

/* pin_watch_stop: same name and shape in both APIs (vx_ prefix aside). */
static inline void pin_watch_stop_compat(pin_t pin) { vx_pin_watch_stop(pin); }
#define pin_watch_stop vx_pin_watch_stop

/* ── Attributes ──────────────────────────────────────────────────────────── */

typedef vx_attr attr_t;

static inline attr_t attr_init(const char *name, uint32_t default_value) {
  return vx_attr_register(name, (double)default_value);
}

static inline attr_t attr_init_float(const char *name, float default_value) {
  return vx_attr_register(name, (double)default_value);
}

static inline uint32_t attr_read(attr_t attr) {
  return (uint32_t)vx_attr_read(attr);
}

static inline float attr_read_float(attr_t attr) {
  return (float)vx_attr_read(attr);
}

static inline attr_t attr_string_init(const char *name) {
  return vx_attr_register_string(name, "");
}

static inline uint32_t attr_string_get_length(attr_t attr) {
  return vx_attr_string_len(attr);
}

static inline uint32_t attr_string_read(attr_t attr, char *buffer, uint32_t buffer_size) {
  return vx_attr_string_read(attr, buffer, buffer_size);
}

/* ── I2C device ──────────────────────────────────────────────────────────── */

typedef vx_i2c i2c_dev_t;

typedef struct {
  void *user_data;
  uint32_t address;   /* 7-bit address */
  pin_t scl;
  pin_t sda;
  bool (*connect)(void *user_data, uint32_t address, bool read);
  uint8_t (*read)(void *user_data);
  bool (*write)(void *user_data, uint8_t data);
  void (*disconnect)(void *user_data);
} i2c_config_t;

static inline i2c_dev_t i2c_init(const i2c_config_t *config) {
  vx_i2c_config cfg;
  __builtin_memset(&cfg, 0, sizeof(cfg));
  cfg.address = (uint8_t)config->address;
  cfg.scl = config->scl;
  cfg.sda = config->sda;
  /* connect(addr) narrows uint32->uint8: identical i32 wasm signature. */
  cfg.on_connect = (bool (*)(void *, uint8_t, bool))config->connect;
  cfg.on_read = config->read;
  cfg.on_write = config->write;
  cfg.on_stop = config->disconnect;
  cfg.user_data = config->user_data;
  return vx_i2c_attach(&cfg);
}

/* ── UART ────────────────────────────────────────────────────────────────── */

typedef vx_uart uart_dev_t;

typedef struct {
  void *user_data;
  pin_t rx;
  pin_t tx;
  uint32_t baud_rate;
  void (*rx_data)(void *user_data, uint8_t byte);
  void (*write_done)(void *user_data);
} uart_config_t;

static inline uart_dev_t uart_init(const uart_config_t *config) {
  vx_uart_config cfg;
  __builtin_memset(&cfg, 0, sizeof(cfg));
  cfg.rx = config->rx;
  cfg.tx = config->tx;
  cfg.baud_rate = config->baud_rate;
  cfg.on_rx_byte = config->rx_data;
  cfg.on_tx_done = config->write_done;
  cfg.user_data = config->user_data;
  return vx_uart_attach(&cfg);
}

static inline bool uart_write(uart_dev_t uart, uint8_t *buffer, uint32_t count) {
  return vx_uart_write(uart, buffer, count);
}

/* ── SPI device ──────────────────────────────────────────────────────────── */

typedef vx_spi spi_dev_t;

typedef struct {
  void *user_data;
  pin_t sck;
  pin_t mosi;
  pin_t miso;
  pin_t cs;    /* informational — the runtime watches CS as GPIO */
  uint32_t mode;
  void (*done)(void *user_data, uint8_t *buffer, uint32_t count);
} spi_config_t;

static inline spi_dev_t spi_init(const spi_config_t *config) {
  vx_spi_config cfg;
  __builtin_memset(&cfg, 0, sizeof(cfg));
  cfg.sck = config->sck;
  cfg.mosi = config->mosi;
  cfg.miso = config->miso;
  cfg.cs = config->cs;
  cfg.mode = config->mode;
  cfg.on_done = config->done;
  cfg.user_data = config->user_data;
  return vx_spi_attach(&cfg);
}

static inline void spi_start(spi_dev_t spi, uint8_t *buffer, uint32_t count) {
  vx_spi_start(spi, buffer, count);
}

static inline void spi_stop(spi_dev_t spi) {
  vx_spi_stop(spi);
}

/* ── Time and timers ─────────────────────────────────────────────────────── */

static inline uint64_t get_sim_nanos(void) {
  return vx_sim_now_nanos();
}

/* Avoid colliding with POSIX timer_t from WASI's <time.h>. */
typedef vx_timer wokwi_timer_t;
#ifndef _TIME_H
typedef vx_timer timer_t;
#else
#define timer_t wokwi_timer_t
#endif

typedef struct {
  void (*callback)(void *user_data);
  void *user_data;
} timer_config_t;

static inline wokwi_timer_t timer_init(const timer_config_t *config) {
  return vx_timer_create(config->callback, config->user_data);
}

/* The alternate timer_start takes MICROseconds; the native API is nanoseconds. */
static inline void timer_start(wokwi_timer_t timer, uint32_t micros, bool repeat) {
  vx_timer_start(timer, (uint64_t)micros * 1000ULL, repeat);
}

static inline void timer_start_ns(wokwi_timer_t timer, uint64_t nanos, bool repeat) {
  vx_timer_start(timer, nanos, repeat);
}

static inline void timer_stop(wokwi_timer_t timer) {
  vx_timer_stop(timer);
}

/* ── Framebuffer ─────────────────────────────────────────────────────────── */

typedef vx_buffer buffer_t;

static inline buffer_t framebuffer_init(uint32_t *width, uint32_t *height) {
  return vx_framebuffer_init(width, height);
}

static inline void buffer_write(buffer_t buffer, uint32_t offset, const void *data, uint32_t data_len) {
  vx_buffer_write(buffer, offset, data, data_len);
}

static inline void buffer_read(buffer_t buffer, uint32_t offset, void *data, uint32_t data_len) {
  vx_buffer_read(buffer, offset, data, data_len);
}

#endif /* WOKWI_COMPAT_H */
