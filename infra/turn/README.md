# TURN server (Live call)

Live call connects the rider's phone and the driver's phone directly when it
can. On Nigerian mobile networks it often can't, because many phones share one
public address (carrier-grade NAT). Then the call's audio is relayed through
this server. It is ours: coturn on one small Google Cloud machine in London.

| | |
|---|---|
| Domain | `turn.wheelersng.com` |
| Machine | `wheelers-turn`, Google Cloud, region `europe-west2` (London), e2-small, Ubuntu 24.04 |
| Ports | 3478 udp and tcp (STUN and TURN), 443 tcp (TURN over TLS), 49152 to 65535 udp (relayed audio), 80 tcp (certificate renewal) |
| Secret | `/etc/coturn/secret` on the machine. The gateway's `TURN_SHARED_SECRET` must be the same value |
| Settings | `/etc/turnserver.conf`, written from `turnserver.conf.template` |

London was measured against Johannesburg from Lagos: 176 ms average and
steady, against 287 ms with spikes. It stays in London.

## The gateway's side

In the gateway's `.env`:

```
TURN_HOST=turn.wheelersng.com
TURN_SHARED_SECRET=<the value in /etc/coturn/secret>
LIVE_CALL_ENABLED=true
```

The gateway gives each person a TURN login for each call. It is signed with
the secret and runs out after two hours (`TURN_CREDENTIAL_TTL_SECONDS`), so
nothing is stored and nothing lasts. See `apps/api-gateway/src/trip-chat/ice-servers.ts`.

## Building it again, or moving it

On your laptop, with `gcloud` pointed at the Wheelers project. Pick a zone
in `europe-west2` that has room:

```
gcloud compute addresses create wheelers-turn-ip --region=europe-west2
gcloud compute instances create wheelers-turn \
  --zone=<zone> --machine-type=e2-small \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=20GB --address=wheelers-turn-ip --tags=turn-server
gcloud compute firewall-rules create wheelers-turn-in \
  --direction=INGRESS --target-tags=turn-server --source-ranges=0.0.0.0/0 \
  --allow=udp:3478,tcp:3478,tcp:443,tcp:80,udp:49152-65535
gcloud compute addresses describe wheelers-turn-ip --region=europe-west2 --format='value(address)'
```

Point the A record for `turn.wheelersng.com` at that address, and wait
until `ping turn.wheelersng.com` shows it. Then copy this folder to the
machine and run the setup there:

```
gcloud compute scp --recurse infra/turn wheelers-turn:~ --zone=<zone>
gcloud compute ssh wheelers-turn --zone=<zone>
sh ~/turn/setup.sh turn.wheelersng.com <your email>
```

A new machine makes a new secret. Put it in the gateway's `.env` and restart
the gateway.

## Checking it works

A test login, valid for a day, made on the machine:

```
SECRET=$(sudo cat /etc/coturn/secret)
U="$(( $(date +%s) + 86400 )):test"
P=$(printf '%s' "$U" | openssl dgst -binary -sha1 -hmac "$SECRET" | base64)
echo "username: $U"; echo "password: $P"
```

On a phone, open WebRTC Trickle ICE
(https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/),
add each server below with that username and password, and Gather candidates.
A line of type `relay` means it works.

- [x] `turn:turn.wheelersng.com:3478?transport=udp` on Airtel
- [x] `turn:turn.wheelersng.com:443?transport=tcp` on Airtel
- [ ] `turns:turn.wheelersng.com:443?transport=tcp` (TLS)
- [ ] The same on MTN, Glo and Wi-Fi
- [ ] A wrong password gets no `relay` line

## Looking after it

- The certificate renews by itself; the hook copies it to coturn and restarts it.
- `sudo journalctl -u coturn -n 100` shows what it is doing.
- Each relayed call uses roughly 100 kbps each way. The machine's outgoing
  data is what costs money as calls grow.
