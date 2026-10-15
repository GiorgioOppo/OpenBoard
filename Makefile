CC ?= cc
PKG_CONFIG ?= pkg-config
OPENSSL_CFLAGS := $(shell $(PKG_CONFIG) --cflags openssl 2>/dev/null)
OPENSSL_LIBS := $(shell $(PKG_CONFIG) --libs openssl 2>/dev/null || echo -lcrypto)
CFLAGS ?= -O2 -g -std=c11 -Wall -Wextra -Wpedantic
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L
CPPFLAGS += $(OPENSSL_CFLAGS)
LDLIBS += -lsqlite3 -pthread $(OPENSSL_LIBS)
SOURCES := $(wildcard src/*.c)
HEADERS := $(wildcard src/*.h)

.PHONY: all build run test test-sanitize clean
all: build
build: build/openboard
build/openboard: $(SOURCES) $(HEADERS)
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SOURCES) -o $@ $(LDFLAGS) $(LDLIBS)
run: build/openboard
	./build/openboard
test: build/openboard
	python3 -m unittest discover -s tests -p 'test_*.py' -v
build/openboard-sanitize: $(SOURCES) $(HEADERS)
	mkdir -p build
	$(CC) $(CPPFLAGS) -O1 -g -std=c11 -Wall -Wextra -Wpedantic -fsanitize=address,undefined $(SOURCES) -o $@ $(LDFLAGS) $(LDLIBS)
test-sanitize: build/openboard-sanitize
	OPENBOARD_BINARY="$(CURDIR)/build/openboard-sanitize" UBSAN_OPTIONS=halt_on_error=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
clean:
	rm -rf build
