@echo off
rem Launches Crossed Wires: game server + Cloudflare share tunnel.
rem The tunnel window prints your https://....trycloudflare.com share link.
cd /d "%~dp0"
start "Crossed Wires - Server" cmd /k npm start
start "Crossed Wires - Tunnel (share link below)" cmd /k cloudflared tunnel --url http://localhost:3000
