#ifndef OPENBOARD_REVIEWS_H
#define OPENBOARD_REVIEWS_H
#include "openboard.h"
void reviews_schema(sqlite3 *connection);
bool reviews_handle(Request *request, Response *response);
#endif
