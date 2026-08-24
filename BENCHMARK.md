# OPC UA client benchmark

Recorded on 2026-08-05 in the Node-RED 4.1.2 container used for development, with Node.js 20.19.6, open62541 1.4.16, security mode `None`, and a Python OPC UA server running in the same container over loopback.

The benchmark uses real OPC UA service calls. It browses every variable, reads and writes the full point set in batches of 500, creates one Subscription containing all MonitoredItems, waits for the final value of every point, and removes all MonitoredItems during cleanup.

| Scenario | Browse | Read P50 | Write P50 / P95 | Subscribe | Notifications | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 points, 3 reads, 2 writes | 431 ms | 60 ms | 77 / 77 ms | 79 ms | 3,000 | 54.9 MB |
| 5,000 points, 5 reads, 2 writes | 2,143 ms | 301 ms | 374 / 374 ms | 397 ms | 15,000 | 73.4 MB |
| 5,000 points, 5 reads, 20 writes | 2,085 ms | 300 ms | 375 / 494 ms | 450 ms | 105,000 | 88.6 MB |
| 10,000 points, 5 reads, 5 writes | 4,150 ms | 618 ms | 766 / 998 ms | 867 ms | 60,000 | 95.6 MB |

All scenarios completed without bad OPC UA status codes. The sustained scenario converged to the final value for 5,000/5,000 points; the capacity scenario converged for 10,000/10,000 points.

The 10,000-point throughput was approximately 2,410 browsed points/s, 16,183 read points/s, 13,063 written points/s, and 11,534 monitored items/s. Event-loop delay P95 was 20.7 ms and maximum delay was 56.2 ms.

## Reproduce

```bash
OPCUA_STRESS_POINTS=10000 \
OPCUA_STRESS_READ_ROUNDS=5 \
OPCUA_STRESS_WRITE_ROUNDS=5 \
OPCUA_STRESS_NOTIFY_TIMEOUT=180000 \
npm run test:stress
```

These are local-loopback engineering baselines, not guarantees for a customer network. Production acceptance should repeat the same test against the target server, network latency, security policy, server OperationLimits, sampling interval, and expected value-change rate.

## Node-RED deployed Flow baseline

`npm run test:nodered` deploys a temporary isolated Flow into the running Node-RED editor. Requests travel through Node-RED HTTP In/Response, Function, Browse, Read, Write, and Subscribe node instances. Read receives an imported JSON point list and Write receives CSV directly, without a separate normalization node. The controller verifies final subscription convergence, clears the subscription, removes the temporary Flow, and asserts that the original Flow set is restored.

| Scenario | Browse | Read P50 / P95 | Write P50 / P95 | Subscribe | Final convergence | Node-RED peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 points, smoke | 65 ms | 18 / 18 ms | 20 / 20 ms | 23 ms | 100/100 | 111.0 MB |
| 1,000 points, direct JSON Read / CSV Write | 471 ms | 56 / 56 ms | 68 / 68 ms | 75 ms | 1,000/1,000 | 112.4 MB |
| 5,000 points, 5 reads, 20 writes | 1,939 ms | 301 / 327 ms | 377 / 535 ms | 391 ms | 5,000/5,000 | 202.9 MB |
| 10,000 points, 5 reads, 5 writes | 4,131 ms | 635 / 671 ms | 764 / 1,069 ms | 806 ms | 10,000/10,000 | 188.3 MB |

The 5,000-point sustained Flow performed 100,000 writes. Its collector processed 101,001 post-setup data-change messages and converged every point to the final round. The 10,000-point Flow processed 51,000 post-setup messages and also converged every point. Initial subscription notifications can arrive before the collector receives the subscription-status message, so the reported notification total is not used as a loss assertion; final value convergence is the correctness gate.

The Node-RED editor was opened during the 5,000-point run. The temporary tab showed the real nodes with `5000 points`, `5000 read`, and `5000 written` statuses before automatic cleanup.

The selectable Browse tree endpoint was also exercised against the real fixture. The 1,000-point run returned 1,002 tree nodes containing exactly 1,000 variables. A saved three-variable selection produced exactly those three NodeIds from the deployed Browse node. In the editor, selecting the 100-point root selected 100/100 variables; clearing one leaf changed the count to 99/100 and placed both the area and root checkboxes into the half-selected state. Reopening the node retained all 99 selections.

## Automatic reconnect and subscription reconstruction

The fault-injection test deploys the same real Node-RED Flow, creates a 1,000-item subscription, stops the OPC UA fixture, waits while the connection supervisor replaces terminal clients with bounded backoff, restarts the server on the same endpoint, and requires the Subscribe node to validate and rebuild its lost server-side subscription before writes continue.

The recorded run used three reconnect attempts and recovered in 3,458 ms. The Subscribe node rebuilt all 1,000/1,000 MonitoredItems. Two subsequent 1,000-point write rounds delivered all 3,000 notifications (including initial values), converged 1,000/1,000 final values, dropped zero changes, and reached a maximum native queue depth of 944. The temporary Flow was removed and the original Node-RED flow set was verified unchanged.

## Native notification batching optimization

The P0 optimization replaced one C++/JavaScript callback per value with a bounded native queue, batched callbacks, queue diagnostics, and zero-copy reuse of the native JavaScript change object in the Subscribe node. Both comparisons use Node-RED `batch` output mode.

| Scenario | Metric | Before | After | Change |
| --- | --- | ---: | ---: | ---: |
| 5,000 points, 20 writes | Node-RED CPU | 4,110 ms | 2,050 ms | -50.1% |
| 5,000 points, 20 writes | Peak RSS | 202.9 MB | 143.1 MB | -29.5% |
| 5,000 points, 20 writes | Native callbacks | about 105,000 | 279 batches | -99.7% |
| 10,000 points, 5 writes | Node-RED CPU | 3,540 ms | 2,570 ms | -27.4% |
| 10,000 points, 5 writes | Peak RSS | 188.3 MB | 151.6 MB | -19.5% |
| 10,000 points, 5 writes | Native callbacks | about 60,000 | 160 batches | -99.7% |

In the optimized 5,000-point test, all 105,000 native notifications were delivered with zero drops, maximum native queue depth 1,667, and reported maximum batch lag 0.45 ms. In the optimized 10,000-point test, all 60,000 notifications were delivered with zero drops, maximum depth 1,526, and maximum lag 0.29 ms. Both tests converged every point to its final value.

The native queue integration test also intentionally uses capacity 5 and batch size 2 while blocking JavaScript. It verifies a hard maximum depth of 5 and an explicit dropped count of 15. A separate `latest` test coalesces repeated values to one 20-item batch with zero drops.

## OperationLimits and NodeId cache optimization

The P1 optimization originally read four standard OperationLimits in one request and added a bounded per-connection native parsed-NodeId cache. It now also reads the optional `MaxMonitoredItemsPerSubscription` server capability. The 5,000-point standalone test recorded 5,011 cache entries, 65,001 hits, 5,011 misses, zero bypasses, and approximately 92.8% hit rate. Browse improved from 2,143 ms to 1,991 ms in the recorded local run; Read P50 remained 301 ms and Write P50 remained within local-run variance at 376 ms.

The optimized Node-RED Flow results were:

| Scenario | Result | Cache | Node-RED CPU | Peak RSS |
| --- | --- | --- | ---: | ---: |
| 5,000 points, 5 reads, 20 writes | 105,000/105,000 notifications, 0 dropped, final 5,000/5,000 | 5,011 entries, 155,001 hits, 0 evictions | 1,990 ms | 139.1 MB |
| 10,000 points, 5 reads, 5 writes | 60,000/60,000 notifications, 0 dropped, final 10,000/10,000 | 10,021 entries, 160,001 hits, 0 evictions | 2,120 ms | 155.3 MB warm process |

Against the immediately preceding P0 runs, 5,000-point Node-RED CPU changed from 2,050 ms to 1,990 ms and peak RSS from 143.1 MB to 139.1 MB. The 10,000-point CPU changed from 2,570 ms to 2,120 ms. The 10,000-point P1 run followed the sustained 5,000-point run in the same Node-RED process, so its 155.3 MB peak is a warmed-process regression value and should not be compared directly with the fresh-process memory baseline.

The native integration fixture advertises the four OperationLimits as 7 and leaves `MaxMonitoredItemsPerSubscription` unspecified, which the client reports as 0 before applying its configured fallback. Its cache capacity is intentionally reduced to 32; the test remains bounded at 32 entries and reports 118 FIFO evictions while Browse, Read, Write, Subscribe, and cleanup all pass.

## Multi-Subscription sharding and timed aggregation

The 2026-08-06 real Node-RED smoke run forced the 100-point set into four Subscriptions by setting `maxItemsPerSubscription=25`. Browse, batch Read, batch Write, subscription creation, and the selectable Browse output all ran through a deployed Flow and a real OPC UA fixture.

- Subscription creation: 72 ms for 100 MonitoredItems across 4 Subscriptions.
- Two complete write rounds: 200 notifications delivered, 0 dropped, final values converged for 100/100 points.
- Combined native queues: maximum depth 200 and capacity 200,000 across the four Subscriptions.
- Node-RED process: 134.9 MB peak RSS and 130 ms sampled CPU for the complete smoke run.

The outage run stopped and restarted the real fixture after subscription creation. The Subscribe node invalidated the old shard set and recovered exactly four Subscriptions containing 100/100 desired points. Subsequent writes again converged 100/100 final values with zero queue drops. Rebuild notifications can include current server values, so final per-point convergence and the recovered Subscription/MonitoredItem counts are the correctness gates rather than an exact raw notification count.

The scale acceptance then used 5,000 points with `maxItemsPerSubscription=1000`. The deployed Node-RED Flow created exactly five Subscriptions in 478 ms, browsed 5,000 variables in 2,047 ms, read them in 321 ms, and completed each 5,000-point write round in 324 ms. The native queues delivered all 15,000 notifications with zero drops; final values converged for 5,000/5,000 points. Peak Node-RED RSS was 150.0 MB.

The matching outage run rebuilt exactly five Subscriptions containing 5,000/5,000 desired points after the server restarted. It again delivered 15,000/15,000 native notifications with zero drops and converged every final value. The owner command queue completed 42/42 commands with maximum depth 4, zero rejection, and zero timeout; peak Node-RED RSS was 151.6 MB.

## Single-owner native command queue

The 2026-08-06 concurrency run used a real 3,000-point OPC UA fixture and submitted four Browse, four 200-point Read, and four 200-point Write operations concurrently. Including Connect, the native owner thread completed 13/13 commands with zero rejection and a maximum command queue depth of 4. A 1 ms JavaScript timer advanced 4,604 times during the run, confirming that the Node.js event loop remained responsive while the native owner serialized OPC UA work.

The overload run reduced command queue capacity to 1. Queue depth never exceeded 1; seven commands were rejected immediately as full and one queued command was safely removed after its one-second queue timeout. The diagnostic counters reported two completed commands, eight total rejections, and one timeout. Native notification queue, reconnect, and real Node-RED four-Subscription recovery tests continued to pass after the ownership change.

## 20,000-point sustained Node-RED pressure run

The 2026-08-06 capacity run deployed the real nodes into Node-RED with 20,000 writable OPC UA variables, three complete Read rounds, four 5,000-item Subscriptions, and five complete Write rounds.

| Metric | Result |
| --- | ---: |
| Browse 20,000 variables | 7,948 ms |
| Read P50 / P95 | 1,236 / 1,559 ms |
| Write P50 / P95 | 1,493 / 1,917 ms |
| Create 20,000 MonitoredItems / 4 Subscriptions | 1,639 ms |
| Native notifications | 120,000 / 120,000 delivered |
| Final value convergence | 20,000 / 20,000 points |
| Notification drops | 0 |
| Maximum notification queue depth | 7,978 / 320,000 capacity |
| Maximum native callback lag | 5.24 ms |
| Owner commands | 367 / 367 completed, 0 rejected, 0 timed out |
| Node-RED peak RSS | 342.9 MB |
| Node-RED sampled CPU | 7,000 ms |
| Complete run | 34.3 s |

The collector observed 100,500 changes after its subscription-status gate, while native diagnostics recorded all 120,000 initial and write notifications. As in the smaller runs, notifications may arrive before the collector initializes its counter; zero native drops and convergence of every point to the final write value are the correctness gates. Phase sampling and an isolated external-writer run were subsequently used to locate and reduce the transient memory peak.

## 20,000-point memory isolation and CSV Write optimization

The same deployed Flow was tested with a separate native client generating the five write rounds. Node-RED still browsed 20,000 variables, rendered the 20,040-node editor tree, read all points, created four 5,000-item Subscriptions, collected notifications, and verified final convergence. Moving only write-payload construction outside Node-RED reduced its peak RSS to 170.27 MB. The phase peak during Subscribe creation was 166.47 MB and the peak during 100,000 external writes plus notification handling was 170.27 MB. All 120,000 native notifications were delivered with zero drops and 20,000/20,000 final convergence. This isolates the collection path from the CSV Write path and shows that subscription setup and notification delivery were not responsible for the earlier 342-362 MB peaks.

Write CSV parsing was then changed from multiple whole-payload arrays and object copies to a single line scan that constructs compact final write descriptors. Two mixed Node-RED runs, each producing CSV and executing all 100,000 writes inside the Flow, recorded stable peaks of 226.73 MB and 226.06 MB. The immediately preceding fresh-process repeat peaked at 362.29 MB, so the repeatable peak reduction was approximately 37.6%. The optimized repeat recorded Write P50/P95 of 1,410/1,769 ms, delivered 120,000/120,000 native notifications with zero drops, and converged 20,000/20,000 final values. These are process-RSS engineering measurements; allocator and garbage-collector behavior still require production baselines on the target Node-RED image.

The 20,000-point outage acceptance stopped and restarted the real OPC UA fixture after the initial four Subscriptions were created. The Subscribe node rebuilt exactly four Subscriptions with 20,000/20,000 MonitoredItems and zero failures. Two subsequent complete write rounds plus the rebuilt initial values delivered 60,000/60,000 native notifications with zero drops and final convergence for all 20,000 points. Recovery-phase RSS peaked at 175.04 MB and the complete run at 184.5 MB. The recovery status explicitly reported `rebuilt=true` and `dataGapPossible=true` because a server-side subscription rebuild cannot guarantee changes that occurred during the outage.

## 0.5.0 knee-point benchmark

Recorded on 2026-08-24 with Node-RED 4.1.10, Node.js 22.22.2, open62541 1.4.16, and package 0.5.0. Every tier used a fresh Node-RED process constrained to 2 vCPU and 2 GB. The server and clients used security mode `None` over container loopback. Service batches contained 500 nodes, each server Subscription contained at most 5,000 MonitoredItems, publishing and sampling intervals were 100 ms, and an independent native client changed every monitored value so the Node-RED Subscribe path could be measured without CSV construction in the Write node.

| Points | Read P50 / P95 | External write P50 / P95 | Subscribe setup | Native notifications | Max callback lag | Node-RED peak RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 195 / 206 ms | 195 / 196 ms | 232 ms | 30,000, 0 dropped | 0.21 ms | 132.4 MB |
| 10,000 | 411 / 467 ms | 392 / 396 ms | 475 ms | 60,000, 0 dropped | 1.00 ms | 153.4 MB |
| 20,000 | 817 / 852 ms | 788 / 792 ms | 915 ms | 120,000, 0 dropped | 2.42 ms | 182.1 MB |
| 30,000 | 1,263 / 1,274 ms | 1,208 / 1,219 ms | 1,523 ms | 180,000, 0 dropped | 2.18 ms | 194.4 MB |
| 40,000 | 1,673 / 1,701 ms | 1,753 / 1,795 ms | 1,889 ms | 240,000, 0 dropped | 2.27 ms | 218.8 MB |
| 60,000 | 2,521 / 2,556 ms | 2,590 / 2,641 ms | 2,860 ms | 360,000, 0 dropped | 5.07 ms | 261.3 MB |
| 100,000 | 4,215 / 4,263 ms | 4,758 / 4,884 ms | 5,174 ms | 600,000, 0 dropped | 1.64 ms | 391.4 MB |
| 150,000 | 6,353 / 6,470 ms | 8,045 / 8,137 ms | 7,582 ms | 600,000, 0 dropped | 27.53 ms | 463.2 MB |
| 175,000 | 7,488 ms | 11,864 ms | 9,290 ms | 525,000, 0 dropped | 1.91 ms | 526.7 MB |
| 200,000 | 8,485 / 8,663 ms | 42,410 / 43,425 ms | 10,968 ms | 800,000, 0 dropped | 1.73 ms | 564.0 MB |

The 5,000 through 100,000 Read results remain close to 23,000-25,000 values per second. A one-second full-poll target therefore crosses its practical boundary between 20,000 and 30,000 points even though larger batches remain correct. Subscription creation stays near 18,000-22,000 MonitoredItems per second through 200,000 points.

The coupled server/client system begins a soft knee around 150,000 monitored points. At that tier callback lag repeatedly reached about 27 ms and the default 100,000-entry NodeId cache started heavy eviction. Increasing the cache to 200,000 removed all evictions and improved Read P50 from 6,524 ms to 6,353 ms, but raised peak RSS from 425 MB to 463 MB and did not remove the callback-lag spike. Cache size is therefore a secondary tuning control, not the main scale limit.

The sharp knee occurred between 175,000 and 200,000 monitored points. Increasing the point set by 14% increased one full write from about 11.9 seconds to 42.4 seconds. Node-RED still delivered all 800,000 native notifications with zero drops at 200,000 points, so the collapse occurred first in the open62541 server's processing of value changes under a very large monitored set, rather than in the Node-RED callback queue. A Siemens WinCC server can reach its own knee much earlier or later depending on licensed limits, Session and Subscription quotas, security, hardware, and project load.

The editor Browse API intentionally caps one tree request at 100,000 total nodes. A namespace containing approximately 100,000 variables plus their Area objects therefore cannot be rendered as one complete selectable tree. Browse a narrower Area/root or import the point list instead of raising this UI protection.

For production, keep a one-second full Read at or below roughly 20,000 points per Connection on equivalent hardware. For Subscribe, 50,000-60,000 monitored points per Connection is a conservative local-loopback engineering envelope with substantial margin below the observed system knee. Do not automatically add Sessions to exceed it: first verify the target server's Session, Subscription, MonitoredItem, publish, and sampling limits. Above 100,000 points, raise `nodeIdCacheSize` only with a corresponding memory budget and test the real server under the expected change rate and security policy.
