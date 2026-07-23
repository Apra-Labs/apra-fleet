# Sprint summary: feature/enhance_parallelism

**Started:** 20260626_011334  
**Goal:** P1/P2  ->  NOT MET  
**Cycles:** estimated 1.5, actual 2  
**Tasks:** 3 completed, 8 open/carried-forward

---

### Cost analysis

#### Sprint cost analysis
Calibration: historical (1 sprint)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     20,400 |     56,496 | +177% |   $0.330 |   $0.891 |
| reviewer   |      4,634 |     17,676 | +281% |   $0.079 |   $0.361 |
| overhead   |      7,150 |    105,718 | +1379% |   $0.121 |   $1.433 |
| TOTAL      |     32,184 |    179,890 | +459% |   $0.530 |   $2.684 |
True-cost estimate (output x 4x): $2.119

Outliers (>200% variance): reviewer, overhead
Calibration failures (>500%): overhead

---

### Suggested calibration adjustments

- `setup` actual 1574% over estimate -> consider bumping `fixed_overhead_tokens.setup` or bucket sizes
- `planner` actual 1513% over estimate -> consider bumping `fixed_overhead_tokens.planner` or bucket sizes
- `reviewer` actual 281% over estimate -> consider bumping `fixed_overhead_tokens.reviewer` or bucket sizes
