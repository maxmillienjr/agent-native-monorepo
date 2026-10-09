# 0016 · LangGraph rather than ADK, with A2A as the integration seam

**Status:** accepted
**Date:** 2026-10-08

## Context

[ADR 0001](0001-langgraph-over-a-durable-execution-engine.md) chose LangGraph's checkpointer
over a durable execution engine. Its candidates were Temporal, Restate and DBOS. It did not
compare agent frameworks, so "why LangGraph and not Google's Agent Development Kit" had no
written answer, and that is the first question a reader from an ADK or Gemini Enterprise
estate asks.

The old answer, that ADK is agent-centric and LangGraph graph-centric, stopped being true at
ADK 2.0: ADK for TypeScript and for Python now have graph workflows with routes and per-node
retry. And since P5-A the service is an A2A server, so an agent on another framework can call
it without a port.

P5-B checked the comparison concept by concept against ADK for TypeScript 2.2.1, with an
out-of-tree trial on the stub axis. The evidence is in the
[portability appendix](../appendix/adk-portability.md). What decides this record:

- **The graph maps.** The seven compiled nodes ran as an ADK `Workflow` with the same node
  sequence and final state as the `StateGraph` (T1).
- **Resuming a failed run does not, in TypeScript.** With `reflect` failing and the session
  in Postgres, the next turn re-ran every node, `distill` included; LangGraph resumes the
  thread and runs `distill` once (T3).
- **Evaluation has no TypeScript counterpart**, and Python's evaluator averages runs against
  a threshold rather than reporting `pass^k`.
- **An ADK agent already calls this one.** An ADK for TypeScript `RemoteA2AAgent` completed a
  task against the A2A server with a bearer token, over v0.3, and was refused without it (T5).

## Decision

**The agent stays on LangGraph, and the integration seam with an ADK estate is A2A.** No ADK
runtime is added to the tree, in whole or as a spike, and an ADK agent that needs this one
calls it as a remote agent.

This record does not revisit ADR 0001; it extends it to a candidate 0001 did not consider.
0001's two revisit conditions, a run spanning minutes with external callbacks and fan-out
across agents with independent failure domains, do not hold at HEAD, and the appendix gives
the evidence for each.

The reason is cost, not capability. A port would buy interoperability that A2A already
provides, and pay with the failure-resume behaviour P3-B's replay and the `distill`/`reflect`
split rely on, with the evaluation harness, and with the cassette runner's ability to tell an
aborted trial from a failed one by its error class.

## Alternatives rejected

- **Port to ADK for TypeScript.** Rejected for the cost above. T1 says it would not be
  blocked by topology.
- **A committed spike, an ADK agent beside the LangGraph one.** It would be a second agent
  runtime that `docs/STATUS.md` and a CI job would have to keep true, and it would read as a
  hedge on ADR 0001. At ADK 2.1.0 it would also have failed the dependency audit on
  `adm-zip`; 2.2.0 fixed that, so that reason is gone and the other two are enough.
- **Wrap the graph as an ADK agent in-process.** It would put two runtimes at the same layer,
  which is the incoherence ADR 0001 names for a workflow engine driving LangGraph's nodes.

## Consequences

**What it buys.** One runtime, one checkpoint model, one evaluation harness. An ADK estate
integrates today, and each of its calls is a run like any other: one run record, one set of
checkpoints, and a ledger entry when the ledger is configured.

**What it costs.** Deployment is this repository's Docker Compose, not Agent Runtime, which
deploys an ADK agent. An ADK estate that wants the agent managed by Google cannot have it
without a port. Native function calling, Memory Bank and ADK's own evaluation are not
available here.

**Revisit when** ADR 0001's conditions become true; when ADK for TypeScript resumes a failed
invocation and fast-forwards its completed nodes; when it reports `pass^k` or something it can
be computed from; when Agent Runtime documents a TypeScript deployment path and the service
must run there; or when a requirement appears for a Google-managed memory. The appendix
states each as something to observe, and says which trial step to re-run.
