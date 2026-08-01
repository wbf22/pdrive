One-time phone setup (do in this order):
1. Open http://192.168.0.36:8081 on your phone → Download the PDrive CA certificate → open the file and install as a CA certificate.
2. Firefox only: Settings → About Firefox, tap the Firefox logo 7× → Secret Settings → enable "Use third party CA certificates". (Chrome on Android needs no extra step.)
3. Open https://192.168.0.36:8080 → the padlock will be valid → Install appears in the menu, and the service worker registers so offline works.