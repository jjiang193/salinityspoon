#!/usr/bin/env python3
"""Mock persona — configures the backend AI persona.

Run this script to simulate different user profiles (e.g. chronic kidney issues)
so the Echo AI voice coach responds dynamically based on their specific health limits.

Example usage:
    python tools/mock_persona.py --condition "chronic kidney issues" --limit 1500
    python tools/mock_persona.py --condition "high blood pressure" --limit 2000
    python tools/mock_persona.py --clear
"""

import argparse
import urllib.request
import json
import sys

def main():
    p = argparse.ArgumentParser(description="Configure the Salinity Spoon AI user persona")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--condition", type=str, default="none", help="Medical condition (e.g., 'chronic kidney issues')")
    p.add_argument("--limit", type=int, default=2300, help="Strict daily sodium limit in mg")
    p.add_argument("--clear", action="store_true", help="Reset to a standard user with no conditions and 2300mg limit")
    
    args = p.parse_args()
    
    condition = "none" if args.clear else args.condition
    limit = 2300 if args.clear else args.limit

    url = f"http://{args.host}:{args.port}/api/ai/persona"
    data = json.dumps({
        "condition": condition,
        "sodium_limit_mg": limit
    }).encode("utf-8")
    
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
            if condition == "none":
                print("Persona cleared. The AI will now act as a standard user with a 2300mg limit.")
            else:
                print(f"Persona updated! The AI now knows you have '{result['condition']}' and a strict {result['limit']}mg limit.")
    except Exception as e:
        print(f"Failed to update persona: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

