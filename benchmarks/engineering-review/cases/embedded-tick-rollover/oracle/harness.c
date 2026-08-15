#include "deadline.h"

int main(void)
{
  if (deadline_expired(0xfffffff0u, 32u, 0xfffffff8u)) return 1;
  if (!deadline_expired(0xfffffff0u, 32u, 0x00000011u)) return 2;
  if (deadline_expired(100u, 10u, 105u)) return 3;
  if (!deadline_expired(100u, 10u, 111u)) return 4;
  return 0;
}
