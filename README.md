# @tier0/opcua-client

High-scale OPC UA client nodes for Node-RED, backed by open62541 and designed for address spaces with thousands of points.

## Nodes

- `tier0-opcua-connection`: shared client session and credentials.
- `tier0-opcua-browse`: recursive Browse plus a searchable, selectable address-space tree.
- `tier0-opcua-read`: scalar/array batch Read with optional IndexRange and a manual/imported point list.
- `tier0-opcua-write`: scalar/array/matrix batch Write with optional IndexRange and a manual/imported point list.
- `tier0-opcua-subscribe`: one or more automatically sharded Subscriptions with many MonitoredItems.

The OPC UA server remains a separate service. This package contains client and collection nodes only.

Every node includes bilingual Chinese and English guidance in the Node-RED Help
sidebar, covering its purpose, message contract, key settings, and operational
notes for industrial deployments.

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

Subscribe nodes can save or import their own point list and establish it automatically after deploy. Repeating an unchanged `replace` command preserves existing server Subscriptions and MonitoredItems. Only added, removed, or monitoring-parameter-changed points are reconciled. A rejected point is reported in `failures` without stopping valid points, and requested versus server-revised publishing, sampling, lifetime, keepalive, and queue settings are included in subscription status output.

New Read nodes default to compact results: `nodeId`, optional `alias`, `value`,
`statusCode`, and `sourceTimestamp`. Browse metadata and subscription-only point
settings are not repeated on every Read. **Value only** emits an array in point-
list order for batch output and a scalar for single/split output. **Full
metadata** preserves the original descriptor-rich output and includes client
diagnostics. Flow JSON created before this option existed continues to use Full
metadata until the node is edited and a result detail is selected.

Subscription notifications use a bounded native C++ queue and cross into JavaScript in batches. In Node-RED batch mode, changes from every server Subscription are merged and emitted when 500 values are ready or the default 50 ms flush window expires. Queue options are:

- `callbackBatchSize`: maximum changes per native callback and Node-RED output message.
- `callbackFlushIntervalMs`: maximum wait for a partially filled Node-RED output batch (default 50 ms).
- `callbackQueueSize`: hard native queue capacity.
- `queueMode`: `all` preserves pending changes; `latest` coalesces by MonitoredItem.
- `overflowPolicy`: `drop-oldest` or `drop-newest` when the hard capacity is reached.
- `outputMode`: `batch` aggregates changes across Subscriptions; `single` preserves one message per change compatibility.

`timestampMode` defaults to `source`, avoiding an unnecessary server timestamp on every high-rate notification. Advanced settings can request `both`, `server`, or `neither`. Notification outputs contain the changing value/status/timestamp plus useful custom point metadata such as `alias`; monitoring configuration that is constant for the lifetime of the item is not repeated on every change.

New Subscribe nodes default to compact notifications: `nodeId`, optional
`alias`, `value`, `statusCode`, and `sourceTimestamp`. Browse metadata, native
MonitoredItem handles, and sharding details are omitted. In batch **Value only**
mode, `msg.payload` is a value array and `msg.opcua.identifiers` is the matching
NodeId/alias array. Parallel arrays preserve order and repeated changes from the
same point. **Full metadata** preserves the original output for diagnostics and
Flow JSON created before this option existed continues to use it.

New Subscribe nodes also default to server queue size `1`, `discardOldest=true`,
and native queue mode `latest`. This keeps real-time state current during
backpressure instead of replaying stale values. Set queue mode to `all` and
increase the server queue size for pulses, alarms, counters, or history capture
where every intermediate transition must be retained. Existing Flow JSON keeps
its saved queue settings; runtime fallbacks remain compatible with older nodes.

Large point sets are automatically split across server Subscriptions. `maxItemsPerSubscription` defaults to 5,000 and acts as the fallback safety limit. When the server advertises `MaxMonitoredItemsPerSubscription`, the node uses the smaller limit. Status messages expose `subscriptionCount`, `subscriptionIds`, `desired`, `monitored`, and `failed`.

Every batch includes queue diagnostics in `msg.opcua.queue`, including depth, capacity, maximum depth, enqueued, delivered, dropped, coalesced, batch sequence, and maximum queue lag. Queue overflow is also reported through the node status and warning log; it is never silent.

## Adaptive batching and NodeId cache

Each connection reads the server's standard OperationLimits in one OPC UA Read request after the session is activated. Read, Write, monitored-item creation/removal, and Browse attribute reads automatically use the smaller of the configured batch size and the advertised server limit. A missing or zero limit means unknown/unlimited and preserves the configured batch size. Browse attribute requests are flattened before batching, so even a `MaxNodesPerRead` smaller than the five requested metadata attributes is respected exactly.

Parsed NodeIds are cached per connection in native code. The default capacity is 100,000 entries and is configurable as `NodeId cache size` on the Connection node. The cache uses bounded FIFO eviction, is cleared naturally on reconnect, and can be disabled with capacity `0`. Read and Write batch outputs expose live data through `msg.opcua.clientDiagnostics`; library users can call `client.getDiagnostics()`. Diagnostics include OperationLimits plus cache size, capacity, hits, misses, bypasses, and evictions.

## Native client ownership and command queue

Each Connection owns one native C++ thread. That thread creates and closes the `UA_Client`, executes Connect, Browse, Read, Write, and Subscription commands, and runs `UA_Client_run_iterate`. Node.js async workers only submit commands and wait for their results, so concurrent Flow messages never access one open62541 client from multiple threads.

The native command queue defaults to 256 pending commands and is configurable as `Command queue` under advanced Connection settings. Queue capacity is hard: overload is rejected with an explicit error. A command that remains queued longer than the configured OPC UA request timeout is removed safely; an already-running service call is allowed to finish under open62541's request timeout. Closing a Connection stops accepting work, rejects pending commands, and performs OPC UA cleanup on the owner thread.

`client.getDiagnostics().commandQueue` reports `depth`, `capacity`, `maxDepth`, `active`, `enqueued`, `completed`, `rejected`, and `timedOut`.

## Session ownership and duplicate-connection governance

One `tier0-opcua-connection` configuration node owns one native client and one
OPC UA Session. Read, Write, Browse, and Subscribe nodes that reference that
same configuration reuse the Session, including when the configuration is
shared across Node-RED flow tabs. Different Connection configuration nodes are
never merged implicitly because separate Sessions may be required for isolation.

When equivalent Connection configurations target the same endpoint, security
mode/policy, and user identity, the runtime emits a warning that an additional
Session will be created. Reuse the existing Connection configuration to avoid
duplicate Server load. Enable **Allow parallel Session** only when the extra
Session is intentional. Read/Write diagnostics and subscription status outputs
include `connectionGovernance`, with the equivalent and active configuration
counts.

`connectionUsage` reports the current Read/Write/Browse/Subscribe consumer count
and types, each consumer's last use, aggregate operation counts, and connection
idle time. It is diagnostic only: `automaticIdleDisconnect` is false. A deployed
Connection therefore remains stable for subscriptions until its configuration
node is closed; deleting the last referencing flow is visible as a zero consumer
count but does not race an idle timer.

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

## Arrays and IndexRange

Read and Write descriptors accept the standard OPC UA `indexRange` field. The
legacy `range` spelling is normalized to `indexRange`. One-dimensional examples
are `0` and `2:5`; matrix ranges use a comma, for example `0:1,2:3`. Invalid or
descending ranges are rejected before an OPC UA service call.

Write values may be scalar JavaScript values, arrays, or rectangular nested
arrays. Nested arrays are converted to OPC UA matrix dimensions; ragged or empty
arrays are rejected. A direct array payload is treated as the value when the
message or Write node identifies one target NodeId. A configured single
`useInput` point behaves the same way. Set `msg.opcua.pointList = true` only when
an array payload must be forced to mean a dynamic list of point descriptors.

OPC UA Int64 and UInt64 values inside the JavaScript safe-integer range are
returned as Numbers. Larger values are returned as exact decimal strings so
totals and counters never silently lose precision. Use decimal strings for
64-bit writes; unsafe Numbers, fractional integers, and values outside the OPC UA
type range are rejected before a service request.

```json
{
  "topic": "ns=2;s=Recipe.Steps",
  "indexRange": "4:6",
  "dataType": "Double",
  "payload": [12.5, 13.0, 13.5]
}
```

An incoming point list takes priority over the point list saved in the node. Existing flows that stored a single static NodeId are migrated into the visible list when their editor is opened. A migrated Write item keeps using its incoming `msg.payload`; imported Write rows normally carry `nodeId`, `value`, and optional `dataType`.

## Browse tree selection

The Browse editor loads the address space through the deployed Connection node. Object nodes act as folders and Variable nodes are selectable outputs. Checking a parent selects every variable below it; clearing an individual child changes every affected ancestor to the half-selected state. The editor shows the selected/total variable count and provides branch expansion, name/path/NodeId filtering, Select all, and Clear actions.

The selected Variable descriptors are saved with the Browse node. Each input message outputs the full saved selection so it can be wired directly into Read or Subscribe. Send `msg.opcua.liveBrowse = true` when a flow needs to ignore the saved selection and perform a new live Browse.

Recursive Browse requests batch multiple parent nodes and honor the server's
`MaxNodesPerBrowse` OperationLimit. `Browse batch` and `References / page` bound
each request. If `Maximum depth` or `Maximum nodes` truncates a live Browse,
`msg.opcua.browse.truncated` and `truncationReason` make the partial result
explicit. Unused server ContinuationPoints are released before the operation
finishes.

Node editors show only the standard settings by default. Connection security/timeouts/cache, Browse limits/paging, Read/Write batching/output, and Subscribe queue/deadband tuning remain available under a closed **Advanced settings** section. Existing flows retain their stored advanced values.

## Server compatibility profiles

Connection nodes default to the standard OPC UA profile. Select **Siemens
WinCC** for classic WinCC or Unified servers that do not advertise usable
OperationLimits: Read, Write, and MonitoredItem service calls then use a
conservative fallback of 200 items per request, while advertised non-zero
server limits still take precedence. Subscribe nodes use at most 1000
MonitoredItems per Subscription and remove Deadband filters because WinCC does
not support `ModifyMonitoredItems`/Deadband behavior consistently. The selected
profile and effective subscription behavior are included in status diagnostics.

## Secure connections

Connection nodes support `None/None` and `Sign` or `SignAndEncrypt` with
`Basic256Sha256`, `Aes128_Sha256_RsaOaep`, or `Aes256_Sha256_RsaPss`. Secure
connections require a client certificate, its private key, and at least one
trusted Server or CA certificate. Trust is strict: an
empty trust list is rejected instead of silently accepting every Server
certificate. Optional CRL files can be supplied as a newline-separated list.
Password-protected PEM private keys use the separate Node-RED credential field,
so the password is not stored in the normal Flow configuration.

Before opening the native client, the package checks certificate validity,
certificate/private-key matching, RSA key type and minimum 2048-bit strength,
trusted-certificate validity, and Application URI consistency. When the client
certificate contains exactly one URI, leaving Application URI empty selects it
automatically. Username authentication uses the selected secure endpoint and
its advertised UserTokenPolicy.

The Connection editor can call `GetEndpoints`, filters the response to the
implemented policies, and selects an endpoint compatible with Anonymous or
Username authentication. Client certificates, private keys, trusted Server/CA
certificates, and CRLs can be uploaded from the editor. Uploaded files are kept
under `<Node-RED userDir>/opcua-pki/<connection>/` with owner-only file
permissions and the managed runtime path is stored in the Connection
configuration. Existing and advanced deployments can still enter filesystem
paths visible to the Node-RED runtime directly. Uploaded private-key bytes are
never stored in the Flow JSON, and removing the Connection node removes its
managed security-file directory.

## Offline installation

The published package contains a prebuilt `linux-x64-musl` native addon for the
Node-RED Alpine image, the pinned open62541 v1.4.16 source archive, and its
`node-addon-api` build dependency. The same Node-API binary is verified on Node
20.19.6 and Node 22.22.2. Installing the tarball on the supported target does
not contact npm or GitHub and does not invoke a compiler:

```bash
npm install ./tier0-opcua-client-0.6.0.tgz --offline
```

The loader uses the bundled native addon directly. Set
`OPCUA_CLIENT_FORCE_BUILD=1` only to force a source rebuild. Unsupported
platforms fall back to the bundled open62541 source and therefore still require
a local C/C++ toolchain, CMake, Python, Node headers, and OpenSSL development
files. No network is needed for open62541 itself.

Create the supported prebuild and package on Linux with:

```bash
npm ci --ignore-scripts
npm run build:offline-prebuild -- --nodedir=/usr/local
npm pack
```

Before publishing, `npm run test:release` runs the JavaScript, native, offline
runtime, and deployed Node-RED suites when their test Server and Node-RED runtime
are available. `npm pack` also reruns the JavaScript suite and rejects an
incomplete offline package.

See `THIRD_PARTY_NOTICES.md` for the bundled open62541 and node-addon-api
licenses.

## Source build

Linux build prerequisites are a C/C++ compiler, CMake, Python, Git, and the
OpenSSL development package.

```bash
npm install
npm test
```

When no compatible prebuild is available, `npm install` builds the bundled
open62541 release and then compiles the N-API addon. To rebuild only the native
layer after changing C++ code, run `npm run build`.

The open62541 build is static and position-independent so the resulting N-API addon does not need a runtime open62541 shared library.

The pinned open62541 build uses its OpenSSL encryption backend. The initial
secure policy scope intentionally excludes deprecated Basic128Rsa15 and
Basic256 policies.

## Native integration test

The fixture requires Python package `opcua==0.98.13`:

```bash
python3 -m venv .build/test-venv
.build/test-venv/bin/pip install opcua==0.98.13
PATH="$PWD/.build/test-venv/bin:$PATH" npm run test:native
```

The Python fixture is used for the general native suite but does not implement
OPC UA IndexRange semantics. Build the included open62541 test Server to verify
real partial array reads and writes:

```bash
npm run build:test-server
OPCUA_TEST_SERVER_BINARY="$PWD/build/open62541-test-server" \
node test/native.integration.js
```

Run the secure integration test against a real Server after placing its
certificate in the trust list:

```bash
OPCUA_SECURE_ENDPOINT=opc.tcp://server:4840 \
OPCUA_CLIENT_CERTIFICATE=/pki/client.der \
OPCUA_CLIENT_PRIVATE_KEY=/pki/client-key.pem \
OPCUA_TRUSTED_CERTIFICATES=/pki/server.der \
npm run test:secure
```

Set `OPCUA_USERNAME` and `OPCUA_PASSWORD` when the selected Endpoint uses a
Username identity token. `OPCUA_CLIENT_APPLICATION_URI` must match the URI in
the client certificate when it differs from the default.

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

## Status and error output (0.6.1)

Browse, Read, Write and Subscribe now have two outputs. Output 1 retains data;
output 2 emits structured diagnostic messages. Connect output 2 to Debug, a
JSON/file node or your logging service. The shared Connection configuration
has no output ports: its state is reported by each referencing operation node,
identified by nodeId and connectionId.

诊断输出可独立接 Debug、JSON + File 或日志服务。payload.level 为 info / warn / error；
连接断开、订阅无响应、恢复失败、点位 Bad 状态和队列丢数据都会输出对应事件。
恢复成功也会输出 info，但连接恢复或订阅重建不代表已经收到新数据。

Messages contain payload.level, event, message, time (ISO 8601), nodeId,
connectionId, operation, retrying and optional statusCode/counts. Subscription
recovery includes rebuilt and dataGapPossible. The envelope contains
opcua.operation = "diagnostic". No input values, endpoint URLs, credentials,
certificates or raw SDK error text are copied to this output.

Background connection and subscription startup/recovery failures also call
`node.error(error, msg)` on each affected operation node. Connect a Catch node
in the same flow to Debug or your error-handling logic; scope Catch to the UA
operation nodes as needed. The shared Connection configuration no longer emits
duplicate state/fault warnings. A continuing background failure is reported to
Catch once per operation node until recovery. Connection recovery re-arms
connection errors; subscription errors require successful reconciliation.
Failed input requests still call `done(error)` for each request, preserving the
original message. A concurrent connection failure reported by that input does
not also generate a background Catch error. Point-level non-Good results remain
available on output 2; configuration advice and cleanup warnings remain warnings.

Identical event/status-code pairs are emitted at most once per 30 seconds per
node. The next emitted matching event includes suppressed repeats; there is
no delayed timer flush. Connection restoration resets this suppression window.
This 30-second limit applies only to diagnostic output; background Catch errors
use the recovery-based rule above.

For Subscribe, **Status messages → Both outputs (legacy compatible)** is the
default: existing subscription-status messages remain on output 1 and the new
structured events appear on output 2. Choose **Output 2 only** to keep output 1
strictly for data. Existing Flow JSON without statusOutput keeps its old behavior;
all existing wires on output 1 remain unchanged. New diagnostic events are not
sent to output 1. Structured events contain summaries; existing detailed
subscription-status payloads are preserved only in compatibility mode.

This change adds reporting; it does not add a data-silence watchdog or change
OPC UA reconnection/monitoring behavior.

## Point failure details (0.6.2)

Diagnostic output now includes payload.failures: an array of nodeId (OPC UA
point identifier), optional alias, statusCode and a short explanation. The
outer payload.nodeId still identifies the Node-RED flow node. Read/Write
partial failures display yellow status with success/total and failure counts.
The detail list is available even when data output is set to Value only.

Each event includes at most 100 failed points; failed reports the full failure
count, failuresTruncated indicates truncation, and omittedFailures reports the
remaining count. Use Full metadata on output 1 for complete Read/Write results.
Subscription compatibility output also retains its existing bounded failures.
Duplicate event suppression compares the failing point identities and status
codes so a different batch of failing points is not hidden by the first batch.
No point values or raw input messages are copied. A whole-service exception
without per-point results is still an operation failure: it cannot identify
which individual points failed.
