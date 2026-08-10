# acos/egress-proxy — the only route out of the internal acos-workspaces
# network (S8). Squid with a default-deny allowlist (27 §12).
FROM ubuntu/squid:latest
COPY squid.conf /etc/squid/squid.conf
COPY entrypoint.sh /usr/local/bin/acos-entrypoint.sh
RUN chmod +x /usr/local/bin/acos-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/acos-entrypoint.sh"]
