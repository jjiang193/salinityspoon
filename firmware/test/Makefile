# Host-side tests for the firmware's logic headers. No ESP32 toolchain needed.
#
#   make        build and run
#   make clean

CXX      ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -O1 -I.

all: run

test_firmware: test_firmware.cpp arduino_shim.h ../spoon/config.h ../spoon/salinity.h ../spoon/bite_detector.h
	$(CXX) $(CXXFLAGS) -o $@ test_firmware.cpp

run: test_firmware
	./test_firmware

clean:
	rm -f test_firmware

.PHONY: all run clean
