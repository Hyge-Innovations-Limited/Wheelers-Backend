#!/bin/sh
# Sets up coturn for Wheelers Live call on a fresh Ubuntu 24.04 machine in
# Google Cloud or AWS. Run ON THE TURN MACHINE, from this folder, as a user with sudo:
#
#   sh setup.sh turn.wheelersng.com you@example.com
#
# Before it: the machine exists with a static address, the firewall rule is in
# place, and the domain's A record points at the address (see README.md).
# Running it again keeps the existing secret, so the gateway's copy stays valid.
#
# On a machine where Caddy already runs (the app server), Caddy keeps 80 and
# 443: coturn takes TLS on 5349 instead, and its certificate is the one Caddy
# gets for the domain (a site block is added for it), handed over each day.
# The gateway then needs TURN_TLS_PORT=5349.
set -eu

DOMAIN="${1:?usage: sh setup.sh <domain> <email for the certificate>}"
EMAIL="${2:?usage: sh setup.sh <domain> <email for the certificate>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
META="http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0"

echo "== packages"
sudo apt-get update -y
sudo apt-get install -y coturn certbot

echo "== addresses"
if curl -s -m 2 -H 'Metadata-Flavor: Google' "$META/ip" >/dev/null 2>&1; then
  PRIVATE_IP="$(curl -s -H 'Metadata-Flavor: Google' "$META/ip")"
  PUBLIC_IP="$(curl -s -H 'Metadata-Flavor: Google' "$META/access-configs/0/external-ip")"
else
  # AWS (IMDSv2). With an Elastic IP associated, public-ipv4 is that address.
  TOKEN="$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
  PRIVATE_IP="$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)"
  PUBLIC_IP="$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)"
fi
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
echo "private $PRIVATE_IP  public $PUBLIC_IP  $DOMAIN -> ${RESOLVED:-nothing}"
if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  echo "The A record for $DOMAIN must point at $PUBLIC_IP first. Stopping." >&2
  exit 1
fi

TLS_PORT=443
if systemctl is-active --quiet caddy; then TLS_PORT=5349; fi

echo "== certificate"
sudo systemctl stop coturn 2>/dev/null || true
sudo mkdir -p /etc/coturn/certs
if [ "$TLS_PORT" = 5349 ]; then
  echo "Caddy is running here: TLS on 5349, with Caddy's certificate"
  if ! sudo grep -q "^$DOMAIN" /etc/caddy/Caddyfile; then
    printf '\n%s {\n\trespond "turn" 200\n}\n' "$DOMAIN" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
    sudo systemctl reload caddy
  fi
  i=0
  until sudo find /var/lib/caddy -name "$DOMAIN.crt" 2>/dev/null | grep -q .; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      echo "Caddy has no certificate for $DOMAIN after 2 minutes. Check: sudo journalctl -u caddy -n 50" >&2
      exit 1
    fi
    sleep 2
  done
  sudo tee /etc/cron.daily/coturn-cert >/dev/null <<HOOK
#!/bin/sh
# Caddy renews the certificate for $DOMAIN; this hands each new one to coturn.
CRT="\$(find /var/lib/caddy -name '$DOMAIN.crt' | head -1)"
[ -n "\$CRT" ] || exit 0
if ! cmp -s "\$CRT" /etc/coturn/certs/fullchain.pem; then
  install -o turnserver -g turnserver -m 600 "\$CRT" /etc/coturn/certs/fullchain.pem
  install -o turnserver -g turnserver -m 600 "\${CRT%.crt}.key" /etc/coturn/certs/privkey.pem
  systemctl try-restart coturn
fi
HOOK
  sudo chmod +x /etc/cron.daily/coturn-cert
  sudo /etc/cron.daily/coturn-cert
else
sudo certbot certonly --standalone -d "$DOMAIN" --agree-tos -m "$EMAIL" --non-interactive --keep-until-expiring
sudo mkdir -p /etc/coturn/certs
sudo tee /etc/letsencrypt/renewal-hooks/deploy/coturn.sh >/dev/null <<HOOK
#!/bin/sh
install -o turnserver -g turnserver -m 600 /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/coturn/certs/fullchain.pem
install -o turnserver -g turnserver -m 600 /etc/letsencrypt/live/$DOMAIN/privkey.pem /etc/coturn/certs/privkey.pem
systemctl try-restart coturn
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
sudo /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
fi

echo "== secret"
if ! sudo test -s /etc/coturn/secret; then
  openssl rand -hex 32 | sudo tee /etc/coturn/secret >/dev/null
  sudo chmod 600 /etc/coturn/secret
  echo "made a new secret: put it in the gateway's .env as TURN_SHARED_SECRET"
else
  echo "kept the existing secret"
fi
SECRET="$(sudo cat /etc/coturn/secret)"

echo "== settings"
sed -e "s/__PRIVATE_IP__/$PRIVATE_IP/g" -e "s/__PUBLIC_IP__/$PUBLIC_IP/g" -e "s/__SECRET__/$SECRET/g" -e "s/__TLS_PORT__/$TLS_PORT/g" \
  -e "s/turn\.wheelersng\.com/$DOMAIN/g" "$HERE/turnserver.conf.template" | sudo tee /etc/turnserver.conf >/dev/null
sudo chmod 640 /etc/turnserver.conf
sudo chown root:turnserver /etc/turnserver.conf

echo "== port 443, and start"
sudo mkdir -p /etc/systemd/system/coturn.service.d
printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\n' | sudo tee /etc/systemd/system/coturn.service.d/override.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager | head -5
sudo ss -tulpn | grep turnserver || { echo "coturn is not listening. Check: sudo journalctl -u coturn -n 50" >&2; exit 1; }
echo "done"
