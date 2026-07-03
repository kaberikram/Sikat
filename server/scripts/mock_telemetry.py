"""Mock spatial telemetry: simulates a camera operator orbiting the stage.

Sends `telemetry` messages over the Director WebSocket; the server converts
them into MOVE_CAMERA packets, so this exercises the exact client path a
headset would.

    uv run python scripts/mock_telemetry.py --duration 15
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import time

import websockets


async def run(url: str, radius: float, height: float, duration: float, hz: float) -> None:
    async with websockets.connect(url) as ws:
        print(f"connected to {url}; orbiting for {duration}s")
        t0 = time.time()
        orbit_period = 12.0  # seconds per full circle
        while (t := time.time() - t0) < duration:
            theta = t * (2 * math.pi / orbit_period)
            # Camera on the circle, yawed to face the origin (store euler
            # convention: identity looks toward -Z), slight downward pitch.
            pose = {
                "position": [radius * math.sin(theta), height, radius * math.cos(theta)],
                "rotation": [-0.08, theta, 0.0],
            }
            await ws.send(
                json.dumps(
                    {
                        "type": "telemetry",
                        "timestamp": time.time(),
                        "source": "mock_camera",
                        "pose": pose,
                    }
                )
            )
            await asyncio.sleep(1.0 / hz)
        print("done")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://localhost:8000/ws")
    parser.add_argument("--radius", type=float, default=6.0)
    parser.add_argument("--height", type=float, default=1.5)
    parser.add_argument("--duration", type=float, default=15.0)
    parser.add_argument("--hz", type=float, default=20.0)
    args = parser.parse_args()
    asyncio.run(run(args.url, args.radius, args.height, args.duration, args.hz))


if __name__ == "__main__":
    main()
