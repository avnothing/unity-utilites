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

test("ticket commands include reopen, close delays, transcripts, transfers and staff access", () => {
  const index = read("index.js");
  const modmail = read("src/modmail.js");
  for (const subcommand of ["claim", "close", "close-delay", "transfer", "add", "user", "transcript", "reopen"]) {
    assert.match(index, new RegExp(`setName\\(\\"${subcommand}\\"\\)`));
  }
  assert.match(modmail, /async function reopenTicket/);
  assert.match(modmail, /permissionOverwrites\.edit/);
  assert.match(modmail, /transcriptText/);
  assert.match(modmail, /async function startCloseDelay/);
});

test("runs cached role reconciliation every twenty seconds", () => {
  const index = read("index.js");
  const roleSync = read("src/role-sync.js");
  assert.match(index, /20_000, "Role sync failed"/);
  assert.match(index, /syncAll\(\{ refreshMembers: true \}\)/);
  assert.match(roleSync, /refreshMembers \|\| !guild\.members\.cache\.size/);
});

test("modmail reacts to DMs, presents an embedded team selector and creates one channel", () => {
  const modmail = read("src/modmail.js");
  assert.match(modmail, /message\.react\("📩"\)/);
  assert.match(modmail, /setTitle\("Unity Airlines Support"\)/);
  assert.match(modmail, /setCustomId\(`\$\{PREFIX\}:new:\$\{message\.author\.id\}`\)/);
  assert.match(modmail, /Object\.assign\(ticket, updated\.ticket\)/);
  assert.doesNotMatch(modmail, /const ticket = created\.ticket;\s+await ensureChannel\(ticket\);\s+await sendUserMessageToStaff\(ticket, message\);/);
});

test("uses the Unity Airlines support emoji for ticket intake", () => {
  const modmail = read("src/modmail.js");
  assert.match(modmail, /SUPPORT_EMOJI_ID = "1532706319889600672"/);
  assert.match(modmail, /message\.react\(SUPPORT_EMOJI_ID\)/);
  assert.match(modmail, /emoji: team\.emoji \|\| \{ id: SUPPORT_EMOJI_ID \}/);
});

test("ticket lifecycle closes departed members and lets configured customers cancel their own ticket", () => {
  const index = read("index.js");
  const modmail = read("src/modmail.js");
  assert.match(index, /Events\.GuildMemberRemove/);
  assert.match(modmail, /async function closeForMemberLeave/);
  assert.match(modmail, /allowCustomerClose/);
  assert.match(modmail, /user-close/);
  assert.match(modmail, /cancelCloseDelayForCustomerReply/);
  assert.match(modmail, /dueCloseDelays/);
});
