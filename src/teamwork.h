#ifndef OPENBOARD_TEAMWORK_H
#define OPENBOARD_TEAMWORK_H
#include "openboard.h"
void teamwork_schema(sqlite3 *connection);
bool teamwork_handle(Request *request, Response *response);
#endif
