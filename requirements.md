# Requirements: Improve token consumption

## Problem Statement

We are burning too many tokens because we are using opus every where. we need to imrove things by following some approaches:
MCP change:
1. execute_prompt should always default to middle toer model when nothing is specified: e.g. sonnet for claude and likewise select other defaults
2. It is not clear which is the best model for orchestrator, it looks like sonnet+well written skill is a great combination.
2a. we should improve fleet installer to change users default model to be "standard" and not "premium"
2b. we should revise skill and documentation where we have claimed that opus/prem shall be used for orchstration. instead we shall say sonnet/standard 
3. each execute_prompt shall bring back token usage and accumulate it into progress.json phase wise, user shall know which phase took what effort.
3a. enhancement for flee-mcp : provide token counts (refer to apra-focus main codebase for correct ways to know token usage)
3b. enhancement the skill to use execute_command to update the tokens inside progress.json phase vise. so for each phase there is a token count to know what was consumed by doer and like wise another one which is for reviewer. remember reviews can be multiple cycles so both should accumulate. 
4a: planning prompt shall be improved so that planner can decide which phase needs what type of model (cheap, standard, premium) this means that every tim 
4b: it means initial progress.json should always be available at the PM to refer which dispatching prompts for doers and reviewers (reviewers always use premium models)

