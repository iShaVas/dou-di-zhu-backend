# dou-di-zhu-server

Authoritative multiplayer poker server for the `frontend/` client.

## Run

```bash
npm install
npm start            # listens on 0.0.0.0:8787
PORT=9000 npm start  # override port
```

## Test

```bash
npm test
```

The test suite covers:

- Hand evaluation (pokersolver) and showdown/side-pot math
- Table state machine (seats, betting rounds, turn tokens, leaves)
- Per-seat projection invariant (no hole-card leaks)
- Full WebSocket integration (create table, two joins, scripted hand)
- E2E smoke (three clients, chip-conservation check)

## Wire protocol

WebSocket, JSON messages.

**Client → server**

| Type           | Body                                                       |
| -------------- | ---------------------------------------------------------- |
| `create_table` | `{ options?: { maxSeats, initialStack, turnTimeoutMs } }`  |
| `join_table`   | `{ tableId, seatIndex, name, sessionToken? }`              |
| `leave_table`  | `{}`                                                       |
| `ready`        | `{}`                                                       |
| `action`       | `{ turnToken, action, amount? }` — fold/check/call/raise/allin |
| `ping`         | `{}`                                                       |

**Server → client**

| Type      | Body                                                      |
| --------- | --------------------------------------------------------- |
| `session` | `{ sessionToken, tableId, seatIndex }`                    |
| `state`   | `{ table, seat, version, schemaVersion }`                 |
| `error`   | `{ code, message }`                                       |
| `pong`    | `{}`                                                      |

Schema version: `7`. Persistence: in-memory only.

## Deploy

Standard Node.js hosting. Put TLS in front (for `wss://`). No outbound
dependencies beyond `ws`.
