#!/usr/bin/env bash
# fleet-ec2.sh — Auto start/stop EC2-backed fleet members
# Usage:
#   fleet-ec2.sh start <conf>         — Start instance, wait for SSH, update fleet member IP
#   fleet-ec2.sh stop <conf>          — Stop instance immediately
#   fleet-ec2.sh status <conf>        — Show instance state and IP
#   fleet-ec2.sh ensure <conf>        — Start only if stopped (idempotent, used before dispatch)
#   fleet-ec2.sh watchdog <conf>      — Background: stop instance after IDLE_TIMEOUT_MIN of no SSH sessions
#   fleet-ec2.sh stop-watchdog <conf> — Kill running watchdog

set -euo pipefail

CONF_FILE="${2:-}"
if [[ -z "$CONF_FILE" || ! -f "$CONF_FILE" ]]; then
    echo "Usage: $0 <command> <conf-file>"
    exit 1
fi

# shellcheck source=/dev/null
source "$CONF_FILE"

PIDFILE="/tmp/fleet-ec2-watchdog-${INSTANCE_ID}.pid"
ACTIVITY_FILE="/tmp/fleet-ec2-activity-${INSTANCE_ID}"

get_state() {
    aws ec2 describe-instances --profile "$AWS_PROFILE" \
        --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].State.Name' \
        --output text 2>/dev/null
}

get_public_ip() {
    aws ec2 describe-instances --profile "$AWS_PROFILE" \
        --instance-ids "$INSTANCE_ID" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' \
        --output text 2>/dev/null
}

wait_for_running() {
    echo "Waiting for instance to enter running state..."
    aws ec2 wait instance-running --profile "$AWS_PROFILE" --instance-ids "$INSTANCE_ID"
}

wait_for_ssh() {
    local ip="$1"
    local max_attempts=30
    local attempt=0
    echo "Waiting for SSH on $ip..."
    while (( attempt < max_attempts )); do
        if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes \
            "${SSH_USER}@${ip}" "true" 2>/dev/null; then
            echo "SSH ready."
            return 0
        fi
        (( attempt++ ))
        sleep 2
    done
    echo "ERROR: SSH not ready after $max_attempts attempts"
    return 1
}

update_fleet_member_ip() {
    local ip="$1"
    # Use the apra-fleet CLI to update — calling the MCP tool directly isn't possible from bash,
    # so we update the registry JSON directly
    local registry="$HOME/.apra-fleet/data/registry.json"
    if [[ -f "$registry" ]]; then
        local tmp
        tmp=$(mktemp)
        jq --arg mid "$MEMBER_ID" --arg host "$ip" \
            '(.members[] | select(.id == $mid)).host = $host' \
            "$registry" > "$tmp" && mv "$tmp" "$registry"
        echo "Fleet member host updated to $ip"
    else
        echo "WARNING: Registry not found at $registry — update fleet member host manually"
    fi
}

touch_activity() {
    touch "$ACTIVITY_FILE"
}

cmd_start() {
    local state
    state=$(get_state)
    if [[ "$state" == "running" ]]; then
        local ip
        ip=$(get_public_ip)
        echo "Already running at $ip"
        touch_activity
        return 0
    fi

    if [[ "$state" == "stopping" ]]; then
        echo "Instance is stopping, waiting for it to fully stop..."
        aws ec2 wait instance-stopped --profile "$AWS_PROFILE" --instance-ids "$INSTANCE_ID"
    fi

    echo "Starting instance $INSTANCE_ID..."
    aws ec2 start-instances --profile "$AWS_PROFILE" --instance-ids "$INSTANCE_ID" --output text > /dev/null

    wait_for_running

    local ip
    ip=$(get_public_ip)
    if [[ -z "$ip" || "$ip" == "None" ]]; then
        echo "ERROR: No public IP assigned"
        return 1
    fi

    wait_for_ssh "$ip"
    update_fleet_member_ip "$ip"
    touch_activity

    echo "Instance ready at $ip (member: $MEMBER_ID)"
}

cmd_stop() {
    # Kill watchdog if running
    cmd_stop_watchdog 2>/dev/null || true

    local state
    state=$(get_state)
    if [[ "$state" == "stopped" ]]; then
        echo "Already stopped."
        return 0
    fi

    echo "Stopping instance $INSTANCE_ID..."
    aws ec2 stop-instances --profile "$AWS_PROFILE" --instance-ids "$INSTANCE_ID" --output text > /dev/null
    echo "Stop initiated."
}

cmd_status() {
    local state ip
    state=$(get_state)
    ip=$(get_public_ip)
    echo "Instance: $INSTANCE_ID"
    echo "State:    $state"
    echo "IP:       $ip"

    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Watchdog: running (PID $(cat "$PIDFILE"))"
    else
        echo "Watchdog: not running"
    fi

    if [[ -f "$ACTIVITY_FILE" ]]; then
        local last_activity
        last_activity=$(stat -c %Y "$ACTIVITY_FILE" 2>/dev/null || stat -f %m "$ACTIVITY_FILE" 2>/dev/null)
        local now
        now=$(date +%s)
        local idle_sec=$(( now - last_activity ))
        echo "Idle:     ${idle_sec}s since last activity"
    fi
}

cmd_ensure() {
    local state
    state=$(get_state)
    if [[ "$state" == "running" ]]; then
        local ip
        ip=$(get_public_ip)
        # Verify SSH is reachable, update IP if needed
        if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes \
            "${SSH_USER}@${ip}" "true" 2>/dev/null; then
            update_fleet_member_ip "$ip"
            touch_activity
            echo "ready|$ip"
            return 0
        fi
    fi
    cmd_start
    local ip
    ip=$(get_public_ip)
    echo "ready|$ip"
}

cmd_watchdog() {
    # Kill existing watchdog if any
    cmd_stop_watchdog 2>/dev/null || true

    touch_activity

    echo "Starting idle watchdog (timeout: ${IDLE_TIMEOUT_MIN}m)..."
    (
        echo $$ > "$PIDFILE"
        local timeout_sec=$(( IDLE_TIMEOUT_MIN * 60 ))

        while true; do
            sleep 60

            local state
            state=$(get_state)
            if [[ "$state" != "running" ]]; then
                echo "Instance no longer running. Watchdog exiting."
                rm -f "$PIDFILE"
                exit 0
            fi

            if [[ ! -f "$ACTIVITY_FILE" ]]; then
                touch_activity
                continue
            fi

            local last_activity now idle_sec
            last_activity=$(stat -c %Y "$ACTIVITY_FILE" 2>/dev/null || stat -f %m "$ACTIVITY_FILE" 2>/dev/null)
            now=$(date +%s)
            idle_sec=$(( now - last_activity ))

            if (( idle_sec >= timeout_sec )); then
                echo "Idle for ${idle_sec}s (threshold: ${timeout_sec}s). Stopping instance."
                aws ec2 stop-instances --profile "$AWS_PROFILE" --instance-ids "$INSTANCE_ID" --output text > /dev/null
                rm -f "$PIDFILE"
                exit 0
            fi
        done
    ) &
    disown
    echo "Watchdog started (PID $!)"
}

cmd_stop_watchdog() {
    if [[ -f "$PIDFILE" ]]; then
        local pid
        pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
            echo "Watchdog stopped (PID $pid)"
        fi
        rm -f "$PIDFILE"
    else
        echo "No watchdog running."
    fi
}

case "${1:-}" in
    start)         cmd_start ;;
    stop)          cmd_stop ;;
    status)        cmd_status ;;
    ensure)        cmd_ensure ;;
    watchdog)      cmd_watchdog ;;
    stop-watchdog) cmd_stop_watchdog ;;
    *)
        echo "Usage: $0 {start|stop|status|ensure|watchdog|stop-watchdog} <conf-file>"
        exit 1
        ;;
esac
