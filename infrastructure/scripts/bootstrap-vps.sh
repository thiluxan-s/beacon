#!/usr/bin/env bash
# One-time hardening + Docker install for a fresh Ubuntu 24.04 droplet.
# Run as root: bash bootstrap-vps.sh <ssh_public_key>
set -euo pipefail

PUBKEY="${1:?usage: bootstrap-vps.sh \"<ssh_public_key>\"}"
DEPLOY_USER="thiluxan"

echo "[bootstrap] timezone -> UTC"
timedatectl set-timezone UTC

echo "[bootstrap] create deploy user ${DEPLOY_USER}"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
fi
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"
echo "$PUBKEY" > "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"

echo "[bootstrap] SSH hardening"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

echo "[bootstrap] firewall (ufw)"
apt-get update -y
apt-get install -y ufw fail2ban unattended-upgrades
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "[bootstrap] fail2ban + auto updates"
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "[bootstrap] install Docker (official repo)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# shellcheck disable=SC1091  # /etc/os-release is sourced at runtime on the droplet, not lintable here
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker "$DEPLOY_USER"

echo "[bootstrap] mkdir /opt/beacon"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /opt/beacon

echo "[bootstrap] DONE. Verify: sudo -u ${DEPLOY_USER} docker run --rm hello-world"
