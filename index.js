const http = require("node:http");
const {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder
} = require("discord.js");
const { createHubApi } = require("./src/api");
const { loadConfig } = require("./src/config");
const { createModmail } = require("./src/modmail");
const { createRoleSync } = require("./src/role-sync");

const config = loadConfig();
const api = createHubApi(config);
const state = { ready: false, guild: null, lastCatalogueAt: null, lastRoleSyncAt: null };
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

let roleSync;
let modmail;
let catalogueTimer;
let roleTimer;
let actionTimer;
let catalogueDebounce;

async function publishCatalogue() {
  if (!state.guild) return;
  await state.guild.roles.fetch();
  await state.guild.channels.fetch();
  const roles = [...state.guild.roles.cache.values()]
    .filter(role => role.id !== state.guild.roles.everyone.id && !role.managed)
    .map(role => ({ id: role.id, name: role.name, position: role.position, color: role.color }));
  const channels = [...state.guild.channels.cache.values()]
    .filter(channel => [ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
    .map(channel => ({
      id: channel.id,
      name: channel.name,
      position: channel.rawPosition,
      type: channel.type === ChannelType.GuildCategory ? "category" : "text"
    }));
  await api.publishCatalogue({ guildId: state.guild.id, guildName: state.guild.name, roles, channels });
  state.lastCatalogueAt = new Date().toISOString();
  console.log(`Published ${roles.length} roles and ${channels.length} channels to the Unity Hub.`);
}

async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName("support")
    .setDescription("Learn how to open a private Unity Airlines support ticket");
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: [command.toJSON()] });
}

function safeInterval(fn, milliseconds, label) {
  const timer = setInterval(() => Promise.resolve(fn()).catch(error => console.error(`${label}: ${error.stack || error.message}`)), milliseconds);
  timer.unref?.();
  return timer;
}

client.once(Events.ClientReady, async readyClient => {
  try {
    state.guild = await readyClient.guilds.fetch(config.guildId).then(guild => guild.fetch());
    for (const guild of readyClient.guilds.cache.values()) {
      if (guild.id !== config.guildId) await guild.leave().catch(() => null);
    }
    roleSync = createRoleSync({ guild: state.guild, api });
    modmail = createModmail({ client: readyClient, guild: state.guild, api });
    await Promise.all([registerCommands(), publishCatalogue(), modmail.getConfig(true)]);
    state.ready = true;
    console.log(`Unity utilities bot ready as ${readyClient.user.tag} in ${state.guild.name}.`);
    roleSync.syncAll().then(() => { state.lastRoleSyncAt = new Date().toISOString(); }).catch(error => console.error(`Initial role sync failed: ${error.message}`));
    catalogueTimer = safeInterval(publishCatalogue, 5 * 60_000, "Catalogue refresh failed");
    roleTimer = safeInterval(async () => {
      await roleSync.syncAll();
      state.lastRoleSyncAt = new Date().toISOString();
    }, 5 * 60_000, "Role sync failed");
    actionTimer = safeInterval(() => modmail.processPendingActions(), 10_000, "Modmail action poll failed");
  } catch (error) {
    console.error(`Bot startup failed: ${error.stack || error.message}`);
    process.exitCode = 1;
    client.destroy();
  }
});

client.on(Events.MessageCreate, message => modmail?.handleMessage(message));
client.on(Events.InteractionCreate, async interaction => {
  if (await modmail?.handleInteraction(interaction)) return;
  if (interaction.isChatInputCommand() && interaction.commandName === "support") {
    await interaction.reply({ content: "Direct-message this bot to open a private Unity Airlines support ticket. You will be asked to choose the right support team.", ephemeral: true });
  }
});
client.on(Events.GuildMemberAdd, member => {
  if (member.guild.id === config.guildId) roleSync?.syncMember(member).catch(error => console.warn(`New-member role sync failed: ${error.message}`));
});
for (const event of [Events.GuildRoleCreate, Events.GuildRoleUpdate, Events.GuildRoleDelete, Events.ChannelCreate, Events.ChannelUpdate, Events.ChannelDelete]) {
  client.on(event, () => {
    clearTimeout(catalogueDebounce);
    catalogueDebounce = setTimeout(() => publishCatalogue().catch(error => console.warn(`Catalogue refresh failed: ${error.message}`)), 2_000);
    catalogueDebounce.unref?.();
  });
}
client.on(Events.Error, error => console.error(`Discord client error: ${error.stack || error.message}`));

const healthServer = http.createServer((req, res) => {
  if (req.url !== "/health") {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Not found" }));
  }
  res.writeHead(state.ready ? 200 : 503, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({
    ok: state.ready,
    guild: state.guild?.name || null,
    lastCatalogueAt: state.lastCatalogueAt,
    lastRoleSyncAt: state.lastRoleSyncAt
  }));
});

healthServer.listen(config.port, "0.0.0.0", () => console.log(`Health server listening on port ${config.port}.`));
client.login(config.token);

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  clearInterval(catalogueTimer);
  clearInterval(roleTimer);
  clearInterval(actionTimer);
  clearTimeout(catalogueDebounce);
  client.destroy();
  healthServer.close(() => process.exit(0));
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
