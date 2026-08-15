#ifndef DEADLINE_H
#define DEADLINE_H

#include <stdbool.h>
#include <stdint.h>

bool deadline_expired(uint32_t start, uint32_t timeout, uint32_t now);

#endif
