#ifndef OPENBOARD_COLLABORATION_H
#define OPENBOARD_COLLABORATION_H
#include "openboard.h"
void collaboration_schema(sqlite3 *connection);
bool collaboration_handle(Request *request, Response *response);
#endif
