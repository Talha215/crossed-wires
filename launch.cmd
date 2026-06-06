@echo off
rem Launches the Crossed Wires game server on http://localhost:3000
rem
rem To let friends join from the internet, see "Letting friends join"
rem in README.md. If you've set up Tailscale Funnel, your permanent URL
rem is https://<your-machine>.<your-tailnet>.ts.net (run
rem "tailscale funnel status" to see it).
cd /d "%~dp0"
start "Crossed Wires - Server" cmd /k npm start
