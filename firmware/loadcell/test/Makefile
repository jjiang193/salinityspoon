# Bite detector simulation (host-side, no hardware). `make run`
CXX ?= clang++
CXXFLAGS = -std=c++17 -O2 -I. -I../SalinityTest -include Arduino.h

bite_sim: bite_sim.cpp Arduino.h ../SalinityTest/BiteDetector.cpp ../SalinityTest/BiteDetector.h ../SalinityTest/Sensors.h
	$(CXX) $(CXXFLAGS) bite_sim.cpp -o bite_sim

run: bite_sim
	./bite_sim | grep -v FAIL
	SEEDBASE=90000 ./bite_sim | grep -v FAIL | sed -n '/Action/,$$p'

.PHONY: run
