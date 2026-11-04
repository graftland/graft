#!/bin/sh
# Creates a dedicated CA, a runner certificate, and a host certificate.
#
#   certificates.sh <directory> [runner-hostname] [host-identity]
#
# The runner certificate is valid for the hostname (default: localhost). The
# host certificate carries the SAN URI graft://<host-identity> (default:
# billing), which names the host's instance namespace on the runner.
set -eu

directory=$1
hostname=${2:-localhost}
identity=${3:-billing}

mkdir -p "$directory"
cd "$directory"

openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
	-keyout ca.key -out ca.crt -subj "/CN=Graft sample CA" \
	-addext "basicConstraints=critical,CA:TRUE" \
	-addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null

sign() {
	name=$1
	subject=$2
	extensions=$3
	openssl req -newkey rsa:2048 -nodes -keyout "$name.key" -out "$name.csr" \
		-subj "$subject" 2>/dev/null
	printf '%s\n' "$extensions" >"$name.ext"
	openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key \
		-CAcreateserial -days 30 -out "$name.crt" -extfile "$name.ext" 2>/dev/null
	rm "$name.csr" "$name.ext"
}

case $hostname in
localhost) names="DNS:localhost,IP:127.0.0.1" ;;
*) names="DNS:$hostname" ;;
esac
sign server "/CN=$hostname" "basicConstraints=critical,CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$names"

sign client "/CN=$identity" "basicConstraints=critical,CA:FALSE
keyUsage=digitalSignature
extendedKeyUsage=clientAuth
subjectAltName=URI:graft://$identity"

# The CA key can sign more certificates; keep it away from both machines.
chmod 600 ca.key server.key client.key
