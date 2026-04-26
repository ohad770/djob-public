# djob-public

Public-facing jobs site and API for DJob.

## Includes
- `server.js` for the public jobs server
- `public/index.html` public jobs listing page
- `public/job.html` single job page

## Run locally
```bash
npm install
npm start
```

The server uses environment variables for port, sync secret, SMTP, and optional remote DOC-to-PDF conversion.
