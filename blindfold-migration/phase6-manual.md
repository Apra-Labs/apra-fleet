# Phase 6 Manual CLI Log

Branch: md/project-vault
Date: 2026-05-20
Node: 20.20.1

## 4a - secret --set (persist via stdin)

```
export APRA_FLEET_DATA_DIR=/tmp/phase6-smoke-data
echo -n "test-value-123" | node dist/index.js secret --set FOO --persist -y
```

Output:
  Secret stored for FOO.
  Network policy: allow. Use 'apra-fleet secret --update FOO --deny' to restrict.
Exit: 0

Note: env var must be exported before the pipe; inline assignment only applies to
the echo command, not node. Used `export` form to ensure isolation.

## 4b - secret --list

```
APRA_FLEET_DATA_DIR=/tmp/phase6-smoke-data node dist/index.js secret --list
```

Output:
  NAME  SCOPE       POLICY  MEMBERS  EXPIRES
  ----  ----------  ------  -------  -------
  FOO   persistent  allow   *        -
Exit: 0

## 4c - secret --update --deny

```
APRA_FLEET_DATA_DIR=/tmp/phase6-smoke-data node dist/index.js secret --update FOO --deny
```

Output:
  Credential updated: FOO
Exit: 0

## 4d - secret --delete

```
APRA_FLEET_DATA_DIR=/tmp/phase6-smoke-data node dist/index.js secret --delete FOO
```

Output:
  Credential deleted: FOO
Exit: 0

## 4e - cleanup

```
rm -rf /tmp/phase6-smoke-data
```

Exit: 0

## Summary

All steps green. Real registry unchanged (INC-1 isolation: diff 0 lines).
