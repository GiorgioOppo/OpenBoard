#ifndef OPENBOARD_SPRINTS_H
#define OPENBOARD_SPRINTS_H
#include "openboard.h"
void sprints_schema(sqlite3 *connection);
bool sprints_handle(Request *request, Response *response);
#endif
