#ifndef OPENBOARD_PORTFOLIO_H
#define OPENBOARD_PORTFOLIO_H
#include "openboard.h"
void portfolio_schema(sqlite3 *connection);
bool portfolio_handle(Request *request, Response *response);
#endif
