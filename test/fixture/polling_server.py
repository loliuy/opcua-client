#!/usr/bin/env python3
"""Real UA test server with a controlled slow Read service and one-shot failure.

The delay is in the server, not in the client under test. The control variables
are test-only fixtures and must never be deployed to a production server.
"""

import os
import sys
import time
from opcua import Server, ua
from opcua.common.utils import ServiceError


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4860
    point_count = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
    host = os.environ.get("OPCUA_FIXTURE_HOST", "127.0.0.1")
    server = Server()
    server.set_endpoint(f"opc.tcp://{host}:{port}")
    namespace = server.register_namespace("urn:tier0:test:polling")
    folder = server.get_objects_node().add_folder(f"ns={namespace};s=Polling", "Polling")
    for index in range(point_count):
        folder.add_variable(f"ns={namespace};s=Polling.Point{index}", f"Point{index}", float(index))

    delay = folder.add_variable(f"ns={namespace};s=Polling.DelayMs", "DelayMs", 0, ua.VariantType.UInt32)
    fail_next = folder.add_variable(f"ns={namespace};s=Polling.FailNext", "FailNext", False)
    delay.set_writable()
    fail_next.set_writable()
    original_read = server.iserver.attribute_service.read

    def slow_read(params):
        if any(str(item.NodeId.Identifier).startswith("Polling.Point") for item in params.NodesToRead):
            if fail_next.get_value():
                fail_next.set_value(False)
                # Send an actual UA ServiceFault, matching the field status code.
                raise ServiceError(ua.StatusCodes.BadTimeout)
            time.sleep(delay.get_value() / 1000)
        return original_read(params)

    server.iserver.attribute_service.read = slow_read
    server.start()
    print(f"RUNNING opc.tcp://{host}:{port} namespace={namespace} points={point_count}", flush=True)
    try:
        while True:
            time.sleep(1)
    finally:
        server.stop()


if __name__ == "__main__":
    main()
