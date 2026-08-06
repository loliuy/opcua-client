# @tier0/opcua-client

High-scale OPC UA client nodes for Node-RED, backed by open62541 and designed for address spaces with thousands of points.

## Nodes

- `tier0-opcua-connection`: shared client session and credentials.
- `tier0-opcua-browse`: recursive Browse plus a searchable, selectable address-space tree.
- `tier0-opcua-read`: scalar-compatible batch Read with a manual/imported point list.
- `tier0-opcua-write`: scalar-compatible batch Write with a manual/imported point list.
- `tier0-opcua-subscribe`: one or more automatically sharded Subscriptions with many MonitoredItems.

The OPC UA server remains a separate service. This package contains client and collection nodes only.

## Point contract

Browse output can be wired directly into Read or Subscribe. In the Read and Write editors, manually added and imported points appear in one editable list. Import accepts JSON/CSV, merges by NodeId, and immediately shows the parsed rows. Both nodes also accept arrays, JSON strings/buffers, or CSV strings/buffers dynamically:

```json
{
  "payload": [
    {
      "nodeId": "ns=2;s=Line1.Temperature",
      "alias": "line1.temperature",
      "dataType": "Double",
      "samplingInterval": 1000,
      "queueSize": 10
    }
  ],
  "opcua": {
    "command": "replace"
  }
}
```

Subscription commands are `replace`, `add`, `remove`, and `clear`. Read and Write split large arrays into configurable service batches; they do not loop over scalar OPC UA requests.

Subscription notifications use a bounded native C++ queue and cross into JavaScript in batches. In Node-RED batch mode, changes from every server Subscription are merged and emitted when 500 values are ready or the default 50 ms flush window expires. Queue options are:

- `callbackBatchSize`: maximum changes per native callback and Node-RED output message.
- `callbackFlushIntervalMs`: maximum wait for a partially filled Node-RED output batch (default 50 ms).
- `callbackQueueSize`: hard native queue capacity.
- `queueMode`: `all` preserves pending changes; `latest` coalesces by MonitoredItem.
- `overflowPolicy`: `drop-oldest` or `drop-newest` when the hard capacity is reached.
- `outputMode`: `batch` aggregates changes across Subscriptions; `single` preserves one message per change compatibility.

`timestampMode` defaults to `source`, avoiding an unnecessary server timestamp on every high-rate notification. Advanced settings can request `both`, `server`, or `neither`. Notification outputs contain the changing value/status/timestamp plus useful custom point metadata such as `alias`; monitoring configuration that is constant for the lifetime of the item is not repeated on every change.

Large point sets are automatically split across server Subscriptions. `maxItemsPerSubscription` defaults to 5,000 and acts as the fallback safety limit. When the server advertises `MaxMonitoredItemsPerSubscription`, the node uses the smaller limit. Status messages expose `subscriptionCount`, `subscriptionIds`, `desired`, `monitored`, and `failed`.

Every batch includes queue diagnostics in `msg.opcua.queue`, including depth, capacity, maximum depth, enqueued, delivered, dropped, coalesced, batch sequence, and maximum queue lag. Queue overflow is also reported through the node status and warning log; it is never silent.

## Adaptive batching and NodeId cache

Each connection reads the server's standard OperationLimits in one OPC UA Read request after the session is activated. Read, Write, monitored-item creation/removal, and Browse attribute reads automatically use the smaller of the configured batch size and the advertised server limit. A missing or zero limit means unknown/unlimited and preserves the configured batch size. Browse attribute requests are flattened before batching, so even a `MaxNodesPerRead` smaller than the five requested metadata attributes is respected exactly.

Parsed NodeIds are cached per connection in native code. The default capacity is 100,000 entries and is configurable as `NodeId cache size` on the Connection node. The cache uses bounded FIFO eviction, is cleared naturally on reconnect, and can be disabled with capacity `0`. Read and Write batch outputs expose live data through `msg.opcua.clientDiagnostics`; library users can call `client.getDiagnostics()`. Diagnostics include OperationLimits plus cache size, capacity, hits, misses, bypasses, and evictions.

## Native client ownership and command queue

Each Connection owns one native C++ thread. That thread creates and closes the `UA_Client`, executes Connect, Browse, Read, Write, and Subscription commands, and runs `UA_Client_run_iterate`. Node.js async workers only submit commands and wait for their results, so concurrent Flow messages never access one open62541 client from multiple threads.

The native command queue defaults to 256 pending commands and is configurable as `Command queue` under advanced Connection settings. Queue capacity is hard: overload is rejected with an explicit error. A command that remains queued longer than the configured OPC UA request timeout is removed safely; an already-running service call is allowed to finish under open62541's request timeout. Closing a Connection stops accepting work, rejects pending commands, and performs OPC UA cleanup on the owner thread.

`client.getDiagnostics().commandQueue` reports `depth`, `capacity`, `maxDepth`, `active`, `enqueued`, `completed`, `rejected`, and `timedOut`.

## Connection and subscription recovery

The native client reports secure-channel, session, connectivity-check, and subscription-inactivity transitions to a JavaScript connection supervisor. Recoverable channel interruptions keep the native client alive. Terminal failures replace the native client and retry with exponential backoff, 20% jitter, and the configured maximum interval. Operations fail fast with `OPCUA_RECONNECTING` while the connection is unavailable instead of building an unbounded request queue.

Subscribe nodes retain a desired point map independently from live server Subscriptions. After reconnection they serialize reconciliation, validate every old Subscription, rebuild the complete shard set when the server session was lost, and recreate each MonitoredItem once in service-sized batches. A recovery status message has `msg.opcua.operation = "subscription-status"`, `recovered`, `rebuilt`, `reason`, and `dataGapPossible`. `dataGapPossible` is true after a subscription rebuild because values may have changed while the server was unavailable.

Connection diagnostics also expose the current channel/session state and supervisor counters: client generation, reconnect attempts/successes, terminal replacements, and last recovery duration.

Read CSV point lists require a `nodeId` header. Write CSV uses `nodeId,value,dataType`; `dataType` is optional when the Write node supplies a default. Large Write CSV payloads are scanned once directly into compact native-write descriptors, avoiding several full-size intermediate point lists. Duplicate NodeIds retain the last row. Other supported descriptor columns include `alias`, `samplingInterval`, `queueSize`, `deadbandType`, and `deadbandValue`.

```csv
nodeId,value,dataType
ns=2;s=Line1.Speed,1200,Double
ns=2;s=Line1.Enabled,true,Boolean
```

An incoming point list takes priority over the point list saved in the node. Existing flows that stored a single static NodeId are migrated into the visible list when their editor is opened. A migrated Write item keeps using its incoming `msg.payload`; imported Write rows normally carry `nodeId`, `value`, and optional `dataType`.

## Browse tree selection

The Browse editor loads the address space through the deployed Connection node. Object nodes act as folders and Variable nodes are selectable outputs. Checking a parent selects every variable below it; clearing an individual child changes every affected ancestor to the half-selected state. The editor shows the selected/total variable count and provides branch expansion, name/path/NodeId filtering, Select all, and Clear actions.

The selected Variable descriptors are saved with the Browse node. Each input message outputs the full saved selection so it can be wired directly into Read or Subscribe. Send `msg.opcua.liveBrowse = true` when a flow needs to ignore the saved selection and perform a new live Browse.

Node editors show only the standard settings by default. Connection security/timeouts/cache, Browse limits/paging, Read/Write batching/output, and Subscribe queue/deadband tuning remain available under a closed **Advanced settings** section. Existing flows retain their stored advanced values.

## Build

Linux build prerequisites are a C/C++ compiler, CMake, Python, and Git.

```bash
npm install
npm test
```

`npm install` builds the pinned open62541 release first and then compiles the N-API addon. To rebuild only the native layer after changing C++ code, run `npm run build`.

The open62541 build is static and position-independent so the resulting N-API addon does not need a runtime open62541 shared library.

Security mode `None` is supported in the first implementation slice. Sign and SignAndEncrypt are visible in the connection model but require an encryption-enabled open62541 build and certificate trust-store integration before production use.

## Native integration test

The fixture requires Python package `opcua==0.98.13`:

```bash
python3 -m venv .build/test-venv
.build/test-venv/bin/pip install opcua==0.98.13
PATH="$PWD/.build/test-venv/bin:$PATH" npm run test:native
```

## Stress test

The stress test starts a real writable OPC UA server, browses the complete address space, performs repeated batched reads and writes, creates subscriptions containing all MonitoredItems, verifies change delivery for every point, and reports latency, throughput, memory, CPU, and event-loop delay.

```bash
OPCUA_STRESS_POINTS=5000 \
OPCUA_STRESS_READ_ROUNDS=5 \
OPCUA_STRESS_WRITE_ROUNDS=2 \
npm run test:stress
```

The point count, read/write rounds, service batch size, port, and notification timeout are configurable with the `OPCUA_STRESS_*` environment variables used in `test/stress.js`.

For a strict Node-RED runtime test, `test:nodered` deploys a temporary isolated Flow into a running editor, triggers the real nodes through HTTP, records Node-RED process memory/CPU, and removes the Flow afterward while verifying that the original flow set is unchanged:

```bash
OPCUA_NODERED_POINTS=5000 npm run test:nodered
```

To inject a real server outage after subscription creation, restart the fixture, require automatic subscription reconstruction, and then verify every point converges through the deployed Node-RED nodes:

```bash
OPCUA_NODERED_POINTS=1000 npm run test:nodered:reconnect
```

See [BENCHMARK.md](BENCHMARK.md) for the recorded 1,000, 5,000, 10,000, and sustained 20,000 point baselines.

## Scale defaults

- Browse limit: 10,000 returned points.
- Attribute read batch: 200 points.
- Read/Write service batch: 500 points.
- MonitoredItem creation batch: 500 points.
- Subscription capacity fallback: 5,000 MonitoredItems (automatically reduced by the server limit).
- Node-RED batch flush: 500 changes or 50 ms.
- Subscription callback queue: 10,000 pending changes.
- Parsed NodeId cache: 100,000 entries per connection.
- Native command queue: 256 pending commands per connection.

Configured service batches are automatically clamped to the server's advertised OperationLimits.
