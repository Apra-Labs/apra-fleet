# Auto-Sprint Workflow Architecture

This diagram illustrates the complex, multi-agent lifecycle of a single sprint. It highlights the outer iterative cycle (Sprint Cycles) and the inner tight feedback loops (Planning Loop, Development Loop).

```mermaid
stateDiagram-v2
    direction TB
    
    %% Sprint Initialization
    [*] --> StartCycle : Initialize Sprint

    state "Sprint Cycle (Max 5)" as SprintCycle {
        direction TB
        
        %% Planning Loop
        state "Planning Phase" as PlanningPhase {
            direction LR
            Planner: Planner Agent\n(Builds DAG / Adds Beads)
            PlanReviewer: Plan Reviewer Agent\n(Approves/Rejects)
            
            Planner --> PlanReviewer: Proposes Plan
            PlanReviewer --> Planner: Changes Needed (Text Feedback)
            PlanReviewer --> Approved: Approved
        }
        
        StartCycle --> PlanningPhase
        
        %% Development Loop
        state "Development Phase" as DevelopmentPhase {
            direction TB
            StreakAssignment: Streak Assignment Agent\n(Divides work into sequential/parallel tracks)
            Doers: Parallel Doer Agents\n(Closes assigned beads & fix feedback)
            Reviewer: Reviewer Agent\n(Verifies work, gives text feedback)
            
            StreakAssignment --> Doers: Dispatch Streaks
            Doers --> Reviewer: Code Review
            Reviewer --> Doers: Reopens beads (Text Feedback)
            Reviewer --> CodeApproved: All closed
        }
        
        PlanningPhase --> DevelopmentPhase
        
        %% Integration Loop (Conditional on Runbooks)
        state "Integration Phase" as IntegPhase {
            direction TB
            Deployer: Deployer Agent\n(Deploys to test env)
            IntegTest: Integration Test Runner\n(Tests features, adds bugs)
            
            Deployer --> IntegTest: (If deploy.md exists)
        }
        
        DevelopmentPhase --> IntegPhase: (If playbooks exist)
    }

    %% Cycle Evaluation
    CheckRemaining: Check Open Beads
    IntegPhase --> CheckRemaining
    
    CheckRemaining --> StartCycle: Open beads exist\n(Cycle count < 5)
    
    %% Sprint Finalization
    FinalReview: Final Reviewer Agent\n(Sprint Pass/Fail Verdict)
    Harvester: Harvester Agent\n(Updates Memory & Retrospective)
    
    CheckRemaining --> FinalReview: All beads closed\nOR Max cycles reached
    FinalReview --> Harvester
    Harvester --> [*]: End Sprint
```
