#include <stdint.h>
#include "uart_timeout.h"

static uint32_t tick = UINT32_MAX - 3u;
static uint32_t calls;

uint32_t platform_tick_now(void)
{
  calls += 1u;
  tick += 1u;
  return tick;
}

int main(void)
{
  uart_regs_t uart = { 0u };
  if (uart_wait_ready(&uart, UINT32_MAX - 3u, 8u) == 0) return 1;
  if (calls == 0u || calls > 64u) return 2;
  uart.status = UART_READY;
  if (uart_wait_ready(&uart, tick, 8u) != 0) return 3;
  return 0;
}
