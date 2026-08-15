#ifndef UART_TIMEOUT_H
#define UART_TIMEOUT_H

#include <stdint.h>

enum { UART_READY = 1u };

typedef struct {
  volatile uint32_t status;
} uart_regs_t;

uint32_t platform_tick_now(void);
int uart_wait_ready(uart_regs_t *uart, uint32_t start, uint32_t timeout);

#endif
