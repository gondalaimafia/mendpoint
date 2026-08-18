#!/bin/sh
set -eu

# Verification sandboxes require an empty outbound allowlist. This runs as PID 1
# before the unprivileged workload process starts and fails closed if either the
# IPv4 or IPv6 policy cannot be installed.
iptables --wait -F OUTPUT
iptables --wait -A OUTPUT -o lo -j ACCEPT
iptables --wait -P OUTPUT DROP
ip6tables --wait -F OUTPUT
ip6tables --wait -A OUTPUT -o lo -j ACCEPT
ip6tables --wait -P OUTPUT DROP

iptables --wait -C OUTPUT -o lo -j ACCEPT
ip6tables --wait -C OUTPUT -o lo -j ACCEPT
test "$(iptables --wait -S OUTPUT | head -n 1)" = "-P OUTPUT DROP"
test "$(ip6tables --wait -S OUTPUT | head -n 1)" = "-P OUTPUT DROP"

exec /usr/sbin/runuser -u node -- sleep infinity
