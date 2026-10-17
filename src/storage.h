/* SPDX-License-Identifier: MIT */
#ifndef OPENBOARD_STORAGE_H
#define OPENBOARD_STORAGE_H
#include "openboard.h"

int ob_storage_configure_cache(void);
bool ob_storage_cache_write_allowed(void);
/* Called inside the serialized upload transaction: 1 allowed, 0 quota, -1 SQL error. */
int ob_storage_attachment_admission(int64_t bytes);
Response ob_storage_inventory(Request *request);
size_t ob_storage_metrics_format(char *buffer, size_t capacity);
#endif
