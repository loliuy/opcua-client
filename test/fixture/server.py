#!/usr/bin/env python3
"""Small writable OPC UA address space for native addon integration tests."""

import os
import sys
import time
from opcua import Server, ua


def configure_security(server):
    certificate = os.environ.get("OPCUA_FIXTURE_SERVER_CERTIFICATE")
    private_key = os.environ.get("OPCUA_FIXTURE_SERVER_PRIVATE_KEY")
    if bool(certificate) != bool(private_key):
        raise RuntimeError(
            "Set both OPCUA_FIXTURE_SERVER_CERTIFICATE and "
            "OPCUA_FIXTURE_SERVER_PRIVATE_KEY"
        )
    if not certificate:
        return "None"

    server.set_application_uri(
        os.environ.get(
            "OPCUA_FIXTURE_APPLICATION_URI",
            "urn:tier0:opcua:python-server",
        )
    )
    server.load_certificate(certificate)
    server.load_private_key(private_key)
    server.set_security_policy([
        ua.SecurityPolicyType.NoSecurity,
        ua.SecurityPolicyType.Basic256Sha256_Sign,
        ua.SecurityPolicyType.Basic256Sha256_SignAndEncrypt,
    ])
    server.set_security_IDs(["Anonymous", "Username"])
    expected_username = os.environ.get("OPCUA_FIXTURE_USERNAME", "operator")
    expected_password = os.environ.get("OPCUA_FIXTURE_PASSWORD", "tier0-test")

    def user_manager(_session, username, password):
        return username == expected_username and password == expected_password

    server.user_manager.set_user_manager(user_manager)
    return "None,Sign/Basic256Sha256,SignAndEncrypt/Basic256Sha256"


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4843
    point_count = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    area_size = int(sys.argv[3]) if len(sys.argv) > 3 else 500
    operation_limit = int(sys.argv[4]) if len(sys.argv) > 4 else None
    include_array = len(sys.argv) > 5 and sys.argv[5] == "array"
    bind_host = os.environ.get("OPCUA_FIXTURE_HOST", "127.0.0.1")
    server = Server()
    server.set_endpoint(f"opc.tcp://{bind_host}:{port}")
    security = configure_security(server)
    namespace = server.register_namespace("https://github.com/loliuy/opcua-client/test")
    folder = server.get_objects_node().add_folder(f"ns={namespace};s=Factory", "Factory")
    array_node_id = None
    if include_array:
        array_node_id = f"ns={namespace};s=Factory.Array"
        array_variable = folder.add_variable(
            array_node_id,
            "Array",
            ua.Variant([0.0, 1.0, 2.0, 3.0, 4.0], ua.VariantType.Double),
        )
        array_variable.set_writable()
    areas = {}
    for index in range(point_count):
        area_index = index // area_size
        if area_index not in areas:
            areas[area_index] = folder.add_folder(
                f"ns={namespace};s=Factory.Area{area_index:03d}",
                f"Area{area_index:03d}",
            )
        variable = areas[area_index].add_variable(
            f"ns={namespace};s=Factory.Area{area_index:03d}.Point{index:06d}",
            f"Point{index:06d}",
            float(index),
        )
        variable.set_writable()

    if operation_limit is not None:
        for node_id in (11705, 11707, 11710, 11714):
            server.get_node(ua.NodeId(node_id, 0)).set_value(
                ua.Variant(operation_limit, ua.VariantType.UInt32)
            )

    server.start()
    array_suffix = f" {array_node_id}" if array_node_id else ""
    print(
        f"RUNNING opc.tcp://{bind_host}:{port} "
        f"ns={namespace};s=Factory.Area000.Point000000 "
        f"ns={namespace};s=Factory {point_count}{array_suffix} "
        f"security={security}",
        flush=True,
    )
    try:
        while True:
            time.sleep(1)
    finally:
        server.stop()


if __name__ == "__main__":
    main()
