# Requests subdomain — enabled

ClouDNS CNAME requests.peakdecline.com points to peakdecline.com. Nginx now serves Overseerr at https://requests.peakdecline.com through local port 5055. The /requests button redirects to this address in both live Nginx and the app source. Nginx configuration was backed up to conf/nginx-before-requests.conf before editing.

A Let's Encrypt certificate was issued successfully. The current certificate expires December 29, 2026. Certificate files are copied into the existing Nginx ssl directory; private keys are outside this repository.

The Windows task "PeakDecline Requests Certificate Renewal" runs deployment/renew-requests.ps1 daily at 03:15. It uses the existing Docker Certbot image and certificate account, copies renewed certificate files, validates Nginx, and reloads it only when files change. It runs as the signed-in Plex user and needs Docker Desktop running. A manual run completed successfully and reported renewal was not yet due.

Verified: public and local HTTPS login page, API status, valid TLS, and /requests redirect. Full Plex OAuth login requires the user to sign in.
