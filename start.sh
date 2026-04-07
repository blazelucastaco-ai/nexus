#!/bin/sh
# NEXUS start wrapper — used by launchd to ensure env is set up correctly
cd /Users/lucastopinka/Desktop/nexus
export PATH="/usr/local/bin:$PATH"
exec /usr/local/bin/node dist/index.js
