const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { roleChanges } = require("../src/role-sync");
const { safeChannelName, transcriptText } = require("../src/modmail");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("loads the required Railway and Discord configuration", () => {
  const config = loadConfig({
    DISCORD_TOKEN: "token",
    DISCORD_CLIENT_ID: "1540788552546394112",
    MAIN_GUILD_ID: "1540788552546394113",
    PORTAL_URL: "https://unityairlines.up.railway.app/",
    BOT_API_SECRET: "shared-secret",
    PORT: "8080"
  });
  assert.equal(config.portalUrl, "https://unityairlines.up.railway.app");
  assert.equal(config.port, 8080);
});

test("role sync removes stale managed roles and adds targets", () => {
  assert.deepEqual(roleChanges(["1", "2", "9"], ["3"], ["1", "2", "3"]), {
    add: ["3"],
    remove: ["1", "2"]
  });
});

test("fallback customer role is treated as a normal managed target", () => {
  assert.deepEqual(roleChanges(["555"], ["777"], ["555", "777"]), { add: ["777"], remove: ["555"] });
});

test("ticket channel names are safe and deterministic", () => {
  assert.equal(safeChannelName({ ticketNumber: 42, discordUsername: "A User!" }), "ticket-42-a-user");
});

test("transcripts include direction, content and attachments in London time", () => {
  const text = transcriptText({
    ticketNumber: 3,
    discordUsername: "Passenger",
    discordUserId: "1540788552546394112",
    openedAt: "2026-08-24T12:00:00.000Z",
    status: "Closed",
    closedAt: "2026-08-24T12:10:00.000Z",
    closedByName: "Agent",
    closedByDiscordId: "1540788552546394113",
    closeReason: "Resolved"
  }, [{
    direction: "User to Staff",
    authorName: "Passenger",
    authorDiscordId: "1540788552546394112",
    content: "Help please",
    attachments: [{ name: "proof.png", url: "https://cdn.discordapp.com/proof.png" }],
    createdAt: "2026-08-24T12:01:00.000Z"
  }]);
  assert.match(text, /Unity Airlines Modmail #3/);
  assert.match(text, /User to Staff/);
  assert.match(text, /Help please/);
  assert.match(text, /proof\.png/);
  assert.match(text, /Resolved/);
});

test("registers the utilities command suite and clears obsolete global commands", () => {
  const index = read("index.js");
  for (const command of ["ticket", "role-sync", "dashboard", "support-panel", "utilities-status"]) {
    assert.match(index, new RegExp(`setName\\(\\"${command}\\"\\)`));
  }
  assert.match(index, /Routes\.applicationCommands\(config\.clientId\).*body: \[\]/s);
  assert.doesNotMatch(index, /setName\("change_flights"\)/);
  assert.doesNotMatch(index, /setName\("log_flight"\)/);
});

test("ticket commands include reopen, transcripts, transfers and staff access", () => {
  const index = read("index.js");
  const modmail = read("src/modmail.js");
  for (const subcommand of ["claim", "close", "transfer", "add", "user", "transcript", "reopen"]) {
    assert.match(index, new RegExp(`setName\\(\\"${subcommand}\\"\\)`));
  }
  assert.match(modmail, /async function reopenTicket/);
  assert.match(modmail, /permissionOverwrites\.edit/);
  assert.match(modmail, /transcriptText/);
});
