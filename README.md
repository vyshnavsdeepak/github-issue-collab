# github-issue-collab

A GitHub App token broker + CLI issue reader.

## Setup

### 1. Create a GitHub App

1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App
2. Set permissions: **Issues** (Read-only), **Metadata** (Read-only)
3. Click "Create GitHub App"
4. Install the app on your repository (Settings → Install App)
5. Download the private key (Generate a private key button)
6. Note your **App ID** and **Installation ID** (from the install URL: `github.com/apps/your-app/installations/INSTALLATION_ID`)

### 2. Configure

```bash
cp .env.example .env
# Edit .env: set GITHUB_APP_ID and GITHUB_PRIVATE_KEY (or GITHUB_PRIVATE_KEY_PATH)
```

### 3. Install and start server

```bash
npm install
npm run dev:server
# Server running on http://localhost:3000
```

### 4. Configure CLI

```bash
npm run dev:cli -- auth
# Enter your installation ID and server URL when prompted
```

## Usage

```bash
# Authenticate (one-time)
npm run dev:cli -- auth

# List open issues
npm run dev:cli -- issues list <owner> <repo>

# View a single issue
npm run dev:cli -- issues view <owner> <repo> <number>

# Options
npm run dev:cli -- issues list <owner> <repo> --state closed
npm run dev:cli -- issues list <owner> <repo> --state all
```

## Architecture

```
apps/
  server/    — Token broker: POST /token returns GitHub installation access token
  cli/       — CLI: fetches token from server, reads issues from GitHub REST API
packages/
  github/    — Shared SDK: JWT generation, token exchange, issue fetching
```

## Server API

```
GET  /health          → { status: "ok" }
POST /token           → { token: "ghs_xxx" }
  body: { "installationId": "123456" }
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | Your GitHub App's numeric ID |
| `GITHUB_PRIVATE_KEY` | Private key contents (multi-line, quote in .env) |
| `GITHUB_PRIVATE_KEY_PATH` | Alternative: path to `.pem` file |
| `PORT` | Server port (default: 3000) |
