# Unity Airlines Utilities Bot

Main-server Discord bot for Unity Airlines. It synchronises mapped staff roles from the staff server, gives everyone else the configured Customer role, and runs private DM-based modmail connected to the Unity Hub.

## Features

- Staff-server to main-server role mapping through the Hub
- Customer-role fallback for members without a mapped staff role
- Twenty-second cached reconciliation plus a full startup scan and instant new-member sync
- DM modmail with support-team selection
- Private ticket channels, claiming, transfer, close reasons and preset replies
- Persistent messages, ticket history and dashboard controls on the website
- Transcript files posted to a private Discord log channel
- `/support` guidance command and Railway health endpoint

## Commands

- `/support` — tells a customer how to start a private DM ticket.
- `/ticket claim|close|transfer|add|user|transcript|reopen` — complete ticket control for support staff.
- `/role-sync run|member|status` — manually run or inspect cross-server role synchronisation.
- `/dashboard` — opens the private Hub modmail dashboard.
- `/support-panel` — posts the customer-facing support panel in a chosen channel.
- `/utilities-status` — checks Discord, Hub, support-team and sync health.

Ticket and utilities commands are permission-gated in Discord. At startup the bot clears the application's obsolete global commands, including the old flight commands, and registers this command set directly in the main server so updates appear immediately.

The role sync only manages roles selected in the Hub mapping. It never copies arbitrary permissions or grants the main server's staff roles by matching names.

## Discord application setup

Create or select the Discord application for the main-server bot, then enable these privileged intents in the Developer Portal:

- Server Members Intent
- Message Content Intent

Invite it to the **main server only** with these permissions:

- Manage Roles
- Manage Channels
- View Channels
- Send Messages
- Read Message History
- Embed Links
- Attach Files

Put the bot's Discord role above the Customer role and every mapped staff role it must manage.

## Railway variables

| Variable | Value |
| --- | --- |
| `DISCORD_TOKEN` | Token for the main-server Discord bot |
| `DISCORD_CLIENT_ID` | Application ID for that bot |
| `MAIN_GUILD_ID` | Discord server ID of the main/public server |
| `PORTAL_URL` | `https://unityairlines.up.railway.app` |
| `BOT_API_SECRET` | The same shared secret used by the website and staff bot |

Railway supplies `PORT` automatically. Do not create or override it.

Deploy this repository as a new Railway service. Set the healthcheck path to `/health` if Railway does not read `railway.json` automatically.

## Hub setup after first deployment

When the bot first connects it publishes the main server's roles and channels to the website. In **Hub → Modmail**:

1. Choose the Customer fallback role.
2. Map each selected staff-server role to its main-server counterpart.
3. Choose the ticket category and private log channel.
4. Add support teams and select which main-server roles can access each team.
5. Add preset replies, optionally limiting them to one support team.

The website and both bots must use the same `BOT_API_SECRET`. Modmail data uses the website's existing PostgreSQL `DATABASE_URL`; this bot does not need its own database variable.
