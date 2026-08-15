#ifndef DMA_SENDER_H
#define DMA_SENDER_H

#include <stddef.h>
#include <stdint.h>

int platform_dma_start(const uint8_t *data, size_t length);
int dma_send_frame(const uint8_t *data, size_t length);
void dma_send_complete(void);

#endif
