/* Minimal writable OPC UA server for native addon integration tests. */

#include <open62541/server.h>
#include <open62541/server_config_default.h>

#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static volatile UA_Boolean running = true;

static void
stopHandler(int signalNumber) {
    (void)signalNumber;
    running = false;
}

static UA_StatusCode
addObject(UA_Server *server, UA_UInt16 namespaceIndex, const char *nodeId,
          const char *name, UA_NodeId parentNodeId) {
    UA_ObjectAttributes attributes = UA_ObjectAttributes_default;
    attributes.displayName = UA_LOCALIZEDTEXT("en-US", (char *)name);
    return UA_Server_addObjectNode(
        server, UA_NODEID_STRING(namespaceIndex, (char *)nodeId),
        parentNodeId, UA_NODEID_NUMERIC(0, UA_NS0ID_ORGANIZES),
        UA_QUALIFIEDNAME(namespaceIndex, (char *)name),
        UA_NODEID_NUMERIC(0, UA_NS0ID_FOLDERTYPE), attributes, NULL, NULL);
}

static UA_StatusCode
addDoubleVariable(UA_Server *server, UA_UInt16 namespaceIndex,
                  const char *nodeId, const char *name,
                  UA_NodeId parentNodeId, UA_Double value) {
    UA_VariableAttributes attributes = UA_VariableAttributes_default;
    attributes.displayName = UA_LOCALIZEDTEXT("en-US", (char *)name);
    attributes.dataType = UA_TYPES[UA_TYPES_DOUBLE].typeId;
    attributes.accessLevel = UA_ACCESSLEVELMASK_READ | UA_ACCESSLEVELMASK_WRITE;
    UA_Variant_setScalar(&attributes.value, &value, &UA_TYPES[UA_TYPES_DOUBLE]);
    return UA_Server_addVariableNode(
        server, UA_NODEID_STRING(namespaceIndex, (char *)nodeId),
        parentNodeId, UA_NODEID_NUMERIC(0, UA_NS0ID_HASCOMPONENT),
        UA_QUALIFIEDNAME(namespaceIndex, (char *)name),
        UA_NODEID_NUMERIC(0, UA_NS0ID_BASEDATAVARIABLETYPE), attributes,
        NULL, NULL);
}

static UA_StatusCode
addDoubleArray(UA_Server *server, UA_UInt16 namespaceIndex,
               UA_NodeId parentNodeId) {
    UA_Double values[] = {0.0, 1.0, 2.0, 3.0, 4.0};
    UA_UInt32 dimensions[] = {5};
    UA_VariableAttributes attributes = UA_VariableAttributes_default;
    attributes.displayName = UA_LOCALIZEDTEXT("en-US", "Array");
    attributes.dataType = UA_TYPES[UA_TYPES_DOUBLE].typeId;
    attributes.accessLevel = UA_ACCESSLEVELMASK_READ | UA_ACCESSLEVELMASK_WRITE;
    attributes.valueRank = 1;
    attributes.arrayDimensions = dimensions;
    attributes.arrayDimensionsSize = 1;
    UA_Variant_setArray(&attributes.value, values, 5, &UA_TYPES[UA_TYPES_DOUBLE]);
    return UA_Server_addVariableNode(
        server, UA_NODEID_STRING(namespaceIndex, "Factory.Array"),
        parentNodeId, UA_NODEID_NUMERIC(0, UA_NS0ID_HASCOMPONENT),
        UA_QUALIFIEDNAME(namespaceIndex, "Array"),
        UA_NODEID_NUMERIC(0, UA_NS0ID_BASEDATAVARIABLETYPE), attributes,
        NULL, NULL);
}

static UA_StatusCode
addInt64Variable(UA_Server *server, UA_UInt16 namespaceIndex,
                 const char *nodeId, const char *name,
                 UA_NodeId parentNodeId, UA_Int64 value) {
    UA_VariableAttributes attributes = UA_VariableAttributes_default;
    attributes.displayName = UA_LOCALIZEDTEXT("en-US", (char *)name);
    attributes.dataType = UA_TYPES[UA_TYPES_INT64].typeId;
    attributes.accessLevel = UA_ACCESSLEVELMASK_READ | UA_ACCESSLEVELMASK_WRITE;
    UA_Variant_setScalar(&attributes.value, &value, &UA_TYPES[UA_TYPES_INT64]);
    return UA_Server_addVariableNode(
        server, UA_NODEID_STRING(namespaceIndex, (char *)nodeId),
        parentNodeId, UA_NODEID_NUMERIC(0, UA_NS0ID_HASCOMPONENT),
        UA_QUALIFIEDNAME(namespaceIndex, (char *)name),
        UA_NODEID_NUMERIC(0, UA_NS0ID_BASEDATAVARIABLETYPE), attributes,
        NULL, NULL);
}

static UA_StatusCode
addUInt64Variable(UA_Server *server, UA_UInt16 namespaceIndex,
                  const char *nodeId, const char *name,
                  UA_NodeId parentNodeId, UA_UInt64 value) {
    UA_VariableAttributes attributes = UA_VariableAttributes_default;
    attributes.displayName = UA_LOCALIZEDTEXT("en-US", (char *)name);
    attributes.dataType = UA_TYPES[UA_TYPES_UINT64].typeId;
    attributes.accessLevel = UA_ACCESSLEVELMASK_READ | UA_ACCESSLEVELMASK_WRITE;
    UA_Variant_setScalar(&attributes.value, &value, &UA_TYPES[UA_TYPES_UINT64]);
    return UA_Server_addVariableNode(
        server, UA_NODEID_STRING(namespaceIndex, (char *)nodeId),
        parentNodeId, UA_NODEID_NUMERIC(0, UA_NS0ID_HASCOMPONENT),
        UA_QUALIFIEDNAME(namespaceIndex, (char *)name),
        UA_NODEID_NUMERIC(0, UA_NS0ID_BASEDATAVARIABLETYPE), attributes,
        NULL, NULL);
}

int
main(int argc, char **argv) {
    const UA_UInt16 port = (UA_UInt16)(argc > 1 ? strtoul(argv[1], NULL, 10) : 4843);
    const size_t pointCount = (size_t)(argc > 2 ? strtoul(argv[2], NULL, 10) : 20);
    const size_t areaSize = (size_t)(argc > 3 ? strtoul(argv[3], NULL, 10) : 500);
    const UA_UInt32 operationLimit =
        (UA_UInt32)(argc > 4 ? strtoul(argv[4], NULL, 10) : 0);

    if(port == 0 || areaSize == 0) {
        fprintf(stderr, "port and area size must be greater than zero\n");
        return EXIT_FAILURE;
    }

    signal(SIGINT, stopHandler);
    signal(SIGTERM, stopHandler);

    UA_Server *server = UA_Server_new();
    if(!server)
        return EXIT_FAILURE;

    UA_ServerConfig *config = UA_Server_getConfig(server);
    UA_StatusCode status = UA_ServerConfig_setMinimal(config, port, NULL);
    if(status != UA_STATUSCODE_GOOD) {
        fprintf(stderr, "server configuration failed: %s\n", UA_StatusCode_name(status));
        UA_Server_delete(server);
        return EXIT_FAILURE;
    }
    config->maxNodesPerRead = operationLimit;
    config->maxNodesPerWrite = operationLimit;
    config->maxNodesPerBrowse = operationLimit;
    config->maxMonitoredItemsPerCall = operationLimit;

    const UA_UInt16 namespaceIndex = UA_Server_addNamespace(
        server, "https://github.com/loliuy/opcua-client/test");
    const UA_NodeId objectsFolder = UA_NODEID_NUMERIC(0, UA_NS0ID_OBJECTSFOLDER);
    const UA_NodeId factoryNode = UA_NODEID_STRING(namespaceIndex, "Factory");
    status = addObject(server, namespaceIndex, "Factory", "Factory", objectsFolder);
    if(status == UA_STATUSCODE_GOOD)
        status = addDoubleArray(server, namespaceIndex, factoryNode);
    if(status == UA_STATUSCODE_GOOD)
        status = addInt64Variable(server, namespaceIndex, "Factory.Int64", "Int64",
                                  factoryNode, INT64_MAX);
    if(status == UA_STATUSCODE_GOOD)
        status = addUInt64Variable(server, namespaceIndex, "Factory.UInt64", "UInt64",
                                   factoryNode, UINT64_MAX);

    size_t currentArea = (size_t)-1;
    char currentAreaId[64] = {0};
    for(size_t index = 0; status == UA_STATUSCODE_GOOD && index < pointCount; ++index) {
        const size_t areaIndex = index / areaSize;
        char areaName[32];
        char pointId[96];
        char pointName[32];
        if(areaIndex != currentArea) {
            snprintf(currentAreaId, sizeof(currentAreaId),
                     "Factory.Area%03zu", areaIndex);
            snprintf(areaName, sizeof(areaName), "Area%03zu", areaIndex);
            status = addObject(server, namespaceIndex, currentAreaId,
                               areaName, factoryNode);
            if(status != UA_STATUSCODE_GOOD)
                break;
            currentArea = areaIndex;
        }
        snprintf(pointId, sizeof(pointId), "Factory.Area%03zu.Point%06zu",
                 areaIndex, index);
        snprintf(pointName, sizeof(pointName), "Point%06zu", index);
        status = addDoubleVariable(server, namespaceIndex, pointId, pointName,
                                   UA_NODEID_STRING(namespaceIndex, currentAreaId),
                                   (UA_Double)index);
    }

    if(status != UA_STATUSCODE_GOOD) {
        fprintf(stderr, "address space creation failed: %s\n", UA_StatusCode_name(status));
        UA_Server_delete(server);
        return EXIT_FAILURE;
    }

    status = UA_Server_run_startup(server);
    if(status != UA_STATUSCODE_GOOD) {
        fprintf(stderr, "server startup failed: %s\n", UA_StatusCode_name(status));
        UA_Server_delete(server);
        return EXIT_FAILURE;
    }

    printf("RUNNING opc.tcp://127.0.0.1:%u "
           "ns=%u;s=Factory.Area000.Point000000 "
           "ns=%u;s=Factory %zu ns=%u;s=Factory.Array\n",
           (unsigned)port, (unsigned)namespaceIndex,
           (unsigned)namespaceIndex, pointCount, (unsigned)namespaceIndex);
    fflush(stdout);

    while(running)
        UA_Server_run_iterate(server, true);
    status = UA_Server_run_shutdown(server);
    UA_Server_delete(server);
    return status == UA_STATUSCODE_GOOD ? EXIT_SUCCESS : EXIT_FAILURE;
}
