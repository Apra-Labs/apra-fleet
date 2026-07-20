# Workflow Terminology Standardization Proposal

Design note: this proposes a renaming (`phase()` -> Scope/Stage, `sequential()` -> Sequence,
"action" -> "Activity") that is not part of the current implementation. The engine's actual
API today uses `phase()`, `sequential()`, `pipeline()`, `parallel()`, `agent()`, `command()`,
and `transform()` exactly as described in `docs/apra-fleet-workflow-architecture.md` and
`docs/workflow-guide.md` -- none of the renames below have been adopted. Kept here as
forward-looking terminology thinking, not as a description of current behavior.

## Background
Currently, our workflow engine uses varied terminology: `workflow.phase()`, `sequential()`, `parallel()`, `agent()`, `command()`, and `transform()`. A user raised the question: *"What is the unit of work within a phase? Is it an activity, a step, or a job?"*

To establish a consistent vocabulary, we reviewed standard process execution frameworks (BPEL, BPMN, Temporal, Airflow, and AWS Step Functions). This document proposes a standardized ontology aligned with industry standards, specifically focusing on BPEL and modern code-first orchestrators like Temporal.

## Terminology Analysis Across Frameworks

| Concept | BPEL | BPMN | Temporal | AWS Step Functions | Airflow |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Top-Level** | Process | Process / Workflow | Workflow | State Machine | DAG |
| **Logical Grouping** | Scope | Sub-process | Child Workflow | Map / Parallel | TaskGroup |
| **Unit of Work** | **Activity** | Task / Activity | **Activity** | Task (State) | Task |
| **Control Flow** | Sequence / Flow | Sequence Flow / Gateway | Code-driven | Sequence / Parallel | Dependencies |

## Proposed Ontology

We recommend standardizing on the following terminology:

### 1. Top Level: **Workflow** (Retain)
- **Current:** `Workflow`
- **Recommendation:** Keep **Workflow**. While BPEL uses "Process," "Workflow" is the predominant term in modern orchestration (Temporal, GitHub Actions, Argo) and clearly conveys stateful execution.

### 2. Logical Grouping: **Scope** or **Stage** (Replace `Phase`)
- **Current:** `workflow.phase()`
- **Recommendation:** Transition to **Scope** (if aligning strictly with BPEL, where a Scope defines variable boundaries and transaction management) or **Stage** (if grouping is primarily for chronological execution tracking). "Phase" is less standard in process frameworks.

### 3. Unit of Work: **Activity** (Replace `Action` / Ad-hoc terms)
- **Current:** `action`, `agent()`, `command()`, `transform()`
- **Recommendation:** Adopt **Activity** as the definitive unit of work. 
  - **Rationale:** In both BPEL and Temporal, an "Activity" represents a discrete unit of business logic or an external call. This perfectly answers the user's question.
  - **API/UI Impact:** We highly recommend renaming UI elements and API parameters from `action` (or `step`) to `activity`. Specific execution methods like `agent()`, `command()`, and `transform()` should be conceptually treated and documented as concrete subtypes of an Activity (e.g., `AgentActivity`, `CommandActivity`).

### 4. Control Flow: **Sequence** and **Parallel**
- **Current:** `sequential()` and `parallel()`
- **Recommendation:** 
  - Rename `sequential()` to **Sequence**. BPEL uses `<sequence>` to dictate strictly ordered execution. `Sequential` implies continuous data flow, which may misrepresent execution flow.
  - Retain **Parallel**. Although BPEL uses `<flow>` for concurrency, "Parallel" is universally understood and matches AWS Step Functions.

## Summary of Recommendations

| Category | Current Term | Proposed Standard | Precedent |
| :--- | :--- | :--- | :--- |
| Top level | `Workflow` | **Workflow** | Temporal, modern orchestrators |
| Logical grouping | `Phase` | **Scope** (or **Stage**) | BPEL (`Scope`), CI/CD (`Stage`) |
| Unit of work | `Action` | **Activity** | BPEL, Temporal |
| Sequential flow | `sequential()` | **Sequence** | BPEL (`<sequence>`) |
| Concurrent flow | `parallel()` | **Parallel** | Step Functions |
| Implementations | `agent()`, `command()` | **Activity Subtypes** | BPEL Basic Activities (`<invoke>`, `<assign>`) |
