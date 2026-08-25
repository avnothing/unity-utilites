const http = require("node:http");
const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
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
  const commands = [
    new SlashCommandBuilder()
      .setName("support")
      .setDescription("Learn how to open a private Unity Airlines support ticket"),
    new SlashCommandBuilder()
      .setName("ticket")
      .setDescription("Manage Unity Airlines modmail tickets")
      .setDMPermission(false)
      .addSubcommand(command => command.setName("claim").setDescription("Claim the ticket in this channel"))
      .addSubcommand(command => command.setName("close").setDescription("Close this ticket and save its transcript")
        .addStringOption(option => option.setName("reason").setDescription("Why the ticket is being closed").setRequired(true).setMaxLength(500)))
      .addSubcommand(command => command.setName("close-delay").setDescription("Close in six hours unless the customer replies"))
      .addSubcommand(command => command.setName("priority").setDescription("Set this ticket's priority")
        .addStringOption(option => option.setName("priority").setDescription("Ticket priority").setRequired(true).addChoices(
          { name: "Low", value: "Low" }, { name: "Normal", value: "Normal" }, { name: "High", value: "High" }, { name: "Urgent", value: "Urgent" }
        )))
      .addSubcommand(command => command.setName("note").setDescription("Add a private staff note without messaging the customer")
        .addStringOption(option => option.setName("note").setDescription("Private note for staff in this ticket").setRequired(true).setMaxLength(1900)))
      .addSubcommand(command => command.setName("transfer").setDescription("Transfer this ticket to another support team")
        .addStringOption(option => option.setName("team").setDescription("New support team").setRequired(true).setAutocomplete(true)))
      .addSubcommand(command => command.setName("add").setDescription("Add another staff member to this ticket")
        .addUserOption(option => option.setName("staff_member").setDescription("Staff member to add").setRequired(true)))
      .addSubcommand(command => command.setName("user").setDescription("Show the customer and routing information for this ticket"))
      .addSubcommand(command => command.setName("transcript").setDescription("Generate the current ticket transcript"))
      .addSubcommand(command => command.setName("reopen").setDescription("Reopen a closed ticket by its number")
        .addIntegerOption(option => option.setName("ticket_number").setDescription("Ticket number shown in the dashboard or log").setRequired(true).setMinValue(1))),
    new SlashCommandBuilder()
      .setName("role-sync")
      .setDescription("Control staff role synchronisation")
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
      .addSubcommand(command => command.setName("run").setDescription("Run a full staff and Customer role sync now"))
      .addSubcommand(command => command.setName("member").setDescription("Synchronise one member now")
        .addUserOption(option => option.setName("member").setDescription("Main-server member to synchronise").setRequired(true)))
      .addSubcommand(command => command.setName("status").setDescription("Show role-sync configuration and last-run status")),
    new SlashCommandBuilder()
      .setName("dashboard")
      .setDescription("Open the Unity Airlines modmail dashboard")
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder()
      .setName("utilities-status")
      .setDescription("Show the utilities bot, Hub, modmail and role-sync status")
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
];
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands.map(command => command.toJSON()) });
  console.log(`Cleared old global commands and registered ${commands.length} main-server command groups.`);
}

function discordTimestamp(value) {
  if (!value) return "Not run yet";
  return `<t:${Math.floor(new Date(value).getTime() / 1000)}:R>`;
}

async function handleRoleSyncCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "run") {
    const result = await roleSync.syncAll({ refreshMembers: true });
    state.lastRoleSyncAt = new Date().toISOString();
    return interaction.editReply(`Role sync complete: ${result.checked || 0} members checked, ${result.changed || 0} changed and ${result.failures || 0} failed.`);
  }
  if (subcommand === "member") {
    const user = interaction.options.getUser("member", true);
    const member = await state.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.editReply("That user is not a member of the main server.");
    const result = await roleSync.syncMember(member);
    state.lastRoleSyncAt = new Date().toISOString();
    return interaction.editReply(`Synchronised ${member.user.tag}: ${result.added.length} role(s) added, ${result.removed.length} removed${result.skipped.length ? ` and ${result.skipped.length} skipped because the bot cannot manage them` : ""}.`);
  }
  const payload = await api.roleSyncAll();
  return interaction.editReply([
    `**Last sync:** ${discordTimestamp(state.lastRoleSyncAt)}`,
    `**Linked Hub accounts:** ${payload.members?.length || 0}`,
    `**Managed main-server roles:** ${payload.managedRoleIds?.length || 0}`,
    `**Customer fallback configured:** ${payload.fallbackRoleIds?.length ? "Yes" : "No"}`
  ].join("\n"));
}

async function handleUtilitiesStatus(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const hub = await modmail.getConfig(true);
  const embed = new EmbedBuilder()
    .setColor(state.ready ? 0x0a8f5b : 0xef4444)
    .setTitle("Unity Utilities status")
    .addFields(
      { name: "Discord", value: state.ready ? `Online · ${Math.round(client.ws.ping)} ms` : "Starting", inline: true },
      { name: "Hub bridge", value: hub.settings?.mainGuildId === state.guild.id ? "Connected" : "Configuration required", inline: true },
      { name: "Support teams", value: String(hub.teams?.length || 0), inline: true },
      { name: "Preset replies", value: String(hub.presets?.length || 0), inline: true },
      { name: "Last role sync", value: discordTimestamp(state.lastRoleSyncAt), inline: true },
      { name: "Last catalogue update", value: discordTimestamp(state.lastCatalogueAt), inline: true }
    )
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
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
    readyClient.user.setPresence({ activities: [{ name: "DM me for support", type: ActivityType.Playing }], status: "online" });
    console.log(`Unity utilities bot ready as ${readyClient.user.tag} in ${state.guild.name}.`);
    roleSync.syncAll({ refreshMembers: true }).then(() => { state.lastRoleSyncAt = new Date().toISOString(); }).catch(error => console.error(`Initial role sync failed: ${error.message}`));
    catalogueTimer = safeInterval(publishCatalogue, 5 * 60_000, "Catalogue refresh failed");
    roleTimer = safeInterval(async () => {
      await roleSync.syncAll();
      state.lastRoleSyncAt = new Date().toISOString();
    }, 20_000, "Role sync failed");
    actionTimer = safeInterval(() => modmail.processPendingActions(), 10_000, "Modmail action poll failed");
  } catch (error) {
    console.error(`Bot startup failed: ${error.stack || error.message}`);
    process.exitCode = 1;
    client.destroy();
  }
});

async function handleOwnerMention(message) {
  if (!message.inGuild() || message.guildId !== config.guildId || message.author.bot) return false;
  if (!message.mentions.users.has("662339129249628160")) return false;

  const notice = await message.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x0a8f5b)
        .setTitle("Need support?")
        .setDescription("Please do not ping avnothing. If you require support, please open a ticket.")
    ],
    allowedMentions: { repliedUser: false }
  }).catch(error => {
    console.warn(`Could not send owner-mention notice: ${error.message}`);
    return null;
  });

  if (notice) setTimeout(() => notice.delete().catch(() => null), 5_000).unref?.();
  return true;
}

client.on(Events.MessageCreate, async message => {
  await handleOwnerMention(message);
  await modmail?.handleMessage(message);
});
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isAutocomplete() && await modmail?.handleAutocomplete(interaction)) return;
    if (await modmail?.handleInteraction(interaction)) return;
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === "support") {
      await interaction.reply({ content: `Direct-message <@${client.user.id}> to open a private Unity Airlines support ticket. You will be asked to choose the right support team.`, ephemeral: true });
    } else if (interaction.commandName === "ticket") {
      await modmail.handleTicketCommand(interaction);
    } else if (interaction.commandName === "role-sync") {
      await handleRoleSyncCommand(interaction);
    } else if (interaction.commandName === "dashboard") {
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open Modmail Dashboard").setURL(`${config.portalUrl}/portal.html?page=modmail`));
      await interaction.reply({ content: "Open the private Unity Airlines Hub dashboard:", components: [row], ephemeral: true });
    } else if (interaction.commandName === "utilities-status") {
      await handleUtilitiesStatus(interaction);
    }
  } catch (error) {
    console.error(`Command failed: ${error.stack || error.message}`);
    const payload = { content: error.message || "That command could not be completed.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});
client.on(Events.GuildMemberAdd, member => {
  if (member.guild.id === config.guildId) roleSync?.syncMember(member).catch(error => console.warn(`New-member role sync failed: ${error.message}`));
});
client.on(Events.GuildMemberRemove, member => {
  if (member.guild.id === config.guildId) modmail?.closeForMemberLeave(member).catch(error => console.warn(`Automatic ticket close failed: ${error.message}`));
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
