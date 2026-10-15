CC ?= cc
CFLAGS ?= -O2 -g -std=c11 -Wall -Wextra -Wpedantic
CPPFLAGS ?= -D_POSIX_C_SOURCE=200809L
LDLIBS ?= -lsqlite3

.PHONY: all build run test clean
all: build
build: build/openboard
build/openboard: src/server.c
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) $< -o $@ $(LDFLAGS) $(LDLIBS)
run: build/openboard
	./build/openboard
test: build/openboard
	python3 tests/test_api.py
clean:
	rm -rf build
