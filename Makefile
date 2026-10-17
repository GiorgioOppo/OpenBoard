CC ?= cc
PKG_CONFIG ?= pkg-config
OPENSSL_CFLAGS := $(shell $(PKG_CONFIG) --cflags openssl 2>/dev/null)
OPENSSL_LIBS := $(shell $(PKG_CONFIG) --libs openssl 2>/dev/null || echo -lcrypto)
MONGOC_PKG := $(shell $(PKG_CONFIG) --exists libmongoc-1.0 2>/dev/null && echo libmongoc-1.0 || ($(PKG_CONFIG) --exists mongoc2 2>/dev/null && echo mongoc2))
EXTERNAL_STORAGE ?= $(shell $(PKG_CONFIG) --exists libpq $(MONGOC_PKG) 2>/dev/null && test -n "$(MONGOC_PKG)" && echo 1 || echo 0)
CFLAGS ?= -O2 -g -std=c11 -Wall -Wextra -Wpedantic
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L
CPPFLAGS += $(OPENSSL_CFLAGS)
LDLIBS += -lsqlite3 -pthread $(OPENSSL_LIBS)
ifeq ($(EXTERNAL_STORAGE),1)
ifeq ($(MONGOC_PKG),)
$(error EXTERNAL_STORAGE=1 richiede il driver C MongoDB)
endif
CPPFLAGS += -DOB_EXTERNAL_STORAGE $(shell $(PKG_CONFIG) --cflags libpq $(MONGOC_PKG))
LDLIBS += $(shell $(PKG_CONFIG) --libs libpq $(MONGOC_PKG))
endif
SOURCES := $(wildcard src/*.c)
HEADERS := $(wildcard src/*.h)
PREFIX ?= /usr/local
DESTDIR ?=
NODE ?= node

.PHONY: all build run test test-sanitize test-frontend test-security test-docs test-cloud install install-frontend clean FORCE
all: build
build: build/openboard
build/.config: FORCE
	@mkdir -p build
	@printf '%s\n' '$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) $(LDLIBS)' | cmp -s - $@ || printf '%s\n' '$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) $(LDLIBS)' > $@
build/openboard: $(SOURCES) $(HEADERS) Makefile build/.config
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SOURCES) -o $@ $(LDFLAGS) $(LDLIBS)
run: build/openboard
	./build/openboard
test: build/openboard
	python3 -m unittest discover -s tests -p 'test_*.py' -v
build/openboard-sanitize: $(SOURCES) $(HEADERS) Makefile build/.config
	mkdir -p build
	$(CC) $(CPPFLAGS) -O1 -g -std=c11 -Wall -Wextra -Wpedantic -fsanitize=address,undefined $(SOURCES) -o $@ $(LDFLAGS) $(LDLIBS)
test-sanitize: build/openboard-sanitize
	OPENBOARD_BINARY="$(CURDIR)/build/openboard-sanitize" UBSAN_OPTIONS=halt_on_error=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
test-frontend:
	python3 scripts/build-locales.py --check
	$(NODE) tests/test_i18n.js
	$(NODE) tests/test_i18n_sources.js
	$(NODE) tests/test_frontend.js
	$(NODE) tests/test_enterprise.js
	$(NODE) tests/test_workflows.js
	$(NODE) tests/test_experience.js
	$(NODE) tests/test_capacity_ui.js
	$(NODE) tests/test_importers.js
	$(NODE) tests/test_import_ui.js
	$(NODE) tests/test_editable_table.js
	$(NODE) tests/test_field_filters.js
	$(NODE) tests/test_field_filter_ui.js
	$(NODE) tests/test_content_search_ui.js
test-cloud: build/openboard
	OPENBOARD_CLOUD_TEST=1 python3 -m unittest discover -s tests -p 'test_cloud.py' -v
test-security:
	$(NODE) tests/test_npm_limits.mjs
test-docs:
	python3 scripts/check-docs.py
install: build/openboard
	install -d "$(DESTDIR)$(PREFIX)/bin"
	install -m 755 build/openboard "$(DESTDIR)$(PREFIX)/bin/openboard"
install-frontend:
	install -d "$(DESTDIR)$(PREFIX)/share/openboard"
	install -m 644 web/*.html web/*.css web/*.js web/*.svg "$(DESTDIR)$(PREFIX)/share/openboard/"
clean:
	rm -rf build
