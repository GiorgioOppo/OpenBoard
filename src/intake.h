#ifndef OPENBOARD_INTAKE_H
#define OPENBOARD_INTAKE_H
#include "openboard.h"
void intake_schema(sqlite3 *connection);
bool intake_handle(Request *request, Response *response);
#endif
