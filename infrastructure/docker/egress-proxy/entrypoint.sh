#!/bin/sh
set -e
# Docker's stdout/stderr pipes are root-owned; squid's log writer runs as the
# unprivileged 'proxy' user, so widen the pipes before squid drops privileges
# (required for `access_log stdio:/dev/stdout`, 27 §12).
chmod a+w /dev/stdout /dev/stderr || true
exec squid -NYCd 1 -f /etc/squid/squid.conf
