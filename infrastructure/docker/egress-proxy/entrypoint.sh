#!/bin/sh
set -e
# Docker's stdout/stderr pipes are root-owned; squid's log writer runs as the
# unprivileged 'proxy' user, so widen the pipes before squid drops privileges
# (required for `access_log stdio:/dev/stdout`, 27 §12).
chmod a+w /dev/stdout /dev/stderr || true

# O11: render the ACL subnets from the environment compose already uses, so a
# renamed/re-subnetted workspace network cannot silently drift away from the
# ACL and turn the proxy into a default-deny black hole.
: "${WORKSPACE_SUBNET:=172.30.0.0/16}"
# ACOS's own services (server dispatches web.fetch). Compose's default bridge
# network takes an address from Docker's private pool, so the ACL covers the
# RFC1918 ranges the daemon allocates from; the proxy port is never published
# to the host, so nothing outside the compose networks can reach it anyway.
: "${SERVICE_SUBNETS:=172.16.0.0/12 192.168.0.0/16 10.0.0.0/8}"

sed -e "s|\${WORKSPACE_SUBNET}|${WORKSPACE_SUBNET}|g" \
    -e "s|\${SERVICE_SUBNETS}|${SERVICE_SUBNETS}|g" \
    /etc/squid/squid.conf.template > /etc/squid/squid.conf

squid -k parse -f /etc/squid/squid.conf   # fail fast on a broken render
exec squid -NYCd 1 -f /etc/squid/squid.conf
