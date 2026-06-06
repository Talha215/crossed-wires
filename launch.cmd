@echo off
rem Launches the Crossed Wires game server.
rem
rem Permanent public URL (via Tailscale Funnel, runs as a service - no
rem extra window needed):  https://talha-pc.tail444324.ts.net
rem
rem If the URL ever stops working, re-enable the funnel with:
rem   tailscale funnel --bg 3000
cd /d "%~dp0"
echo Share link: https://talha-pc.tail444324.ts.net
start "Crossed Wires - Server" cmd /k npm start
