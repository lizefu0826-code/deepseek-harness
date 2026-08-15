#ifndef EVENT_COUNTER_H
#define EVENT_COUNTER_H

#include <stdint.h>

void event_record_from_isr(void);
uint32_t event_take_all(void);

#endif
