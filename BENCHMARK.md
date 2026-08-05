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

The P1 optimization reads the four standard server limits in one request and adds a bounded per-connection native parsed-NodeId cache. The 5,000-point standalone test recorded 5,011 cache entries, 65,001 hits, 5,011 misses, zero bypasses, and approximately 92.8% hit rate. Browse improved from 2,143 ms to 1,991 ms in the recorded local run; Read P50 remained 301 ms and Write P50 remained within local-run variance at 376 ms.

The optimized Node-RED Flow results were:

| Scenario | Result | Cache | Node-RED CPU | Peak RSS |
| --- | --- | --- | ---: | ---: |
| 5,000 points, 5 reads, 20 writes | 105,000/105,000 notifications, 0 dropped, final 5,000/5,000 | 5,011 entries, 155,001 hits, 0 evictions | 1,990 ms | 139.1 MB |
| 10,000 points, 5 reads, 5 writes | 60,000/60,000 notifications, 0 dropped, final 10,000/10,000 | 10,021 entries, 160,001 hits, 0 evictions | 2,120 ms | 155.3 MB warm process |

Against the immediately preceding P0 runs, 5,000-point Node-RED CPU changed from 2,050 ms to 1,990 ms and peak RSS from 143.1 MB to 139.1 MB. The 10,000-point CPU changed from 2,570 ms to 2,120 ms. The 10,000-point P1 run followed the sustained 5,000-point run in the same Node-RED process, so its 155.3 MB peak is a warmed-process regression value and should not be compared directly with the fresh-process memory baseline.

The native integration fixture also advertises all four OperationLimits as 7 and verifies that the client reads those exact values. Its cache capacity is intentionally reduced to 32; the test remains bounded at 32 entries and reports 118 FIFO evictions while Browse, Read, Write, Subscribe, and cleanup all pass.
