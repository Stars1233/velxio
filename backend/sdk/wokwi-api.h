/*
 * wokwi-api.h — forwarder so a chip written for Wokwi compiles unchanged
 * (`#include "wokwi-api.h"` is the first line of every Wokwi chip).
 *
 * This is NOT Wokwi's header: it forwards to Velxio's clean-room
 * compatibility layer, which adapts the documented Wokwi API onto the
 * native velxio-chip.h. See wokwi-compat.h for what is covered.
 */
#ifndef WOKWI_API_H
#define WOKWI_API_H
#include "wokwi-compat.h"
#endif
