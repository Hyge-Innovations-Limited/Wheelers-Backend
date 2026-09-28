#!/bin/sh
# Sets up coturn for Wheelers Live call on a fresh Ubuntu 24.04 machine in
# Google Cloud. Run ON THE TURN MACHINE, from this folder, as a user with sudo:
#
#   sh setup.sh turn.wheelersng.com you@example.com
#
# Before it: the machine exists with a static address, the firewall rule is in
# place, and the domain's A record points at the address (see README.md).
# Running it again keeps the existing secret, so the gateway's copy stays valid.
set -eu

DOMAIN="${1:?usage: sh setup.sh <domain> <email for the certificate>}"
EMAIL="${2:?usage: sh setup.sh <domain> <email for the certificate>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
META="http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0"

echo "== packages"
sudo apt-get update -y
sudo apt-get install -y coturn certbot

echo "== addresses"
PRIVATE_IP="$(curl -s -H 'Metadata-Flavor: Google' "$META/ip")"
PUBLIC_IP="$(curl -s -H 'Metadata-Flavor: Google' "$META/access-configs/0/external-ip")"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
echo "private $PRIVATE_IP  public $PUBLIC_IP  $DOMAIN -> ${RESOLVED:-nothing}"
if [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  echo "The A record for $DOMAIN must point at $PUBLIC_IP first. Stopping." >&2
  exit 1
fi

echo "== certificate"
sudo systemctl stop coturn 2>/dev/null || true
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
sed -e "s/__PRIVATE_IP__/$PRIVATE_IP/g" -e "s/__PUBLIC_IP__/$PUBLIC_IP/g" -e "s/__SECRET__/$SECRET/g" \
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
