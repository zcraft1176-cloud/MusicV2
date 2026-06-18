#!/bin/bash
# ================================================
# MsicFree — Auto Deploy Script
# ================================================
# Jalankan manual: bash deploy.sh
# Atau setup sebagai GitHub webhook handler
# ================================================

set -e

PROJECT_DIR="/var/www/msicfree"
LOG_FILE="/var/log/msicfree-deploy.log"

echo "$(date): Starting deployment..." | tee -a "$LOG_FILE"

cd "$PROJECT_DIR"

# Pull latest from GitHub
echo "Pulling latest changes..." | tee -a "$LOG_FILE"
git pull origin main 2>&1 | tee -a "$LOG_FILE"

# Install Node dependencies (jika package.json berubah)
if [ -f "package.json" ]; then
    echo "Installing npm dependencies..." | tee -a "$LOG_FILE"
    npm install --production 2>&1 | tee -a "$LOG_FILE"

    # Build Tailwind CSS
    echo "Building CSS..." | tee -a "$LOG_FILE"
    npm run build:css 2>&1 | tee -a "$LOG_FILE"
fi

# Set permissions
echo "Setting permissions..." | tee -a "$LOG_FILE"
chown -R www-data:www-data "$PROJECT_DIR"
find "$PROJECT_DIR" -type f -exec chmod 644 {} \;
find "$PROJECT_DIR" -type d -exec chmod 755 {} \;

# Protect config file
if [ -f "server-api/config.php" ]; then
    chmod 600 server-api/config.php
fi

echo "$(date): Deployment complete!" | tee -a "$LOG_FILE"
