#pragma once

#include <stdbool.h>
#include "cJSON.h"

void incidents_init(void);
void incidents_mark_restart(bool firmware_update);
const char *miner_reset_reason(int reason);
cJSON *incidents_json(void);

void pool_stats_select(bool fallback, const char *switch_reason);
void pool_stats_share(bool fallback, bool accepted, const char *reason, float latency_ms);
cJSON *pool_stats_json(const char *primary_host, unsigned primary_port,
                     const char *fallback_host, unsigned fallback_port);
