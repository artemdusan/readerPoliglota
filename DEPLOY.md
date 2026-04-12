# Wdrożenie na Cloudflare Pages

## 1. Google Cloud Console — jednorazowe

1. [Utwórz projekt](https://console.cloud.google.com/projectcreate)
2. [Włącz Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
3. [Utwórz OAuth 2.0 Client ID](https://console.cloud.google.com/apis/credentials/oauthclient)
   - Typ: **Web application**
   - Authorized JavaScript origins — dodaj oba:
     ```
     https://TWOJA-DOMENA.pages.dev
     http://localhost:5173
     ```
4. Skopiuj wygenerowany **Client ID** (format: `…apps.googleusercontent.com`)

## 2. Cloudflare Pages — podłączenie repo

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. Wybierz repozytorium
3. Build settings:
   | Pole | Wartość |
   |---|---|
   | Framework preset | Vite |
   | Build command | `npm run build` |
   | Build output directory | `dist` |

## 3. Cloudflare Pages — zmienne środowiskowe

Settings → Environment variables → Production → Add variable:

| Variable | Value |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | `123456789-abc.apps.googleusercontent.com` |
| `VITE_WORKER_URL` | `https://reader-worker.artemdusan.workers.dev` |

Jeśli chcesz też sync lokalnie, utwórz `.env.local` (nie commituj do repo):
```
VITE_GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
VITE_WORKER_URL=https://reader-worker.artemdusan.workers.dev
```

## 3a. Cloudflare Worker - CORS

W ustawieniach workera dodaj zmiennÄ…:

| Variable | Value |
|---|---|
| `CORS_ALLOWED_ORIGINS` | `https://reader.stanley2025.uk,http://localhost:5173` |

Sekrety workera:

| Secret | Value |
|---|---|
| `JWT_SECRET` | losowy dlugi sekret |
| `XAI_API_KEY` | klucz API xAI / Grok |

## 4. Deploy

Każdy push do `main` triggeruje automatyczny build. Pierwsza wizyta na domenie uruchomi sync po kliknięciu "Połącz z Google Drive" w Ustawieniach.
