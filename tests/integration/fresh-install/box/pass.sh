#!/usr/bin/env bash
# Fresh-install harness: in-box pass script (POSIX dialect: Linux and macOS).
# Runs as a normal user with HOME set: in an ubuntu:24.04 container (docker
# driver, no systemd) or directly on a disposable CI VM (host driver; systemd
# --user on Linux, launchd on macOS). Portable to BSD userland (macOS bash 3.2,
# BSD sed/grep/tar, no sha256sum/setsid). Records one JSON line per
# checklist step to $OUT/results.jsonl and never aborts on a failed step --
# verdicts are applied on the host (lib/verdict.mjs + checklist.json).
#
# Usage: pass.sh <A|B|U|U2>
# Env:   CAND (candidate installer), BASE (baseline installer, U/U2),
#        NODE_TGZ + NODE_SHA (pinned Node tarball, B/U), OUT (results dir)
set -u
PASS="${1:?pass id required}"
OUT="${OUT:-/fi/out}"
LOGS="$OUT/logs"; mkdir -p "$LOGS"
RES="$OUT/results.jsonl"
AF="$HOME/.apra-fleet/bin/apra-fleet"
PORT=7523
BASEURL="http://127.0.0.1:$PORT"
MANUAL_NOTE=""
IS_MAC=""; [ "$(uname -s)" = Darwin ] && IS_MAC=1

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >> "$OUT/box.log"; }
js() { printf '%s' "$1" | LC_ALL=C tr -cd '\11\40-\176' | LC_ALL=C tr '\11' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# rec <id> <cmd> <exit> <keyline> [observed] [na]
rec() {
  local na=""
  [ -n "${6:-}" ] && na=",\"na\":\"$(js "$6")\""
  printf '{"pass":"%s","id":"%s","cmd":"%s","exit":"%s","keyline":"%s","observed":"%s"%s}\n' \
    "$PASS" "$1" "$(js "$2")" "$(js "$3")" "$(js "$4")" "$(js "${5:-}")" "$na" >> "$RES"
  log "$1 exit=$3 key=$4 obs=${5:-} ${6:+NA=$6}"
}
# key <logfile> <pattern>... : first line matching the first pattern that matches; else last non-empty line
key() {
  local f="$1"; shift
  local p m
  for p in "$@"; do
    m=$(grep -E -m1 -- "$p" "$f" 2>/dev/null) && { printf '%s' "$m"; return; }
  done
  grep -v '^[[:space:]]*$' "$f" 2>/dev/null | tail -n1
}
# run <id> <logname> cmd... : sets RC and LOG
run() {
  local id="$1" name="$2"; shift 2
  LOG="$LOGS/$id-$name.log"
  "$@" > "$LOG" 2>&1 < /dev/null
  RC=$?
  printf '\n=== EXIT CODE: %s ===\n' "$RC" >> "$LOG"
}
ver_of() { grep -E -o -m1 'v[0-9]+\.[0-9]+\.[0-9]+_[0-9a-f]+' "$1" 2>/dev/null | head -n1; }
# http <method> <path> [extra curl args...] : sets CODE and BODY (file)
http() {
  local m="$1" p="$2"; shift 2
  BODY="$LOGS/http-$(echo "$m$p" | tr -c 'A-Za-z0-9' '_').body"
  CODE=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 15 -X "$m" "$@" "$BASEURL$p" 2>/dev/null)
  [ "$CODE" = "000" ] && CODE="ERR connection failed"
}
health_ok() { curl -s -o /dev/null --max-time 3 "$BASEURL/health" 2>/dev/null; }
wait_health() { local i=0; while [ "$i" -lt "$1" ]; do health_ok && return 0; sleep 2; i=$((i+2)); done; return 1; }
has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }
# The platform has a service manager the product registers with (launchd is always there on macOS).
has_svc_mgr() { [ -n "$IS_MAC" ] || has_systemd; }
start_by_hand() {
  # No systemd in the container: start the installed server the way a
  # systemd-less user would. setsid detaches it from this script.
  if command -v setsid >/dev/null 2>&1; then setsid "$AF" run > "$HOME/fi-run.log" 2>&1 < /dev/null &
  else nohup "$AF" run > "$HOME/fi-run.log" 2>&1 < /dev/null & fi
  echo $! > "$HOME/fi-run.pid"
  MANUAL_NOTE=" (started by hand: no systemd)"
}
# health_step <id> : wait for /health; start by hand only where the platform has no
# service manager (never on macOS or a systemd host: there the service must start it)
health_step() {
  MANUAL_NOTE=""
  if has_svc_mgr; then wait_health 90
  elif ! wait_health 20; then start_by_hand; wait_health 60; fi
  http GET /health
  rec "$1" "GET /health" "$CODE" "$(head -c 200 "$BODY")$MANUAL_NOTE" "$(ver_of "$BODY")"
}
svc_step() {
  local id="$1" unit="$2"
  if [ -n "$IS_MAC" ]; then
    local label s rc
    case "$unit" in apra-fleet) label=com.apra-fleet.server ;; *) label="com.apra-fleet.${unit#apra-fleet-}" ;; esac
    s=$(launchctl print "gui/$(id -u)/$label" 2>&1); rc=$?
    rec "$id" "launchctl print gui/$(id -u)/$label" "$rc" "$(printf '%s\n' "$s" | grep -E -m1 '^[[:space:]]*state = ' | sed 's/^[[:space:]]*//')"
    return
  fi
  if ! has_systemd; then
    rec "$id" "systemctl --user is-active $unit" "" "" "" "no systemd user manager in this container; install reported: $(key "${INSTALL_LOG:-/dev/null}" 'systemd' 'Service')"
    return
  fi
  local s; s=$(systemctl --user is-active "$unit" 2>&1); rec "$id" "systemctl --user is-active $unit" "$?" "$s"
}
prep_bin() { install -m 0755 "$1" "$2"; }
install_node() {
  local id="$1" dir="$HOME/node"
  local got; got=$(sha256_of "$NODE_TGZ")
  if [ "$got" != "$NODE_SHA" ]; then rec "$id" "verify $NODE_TGZ" 1 "sha256 mismatch: $got"; return; fi
  mkdir -p "$dir" && tar -xzf "$NODE_TGZ" -C "$dir" --strip-components=1
  export PATH="$dir/bin:$PATH"
  local v; v=$(node -v 2>&1); rec "$id" "tar -xzf $(basename "$NODE_TGZ") -> ~/node; node -v" "$?" "node $v sha256 ok" "$v"
}
members_have_dummy() { grep -q 'fi-dummy' "$HOME/.apra-fleet/data/registry.json" 2>/dev/null; }
secret_has_dummy() { "$AF" secret --list 2>&1 | grep -q 'fi_dummy_secret'; }
fleetkey_hash() { if [ -f "$HOME/.apra-fleet/fleet.key" ]; then sha256_of "$HOME/.apra-fleet/fleet.key" | cut -c1-16; else echo absent; fi; }
seed() {
  mkdir -p "$HOME/fi-work"
  run "$1" register-member "$AF" register-member --name fi-dummy --type local --path "$HOME/fi-work" --llm none
  SEED_MEMBER_RC=$RC; SEED_MEMBER_LOG=$LOG
  # Value on stdin with -y (non-interactive); the value is never recorded.
  LOG="$LOGS/$1-secret-set.log"
  printf 'fi-dummy-value-not-a-real-credential' | "$AF" secret --set fi_dummy_secret --persist -y > "$LOG" 2>&1
  SEED_SECRET_RC=$?
}
# Replays what 'apra-fleet update' spawns: install --force --llm <p> --skill <s> --workflows <w>
update_argv() {
  local cfg="$HOME/.apra-fleet/data/install-config.json" flat llm skill wf
  flat=$(tr -d '\n' < "$cfg" 2>/dev/null)
  llm=$(printf '%s' "$flat" | sed -n 's/.*"providers": *{ *"\([a-z]*\)".*/\1/p'); llm=${llm:-claude}
  skill=$(printf '%s' "$flat" | sed -n 's/.*"skill": *"\([a-z]*\)".*/\1/p'); skill=${skill:-all}
  wf=$(printf '%s' "$flat" | sed -n 's/.*"workflowsMode": *"\([a-z]*\)".*/\1/p'); wf=${wf:-all}
  UPDATE_ARGS=(install --force --llm "$llm" --skill "$skill" --workflows "$wf")
}

log "pass $PASS start; whoami=$(whoami) HOME=$HOME"
: > "$RES"
cd "$HOME" || exit 1

case "$PASS" in
A)
  prep_bin "$CAND" "$HOME/cand"
  run A01 version "$HOME/cand" --version; rec A01 "cand --version" "$RC" "$(head -n1 "$LOG")" "$(ver_of "$LOG")"
  command -v node > /dev/null 2>&1; rec A02 "command -v node" "$?" "$(command -v node || echo 'node not on PATH')"
  run A03 install-default "$HOME/cand" install; rec A03 "cand install" "$RC" "$(key "$LOG" 'fleet-se requires' '^Error')"
  if [ -e "$HOME/.apra-fleet" ]; then rec A04 "test ! -e ~/.apra-fleet" 1 "present: $(ls -A "$HOME/.apra-fleet" | tr '\n' ' ')"; else rec A04 "test ! -e ~/.apra-fleet" 0 "~/.apra-fleet absent"; fi
  run A05 install-none "$HOME/cand" install --workflows none; INSTALL_LOG=$LOG
  rec A05 "cand install --workflows none" "$RC" "$(key "$LOG" 'installed successfully' 'systemd' '^Error')"
  svc_step A06 apra-fleet
  health_step A07
  http GET /ui; rec A08 "GET /ui" "$CODE" "$(grep -o -m1 'id="root"' "$BODY" || head -c 120 "$BODY")"
  http GET /api/fleet/members; rec A09 "GET /api/fleet/members (no credential)" "$CODE" "$(head -c 160 "$BODY")"
  run A10 status "$AF" status; rec A10 "apra-fleet status" "$RC" "$(key "$LOG" 'State:')"
  ;;
B)
  prep_bin "$CAND" "$HOME/cand"
  run B01 version "$HOME/cand" --version; rec B01 "cand --version" "$RC" "$(head -n1 "$LOG")" "$(ver_of "$LOG")"
  install_node B02
  v=$(npm -v 2>&1); rec B03 "npm -v" "$?" "npm $v"
  run B04 install "$HOME/cand" install; INSTALL_LOG=$LOG
  rec B04 "cand install" "$RC" "$(key "$LOG" 'installed successfully' 'systemd' '^Error')"
  run B05 bd bd version; rec B05 "bd version" "$RC" "$(head -n1 "$LOG")"
  svc_step B06 apra-fleet
  if grep -q 'Supervisor:' "$INSTALL_LOG"; then svc_step B07 apra-fleet-supervisor
  else rec B07 "install summary: Supervisor line" "" "" "" "this build's installer reports no supervisor service"; fi
  health_step B08
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"fresh-install-harness","version":"1"}}}'
  http POST /mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$INIT"
  rec B09 "POST /mcp initialize" "$CODE" "$(grep -o -m1 '"serverInfo":{[^}]*}' "$BODY" || head -c 160 "$BODY")"
  http POST /mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'Authorization: Bearer not-a-valid-token' -d "$INIT"
  rec B10 "POST /mcp with invalid bearer" "$CODE" "$(head -c 160 "$BODY")"
  http POST /shutdown; rec B11 "POST /shutdown (no bearer)" "$CODE" "$(head -c 160 "$BODY")"
  http GET /api/fleet/members; rec B12 "GET /api/fleet/members (no credential)" "$CODE" "$(head -c 160 "$BODY")"
  http GET /ui; rec B13 "GET /ui" "$CODE" "$(grep -o -m1 'id="root"' "$BODY" || head -c 120 "$BODY")"
  run B14 status "$AF" status; rec B14 "apra-fleet status" "$RC" "$(key "$LOG" 'State:')"
  ;;
U)
  install_node U01
  prep_bin "$BASE" "$HOME/base"; prep_bin "$CAND" "$HOME/cand"
  run U02 base-version "$HOME/base" --version; rec U02 "base --version" "$RC" "$(head -n1 "$LOG")" "$(ver_of "$LOG")"
  run U03 base-install "$HOME/base" install; INSTALL_LOG=$LOG
  rec U03 "base install" "$RC" "$(key "$LOG" 'installed successfully' 'systemd' '^Error')"
  health_step U04
  seed U05
  rec U05 "apra-fleet register-member --name fi-dummy --type local --llm none" "$SEED_MEMBER_RC" "$(key "$SEED_MEMBER_LOG" 'fi-dummy' '^Error')"
  rec U06 "apra-fleet secret --set fi_dummy_secret --persist -y (value on stdin)" "$SEED_SECRET_RC" "$(key "$LOG" 'fi_dummy_secret' 'stored|saved|Error')"
  KEY_BEFORE=$(fleetkey_hash)
  members_have_dummy; m=$?; secret_has_dummy; s=$?
  rec U07 "registry.json has fi-dummy; secret --list has fi_dummy_secret" "$((m + s))" "member=$([ $m = 0 ] && echo yes || echo no) secret=$([ $s = 0 ] && echo yes || echo no) fleet.key=$KEY_BEFORE"
  run U08 cand-version "$HOME/cand" --version; rec U08 "cand --version" "$RC" "$(head -n1 "$LOG")" "$(ver_of "$LOG")"
  run U09 upgrade "$HOME/cand" install --force; INSTALL_LOG=$LOG
  rec U09 "cand install --force" "$RC" "$(key "$LOG" 'installed successfully' 'NOT running' 'systemd' '^Error')"
  health_step U10
  run U11 installed-version "$AF" --version; rec U11 "~/.apra-fleet/bin/apra-fleet --version" "$RC" "$(head -n1 "$LOG")" "$(ver_of "$LOG")"
  members_have_dummy; rec U12 "grep fi-dummy registry.json" "$?" "$(grep -o -m1 'fi-dummy' "$HOME/.apra-fleet/data/registry.json" 2>/dev/null || echo 'fi-dummy missing')"
  secret_has_dummy; rec U13 "apra-fleet secret --list | grep fi_dummy_secret" "$?" "$("$AF" secret --list 2>&1 | grep -m1 fi_dummy_secret || echo 'fi_dummy_secret missing')"
  KEY_AFTER=$(fleetkey_hash)
  if [ "$KEY_BEFORE" = "$KEY_AFTER" ] || [ "$KEY_BEFORE" = absent ]; then kr=0; else kr=1; fi
  rec U14 "sha256 ~/.apra-fleet/fleet.key before/after" "$kr" "before=$KEY_BEFORE after=$KEY_AFTER"
  svc_step U15 apra-fleet
  run U16 status "$AF" status; rec U16 "apra-fleet status" "$RC" "$(key "$LOG" 'State:')"
  run U17 update-check "$AF" update --check; rec U17 "apra-fleet update --check" "$RC" "$(key "$LOG" 'up to date' 'Update' 'Error')"
  ;;
U2)
  # Since v0.4.3 a no-Node user holds a core-only install (--workflows none).
  prep_bin "$BASE" "$HOME/base"; prep_bin "$CAND" "$HOME/cand"
  run V01 base-version "$HOME/base" --version; rec V01 "base --version" "$RC" "$(head -n1 "$LOG")" "$(ver_of "$LOG")"
  run V02 base-install "$HOME/base" install --workflows none; INSTALL_LOG=$LOG
  rec V02 "base install --workflows none (no node)" "$RC" "$(key "$LOG" 'installed successfully' 'systemd' '^Error')"
  health_step V03
  seed V04
  members_have_dummy; m=$?; secret_has_dummy; s=$?
  rec V04 "register-member fi-dummy + secret --set fi_dummy_secret" "$((SEED_MEMBER_RC + SEED_SECRET_RC + m + s))" "member=$([ $m = 0 ] && echo yes || echo no) secret=$([ $s = 0 ] && echo yes || echo no)"
  run V05 update "$AF" update; rec V05 "apra-fleet update (baseline)" "$RC" "$(key "$LOG" 'up to date' 'Updating' 'Error')"
  sleep 5
  run V06 install-force-nonode "$HOME/cand" install --force
  rec V06 "cand install --force (no node)" "$RC" "$(key "$LOG" 'fleet-se requires' '^Error')"
  MANUAL_NOTE=""; http GET /health; rec V07 "GET /health" "$CODE" "$(head -c 200 "$BODY")" "$(ver_of "$BODY")"
  update_argv
  run V08 update-argv-nonode "$HOME/cand" "${UPDATE_ARGS[@]}"; INSTALL_LOG=$LOG
  rec V08 "cand ${UPDATE_ARGS[*]} (no node)" "$RC" "$(key "$LOG" 'installed successfully' 'NOT running' 'systemd' '^Error')" "--workflows ${UPDATE_ARGS[7]}"
  health_step V09
  members_have_dummy; m=$?; secret_has_dummy; s=$?
  rec V10 "registry.json fi-dummy + secret --list fi_dummy_secret" "$((m + s))" "member=$([ $m = 0 ] && echo yes || echo no) secret=$([ $s = 0 ] && echo yes || echo no)"
  svc_step V11 apra-fleet
  run V12 status "$AF" status; rec V12 "apra-fleet status" "$RC" "$(key "$LOG" 'State:')"
  ;;
*) log "unknown pass $PASS"; exit 2 ;;
esac

# Collect product logs for the operator.
cp "$HOME"/.apra-fleet/data/*.log "$LOGS/" 2>/dev/null
cp "$HOME/fi-run.log" "$LOGS/manual-run.log" 2>/dev/null
log "pass $PASS done"
date -u +%FT%TZ > "$OUT/done.txt"
exit 0
