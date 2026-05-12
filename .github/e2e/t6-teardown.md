# T6: Teardown

You are running the teardown phase of an apra-fleet E2E test suite.

Remove only the members registered during this test run: **doer** and **reviewer**.
Do not remove any other members — they belong to other projects.

1. For each name in `["doer", "reviewer"]`: call `remove_member` if that member exists (ignore "not found" errors).
2. Call `fleet_status` to confirm neither "doer" nor "reviewer" remains.

If all members were removed (or none were registered to begin with), print exactly:
T6: PASS

If any `remove_member` call failed and members still remain, print exactly:
T6: FAIL — <brief reason>
