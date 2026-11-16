# pdrive

A self hosted google drive like service. Clients connect to the server and can upload, download, and view files, as well as save files for offline and have them sync back up when reconnected with the server. 

Also contains a terminal interface to create a backup of the server's data.


## Setting up as Progressive Web App

One-time phone setup (do in this order):
1. Open http://192.168.0.36:8081 on your phone → Download the PDrive CA certificate → open the file and install as a CA certificate.
2. Firefox only: Settings → About Firefox, tap the Firefox logo 7× → Secret Settings → enable "Use third party CA certificates". (Chrome on Android needs no extra step.)
3. Open https://192.168.0.36:8080 → the padlock will be valid → Install appears in the menu, and the service worker registers so offline works.


The reason we have certificates here is so the progressive web app can work offline. But they're not providing any security because they're in the github repo and what not. 


## Running Backup 

Run this to backup the server:

```
python3 pdrive-backup.py --server https://192.168.0.36:8080 --password <server password> --backup-dir ~/Documents/SYNC --ca-cert certs/pdrive-ca.crt
```
