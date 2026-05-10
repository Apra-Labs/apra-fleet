# T6: Teardown

You are running the teardown phase of an apra-fleet E2E test suite.

Remove all registered fleet members so the environment is clean for the next run.

1. Call `fleet_status` to list all registered members.
2. For each member found, call `remove_member` to remove it.
3. Call `fleet_status` again to confirm no members remain.

If all members were removed (or none were registered to begin with), print exactly:
`T6: PASS`

If any `remove_member` call failed and members still remain, print exactly:
`T6: FAIL — <brief reason>`
