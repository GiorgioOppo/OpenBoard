#ifndef OPENBOARD_SECRETS_H
#define OPENBOARD_SECRETS_H
/* Resolve supported *_FILE credentials once, before starting any workers.
 * Diagnostics never include a credential or a file's contents. */
int ob_load_secret_files(void);
#endif
