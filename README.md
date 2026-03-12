# pg_textsearch: ResourceOwnerEnlarge Bug Reproduction & Root Cause Analysis

<p align="center" width="100%">
  <img height="250" src="https://raw.githubusercontent.com/constructive-io/constructive/refs/heads/main/assets/outline-logo.svg" />
</p>

<p align="center" width="100%">
  <a href="https://github.com/constructive-io/pg_textsearch_repro/actions/workflows/ci.yml">
    <img height="20" src="https://github.com/constructive-io/pg_textsearch_repro/actions/workflows/ci.yml/badge.svg" />
  </a>
</p>

> **Upstream issue:** [timescale/pg_textsearch#247](https://github.com/timescale/pg_textsearch/issues/247)
> **Proposed fix branch:** [`fix/resource-owner-enlarge-guard`](https://github.com/constructive-io/pg_textsearch/tree/fix/resource-owner-enlarge-guard)

---

## Summary

When `pg_textsearch` (v0.6.0) is loaded via `shared_preload_libraries` on **PostgreSQL 17+**, any transaction that:

1. Creates database objects via DDL (e.g., `CREATE TABLE`)
2. Encounters an error (e.g., division by zero, invalid FK reference, any SQL error)
3. Attempts `ROLLBACK`

...will fail with:

```
ERROR: ResourceOwnerEnlarge called after release started
```

This error **permanently corrupts the PostgreSQL connection** (all subsequent queries fail with "current transaction is aborted"). The bug affects **every DDL-bearing transaction that rolls back with an error**, not just transactions involving BM25 indexes.

### Impact

- **Any application** that uses pg_textsearch on PostgreSQL 17+ and performs DDL within transactions that might fail is affected.
- **Testing frameworks** that wrap tests in `BEGIN`/`ROLLBACK` are particularly impacted, since any test failure after DDL will trigger this bug and cascade to all subsequent tests.
- The bug is **not limited to BM25 index operations** -- it triggers on any `CREATE TABLE`, `ALTER TABLE`, or other DDL that creates database objects, because pg_textsearch installs a global `object_access_hook` that fires for all `OAT_DROP` events.

---

## Minimal Reproduction (psql)

Connect to a PostgreSQL 17+ database with `pg_textsearch` loaded:

```sql
-- Step 1: Begin a transaction and create any table
BEGIN;
CREATE TABLE test_repro (id serial PRIMARY KEY);

-- Step 2: Cause any error (puts transaction in aborted state)
SELECT 1/0;
-- ERROR: division by zero

-- Step 3: ROLLBACK triggers the bug
ROLLBACK;
-- ERROR: ResourceOwnerEnlarge called after release started
```

**Expected:** `ROLLBACK` succeeds, cleaning up the aborted transaction.

**Actual:** `ROLLBACK` fails with `ResourceOwnerEnlarge called after release started`. The connection is now permanently broken.

### Conditions Required

| Condition | Required? | Why |
|-----------|-----------|-----|
| pg_textsearch loaded via `shared_preload_libraries` | **Yes** | Installs the `object_access_hook` that triggers during abort |
| PostgreSQL 17+ | **Yes** | PG17 introduced the `ResourceOwnerEnlarge` guard check; PG16 silently allows the same operation |
| DDL that creates objects in the transaction | **Yes** | Object creation means `OAT_DROP` events fire when aborting (dropping the uncommitted objects) |
| An error in the same transaction | **Yes** | Puts the transaction in aborted state, causing `ROLLBACK` to trigger `AbortTransaction` cleanup |
| BM25 index specifically | **No** | Any DDL triggers the bug; BM25 indexes are not required |

### Controls (should always pass)

- **Error without DDL:** `BEGIN; SELECT 1/0; ROLLBACK;` -- succeeds (no objects to drop, so no `OAT_DROP` events)
- **DDL without error:** `BEGIN; CREATE TABLE ...; ROLLBACK;` -- succeeds (clean rollback, no aborted-state cleanup path)
- **DDL in separate transaction:** Commit DDL first, then error+rollback in new transaction -- succeeds (no uncommitted objects in the second transaction)

---

## Root Cause Analysis

### The Execution Flow

When a transaction containing DDL is aborted (due to a prior error + `ROLLBACK`), PostgreSQL needs to undo the DDL. This involves dropping the uncommitted objects, which triggers `OAT_DROP` events. Here is the critical execution chain:

```
ROLLBACK (after error in transaction with DDL)
  |
  v
AbortTransaction()
  |
  +---> CallXactCallbacks(XACT_EVENT_ABORT)
  |       |
  |       +---> tp_xact_callback() [mod.c]
  |               |
  |               +---> tp_cleanup_build_mode_on_abort() [state.c:551]
  |                       |
  |                       +---> tp_registry_get_dsa() [registry.c]
  |                               |
  |                               +---> dsa_attach() / dsa_create()
  |                                       |
  |                                       +---> ResourceOwnerEnlarge() --> ERROR!
  |
  +---> ResourceOwnerRelease(TopTransactionResourceOwner)
  |       sets releasing = true
  |
  +---> (object cleanup / catalog cache invalidation)
          |
          +---> performDeletion() --> RunObjectDropHook()
                  |
                  +---> tp_object_access() [mod.c:319]
                          |
                          +---> tp_registry_is_registered() [registry.c:380]
                                  |
                                  +---> tp_registry_get_dsa() [registry.c]
                                          |
                                          +---> dsa_attach()
                                                  |
                                                  +---> ResourceOwnerEnlarge() --> ERROR!
```

### The Core Problem

pg_textsearch installs two hooks that fire during transaction abort:

1. **`object_access_hook` (`tp_object_access`)** -- fires for every `OAT_DROP` event on relations (defined in [`mod.c:319`](https://github.com/timescale/pg_textsearch/blob/main/src/mod.c#L319))
2. **Transaction abort callback (`tp_xact_callback`)** -- fires on `XACT_EVENT_ABORT` (defined in [`mod.c:385-389`](https://github.com/timescale/pg_textsearch/blob/main/src/mod.c#L385))

Both hooks call functions that lazily initialize the **DSA (Dynamic Shared Area)** via `tp_registry_get_dsa()` ([`registry.c`](https://github.com/timescale/pg_textsearch/blob/main/src/state/registry.c)). When `tapir_dsa == NULL` (the backend hasn't used any BM25 indexes yet), `tp_registry_get_dsa()` calls either `dsa_create()` or `dsa_attach()`, which internally calls:

```c
dsm_attach() --> ResourceOwnerEnlarge(CurrentResourceOwner)
```

On **PostgreSQL 17+**, `ResourceOwnerEnlarge` checks a new `releasing` flag:

```c
// PostgreSQL 17 resowner.c
void ResourceOwnerEnlarge(ResourceOwner owner)
{
    if (owner->releasing)
        elog(ERROR, "ResourceOwnerEnlarge called after release started");
    // ...
}
```

During transaction abort, the `ResourceOwner` sets `releasing = true` before cleaning up resources. If pg_textsearch's hooks try to lazily attach to the DSA at this point, `ResourceOwnerEnlarge` throws the fatal error.

### Why This Is PostgreSQL 17-Specific

PostgreSQL 17 introduced the `ResourceOwnerData.releasing` flag and the guard check in `ResourceOwnerEnlarge` (commit [`b8bff07`](https://github.com/postgres/postgres/commit/b8bff07)). In PostgreSQL 16 and earlier, the same lazy DSA initialization during abort would silently succeed -- the DSM segment would be attached even during resource release. The PG17 guard correctly identifies this as unsafe (the newly attached resource might not be properly cleaned up), and pg_textsearch needs to respect this constraint.

### Why This Is pg_textsearch-Specific

Without pg_textsearch loaded, there is no `object_access_hook` that tries to lazily initialize DSA during transaction cleanup. Standard PostgreSQL extensions that use `object_access_hook` typically do not perform DSA/DSM operations in their hook callbacks. The bug is caused specifically by pg_textsearch's design of lazy DSA initialization in code paths that can execute during unsafe transaction phases.

### Source Code References

| File | Function | Line | Issue |
|------|----------|------|-------|
| `src/mod.c` | `tp_object_access` | [319](https://github.com/timescale/pg_textsearch/blob/main/src/mod.c#L319) | `object_access_hook` calls `tp_registry_is_registered()` for every `OAT_DROP` event |
| `src/mod.c` | `tp_xact_callback` | [385-389](https://github.com/timescale/pg_textsearch/blob/main/src/mod.c#L385) | Transaction abort callback calls `tp_cleanup_build_mode_on_abort()` |
| `src/state/registry.c` | `tp_registry_is_registered` | [380](https://github.com/timescale/pg_textsearch/blob/main/src/state/registry.c#L380) | Calls `tp_registry_get_dsa()` which lazily initializes DSA |
| `src/state/registry.c` | `tp_registry_get_dsa` | [162-237](https://github.com/timescale/pg_textsearch/blob/main/src/state/registry.c#L162) | Calls `dsa_attach()` / `dsa_create()` which call `ResourceOwnerEnlarge` |
| `src/state/registry.c` | `tp_registry_unregister` | [418](https://github.com/timescale/pg_textsearch/blob/main/src/state/registry.c#L418) | Also calls `tp_registry_get_dsa()` -- called during abort cleanup |
| `src/state/registry.c` | `tp_registry_lookup_dsa` | [348](https://github.com/timescale/pg_textsearch/blob/main/src/state/registry.c#L348) | Also calls `tp_registry_get_dsa()` -- called from `tp_cleanup_build_mode_on_abort` |
| `src/state/state.c` | `tp_cleanup_build_mode_on_abort` | [551-613](https://github.com/timescale/pg_textsearch/blob/main/src/state/state.c#L551) | Calls `tp_registry_get_dsa()` during XACT_EVENT_ABORT |
| `src/state/state.c` | `tp_cleanup_index_shared_memory` | [654](https://github.com/timescale/pg_textsearch/blob/main/src/state/state.c#L654) | Calls `tp_registry_get_dsa()` -- called from `object_access_hook` |

### Relationship to Issue #247 / PR #248

[Issue #247](https://github.com/timescale/pg_textsearch/issues/247) ("BM25 index scans inside rolled-back transactions crash PostgreSQL") and its fix in PR #248 addressed a **different manifestation** of the same underlying design problem: pg_textsearch performing resource-acquiring operations during unsafe phases of the transaction lifecycle. PR #248 fixed the specific case of `FlushOneBuffer` with local buffers, but did **not** fix the lazy DSA initialization in the `object_access_hook` and transaction abort callbacks.

[PR #251](https://github.com/timescale/pg_textsearch/pull/251) is security hardening (9 vulnerability classes) -- completely unrelated to this bug.

---

## Proposed Fix

The fix is defensive and minimal: **avoid lazy DSA initialization in functions that can be called during transaction abort**.

The key insight is: if `tapir_dsa == NULL`, this backend has never attached to the shared DSA area, which means it has never interacted with any BM25 indexes. Therefore, no BM25 indexes need cleanup during abort, and we can safely return early without initializing DSA.

### Changes Required

#### 1. `src/state/registry.c` -- `tp_registry_is_registered()`

**Before:**
```c
/* Ensure DSA is attached */
tp_registry_get_dsa();
if (!tapir_dsa)
    return false;
```

**After:**
```c
/*
 * If DSA is not yet attached for this backend, return false instead of
 * lazily initializing. Lazy DSA initialization (via dsa_attach /
 * dsa_create) calls ResourceOwnerEnlarge, which will fail with
 * "ResourceOwnerEnlarge called after release started" if called during
 * transaction abort cleanup.
 *
 * If this backend has never attached to the DSA, it has never
 * interacted with any BM25 indexes, so no cleanup is needed.
 */
if (!tapir_dsa)
    return false;
```

#### 2. `src/state/registry.c` -- `tp_registry_unregister()`

Same pattern: replace `tp_registry_get_dsa()` with a direct `if (!tapir_dsa) return;` guard.

#### 3. `src/state/registry.c` -- `tp_registry_lookup_dsa()`

Same pattern: replace `tp_registry_get_dsa()` with `if (!tapir_dsa) return InvalidDsaPointer;`.

#### 4. `src/state/registry.c` -- New function `tp_registry_get_dsa_if_attached()`

Add a non-lazy accessor that returns the DSA only if already attached:

```c
/*
 * Return the DSA area only if already attached in this backend.
 * Unlike tp_registry_get_dsa(), this will NOT lazily create or attach
 * to the DSA. Safe to call during transaction abort cleanup.
 */
dsa_area *
tp_registry_get_dsa_if_attached(void)
{
    return tapir_dsa;
}
```

#### 5. `src/state/state.c` -- `tp_cleanup_build_mode_on_abort()`

Replace:
```c
global_dsa = tp_registry_get_dsa();
```

With:
```c
global_dsa = tp_registry_get_dsa_if_attached();
```

#### 6. `src/state/state.c` -- `tp_cleanup_index_shared_memory()`

Replace:
```c
dsa = tp_registry_get_dsa();
```

With:
```c
dsa = tp_registry_get_dsa_if_attached();
if (dsa == NULL)
{
    tp_registry_unregister(index_oid);
    return;
}
```

### Reference Implementation

A complete implementation of this fix is available on our fork:
[`constructive-io/pg_textsearch@fix/resource-owner-enlarge-guard`](https://github.com/constructive-io/pg_textsearch/tree/fix/resource-owner-enlarge-guard)

---

## Running the Reproduction Test

### Prerequisites

- Node.js 20+
- pnpm
- Docker
- PostgreSQL client tools (`psql`)
- pgpm (`npm install -g pgpm`)

### Steps

```sh
# Clone and install
git clone https://github.com/constructive-io/pg_textsearch_repro.git
cd pg_textsearch_repro
pnpm install

# Start PostgreSQL 17 with pg_textsearch loaded
pgpm docker start

# Load environment variables
eval "$(pgpm env)"

# Run the reproduction test
cd packages/test-module
pnpm test __tests__/resource-owner-enlarge.test.ts
```

### Test Structure

The test file ([`packages/test-module/__tests__/resource-owner-enlarge.test.ts`](packages/test-module/__tests__/resource-owner-enlarge.test.ts)) contains:

**Bug reproduction tests** (4 tests -- these demonstrate the bug when pg_textsearch is loaded):
| Test | Pattern |
|------|---------|
| `minimal: CREATE TABLE + error + ROLLBACK` | Simplest trigger: any DDL + any error + ROLLBACK |
| `with BM25: CREATE TABLE + BM25 index + error + ROLLBACK` | Adds a BM25 index to show it also affects real pg_textsearch usage |
| `DDL chain: CREATE TABLE + failing ALTER TABLE + ROLLBACK` | Error from a DDL statement itself (FK to nonexistent table) |
| `savepoint: DDL + error + ROLLBACK TO SAVEPOINT` | Matches pgsql-test's `beforeEach`/`afterEach` savepoint pattern |

**Control tests** (3 tests -- these should always pass):
| Test | Pattern |
|------|---------|
| `error without DDL` | No objects created, so no `OAT_DROP` events during abort |
| `DDL without error` | Clean rollback (no aborted-state cleanup path) |
| `DDL committed separately, then error + ROLLBACK` | No uncommitted objects in the erroring transaction |

> **Note:** Each bug reproduction test creates a fresh `pg.Client` connection because the `ResourceOwnerEnlarge` error permanently corrupts the PostgreSQL connection state, causing all subsequent queries to fail with "current transaction is aborted".

---

## Credits

**Built by the [Constructive](https://constructive.io) team -- creators of modular Postgres tooling for secure, composable backends. If you like our work, contribute on [GitHub](https://github.com/constructive-io).**

## Disclaimer

AS DESCRIBED IN THE LICENSES, THE SOFTWARE IS PROVIDED "AS IS", AT YOUR OWN RISK, AND WITHOUT WARRANTIES OF ANY KIND.

No developer or entity involved in creating this software will be liable for any claims or damages whatsoever associated with your use, inability to use, or your interaction with other users of the code, including any direct, indirect, incidental, special, exemplary, punitive or consequential damages, or loss of profits, cryptocurrencies, tokens, or anything else of value.
