#ifndef OPENBOARD_AUTH_H
#define OPENBOARD_AUTH_H
#include "openboard.h"

void auth_schema(sqlite3 *connection);
bool auth_handle(Request *request, Response *response);
bool auth_authorize(Request *request, Response *response);
bool auth_is_admin(const Request *request);
bool auth_board_allowed(const Request *request, int64_t board_id, bool write);
bool auth_add_board_owner(const Request *request, int64_t board_id);
bool auth_starred(const Request *request, int64_t board_id, bool local_starred);
bool auth_set_star(const Request *request, int64_t board_id, bool starred);
#endif
