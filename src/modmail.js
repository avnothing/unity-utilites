const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const PREFIX = "unity-modmail";
const STAFF_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks
];

function safeChannelName(ticket) {
  const user = String(ticket.discordUsername || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 45) || "user";
  return `ticket-${ticket.ticketNumber}-${user}`.slice(0, 95);
}

function attachmentList(attachments) {
  return (attachments || []).map(attachment => ({
    name: String(attachment.name || "attachment"),
    url: String(attachment.url || ""),
    contentType: String(attachment.contentType || "")
  })).filter(attachment => attachment.url.startsWith("https://"));
}

function messagePayload(message, direction) {
  return {
    direction,
    authorDiscordId: message.author.id,
    authorName: message.author.tag || message.author.username,
    content: message.content || "",
    attachments: attachmentList([...message.attachments.values()]),
    discordMessageId: message.id
  };
}

function transcriptText(ticket, messages, timeZone = "Europe/London") {
  const format = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone
  });
  const lines = [
    `Unity Airlines Modmail #${ticket.ticketNumber}`,
    `Discord user: ${ticket.discordUsername} (${ticket.discordUserId})`,
    `Opened: ${format.format(new Date(ticket.openedAt))}`,
    `Status: ${ticket.status}`,
    ""
  ];
  for (const message of messages || []) {
    const when = format.format(new Date(message.createdAt));
    lines.push(`[${when}] ${message.direction} — ${message.authorName} (${message.authorDiscordId})`);
    if (message.content) lines.push(message.content);
    for (const attachment of message.attachments || []) lines.push(`Attachment: ${attachment.name} — ${attachment.url}`);
    lines.push("");
  }
  if (ticket.closedAt) {
    lines.push(`Closed: ${format.format(new Date(ticket.closedAt))}`);
    lines.push(`Closed by: ${ticket.closedByName || "Staff"} (${ticket.closedByDiscordId || "unknown"})`);
    lines.push(`Reason: ${ticket.closeReason || "No reason supplied"}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function ticketControls(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:claim:${ticketId}`).setLabel("Claim").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${PREFIX}:preset:${ticketId}`).setLabel("Preset reply").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}:transfer:${ticketId}`).setLabel("Transfer").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${PREFIX}:close:${ticketId}`).setLabel("Close").setStyle(ButtonStyle.Danger)
  );
}

function createModmail({ client, guild, api, logger = console }) {
  let cachedConfig = { settings: {}, teams: [], presets: [] };
  let configLoadedAt = 0;
  let pollingActions = false;
  const pendingMessages = new Map();

  async function getConfig(force = false) {
    if (force || Date.now() - configLoadedAt > 60_000) {
      cachedConfig = await api.config();
      configLoadedAt = Date.now();
    }
    return cachedConfig;
  }

  function teamById(teamId) {
    return (cachedConfig.teams || []).find(team => team.id === teamId) || null;
  }

  function hasTeamAccess(member, ticket) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    const team = teamById(ticket.teamId);
    return Boolean(team && (team.staffRoleIds || []).some(roleId => member.roles.cache.has(roleId)));
  }

  function permissionOverwrites(team) {
    const staff = (team?.staffRoleIds || []).map(roleId => ({ id: roleId, allow: STAFF_CHANNEL_PERMISSIONS }));
    return [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.user.id, allow: [...STAFF_CHANNEL_PERMISSIONS, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
      ...staff
    ];
  }

  async function ensureChannel(ticket) {
    if (ticket.channelId) {
      const existing = await guild.channels.fetch(ticket.channelId).catch(() => null);
      if (existing) return existing;
    }
    await getConfig();
    const team = teamById(ticket.teamId);
    const parent = cachedConfig.settings?.ticketCategoryId || undefined;
    const channel = await guild.channels.create({
      name: safeChannelName(ticket),
      type: ChannelType.GuildText,
      parent,
      topic: `Unity Airlines modmail #${ticket.ticketNumber} · Discord user ${ticket.discordUserId}`,
      permissionOverwrites: permissionOverwrites(team),
      reason: `Modmail ticket #${ticket.ticketNumber}`
    });
    const updated = await api.updateTicket(ticket.id, { action: "channel", channelId: channel.id });
    const embed = new EmbedBuilder()
      .setColor(0x22a87a)
      .setTitle(`Modmail #${ticket.ticketNumber}`)
      .setDescription(`Support request from <@${ticket.discordUserId}> (${ticket.discordUsername}).`)
      .addFields(
        { name: "Support team", value: team?.name || "General", inline: true },
        { name: "Status", value: "Open · unclaimed", inline: true }
      )
      .setFooter({ text: "Claim this ticket before replying." })
      .setTimestamp();
    await channel.send({ embeds: [embed], components: [ticketControls(ticket.id)] });
    return channel;
  }

  async function sendUserMessageToStaff(ticket, message) {
    const channel = await ensureChannel(ticket);
    const attachments = attachmentList([...message.attachments.values()]);
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({ name: message.author.tag || message.author.username, iconURL: message.author.displayAvatarURL() })
      .setDescription(message.content || "*Attachment only*")
      .setFooter({ text: `User → Staff · ${message.author.id}` })
      .setTimestamp(message.createdAt);
    if (attachments.length) embed.addFields({ name: "Attachments", value: attachments.map(item => `[${item.name}](${item.url})`).join("\n").slice(0, 1024) });
    await channel.send({ embeds: [embed] });
    await api.saveMessage(ticket.id, messagePayload(message, "User to Staff"));
  }

  async function openForMessage(message, teamId = null) {
    const created = await api.createTicket({
      discordUserId: message.author.id,
      discordUsername: message.author.tag || message.author.username,
      teamId
    });
    const ticket = created.ticket;
    await ensureChannel(ticket);
    await sendUserMessageToStaff(ticket, message);
    const team = teamById(ticket.teamId);
    await message.author.send(`Your Unity Airlines support ticket **#${ticket.ticketNumber}** is open${team ? ` with **${team.name}**` : ""}. Reply here to continue the conversation.`);
    return ticket;
  }

  async function promptForTeam(message) {
    const config = await getConfig();
    const teams = (config.teams || []).slice(0, 25);
    if (teams.length <= 1) return openForMessage(message, teams[0]?.id || null);
    pendingMessages.set(message.author.id, message);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:new:${message.author.id}`)
      .setPlaceholder("Choose a support team")
      .addOptions(teams.map(team => ({
        label: team.name.slice(0, 100),
        value: team.id,
        description: (team.description || `Contact ${team.name}`).slice(0, 100),
        ...(team.emoji ? { emoji: team.emoji } : {})
      })));
    await message.author.send({
      content: config.settings?.welcomeMessage || "Welcome to Unity Airlines Support. Choose the team that can best help you.",
      components: [new ActionRowBuilder().addComponents(select)]
    });
  }

  async function handleDirectMessage(message) {
    const existing = await api.openTicket(message.author.id);
    if (existing.ticket) return sendUserMessageToStaff(existing.ticket, message);
    if (pendingMessages.has(message.author.id)) {
      pendingMessages.set(message.author.id, message);
      return message.react("⏳").catch(() => null);
    }
    return promptForTeam(message);
  }

  async function handleStaffMessage(message) {
    if (message.guildId !== guild.id) return;
    const result = await api.channelTicket(message.channelId);
    const ticket = result.ticket;
    if (!ticket) return;
    await getConfig();
    if (!hasTeamAccess(message.member, ticket)) return message.reply("You are not part of the support team assigned to this ticket.");
    if (!ticket.claimedByDiscordId) return message.reply("Claim this ticket before replying to the user.");
    if (ticket.claimedByDiscordId !== message.author.id) return message.reply(`This ticket is claimed by **${ticket.claimedByName || "another staff member"}**.`);
    const user = await client.users.fetch(ticket.discordUserId);
    const attachments = attachmentList([...message.attachments.values()]);
    const links = attachments.map(item => item.url).join("\n");
    await user.send({
      content: [`**Unity Airlines Support · ${message.author.displayName || message.author.username}**`, message.content || "", links].filter(Boolean).join("\n").slice(0, 2000)
    });
    await api.saveMessage(ticket.id, messagePayload(message, "Staff to User"));
    await message.react("✅").catch(() => null);
  }

  async function claimTicket(ticket, actor) {
    const member = await guild.members.fetch(actor.id).catch(() => null);
    await getConfig();
    if (!hasTeamAccess(member, ticket)) throw new Error("You are not part of the support team assigned to this ticket.");
    const result = await api.updateTicket(ticket.id, {
      action: "claim",
      discordActorId: actor.id,
      actorName: actor.tag || actor.username
    });
    const channel = await ensureChannel(result.ticket);
    await channel.send(`🔒 Ticket claimed by <@${actor.id}>.`);
    await api.saveMessage(ticket.id, { direction: "System", authorDiscordId: actor.id, authorName: actor.tag || actor.username, content: "Ticket claimed." });
    return result.ticket;
  }

  async function updateTeamPermissions(channel, nextTeam) {
    const allRoleIds = new Set((cachedConfig.teams || []).flatMap(team => team.staffRoleIds || []));
    for (const roleId of allRoleIds) await channel.permissionOverwrites.delete(roleId, "Modmail team transfer").catch(() => null);
    for (const roleId of nextTeam?.staffRoleIds || []) await channel.permissionOverwrites.edit(roleId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true }, { reason: "Modmail team transfer" });
  }

  async function transferTicket(ticket, teamId, actor) {
    await getConfig(true);
    const team = teamById(teamId);
    if (!team) throw new Error("That support team is no longer available.");
    const result = await api.updateTicket(ticket.id, { action: "transfer", teamId });
    const channel = await ensureChannel(result.ticket);
    await updateTeamPermissions(channel, team);
    await channel.send(`↪️ Ticket transferred to **${team.name}** by <@${actor.id}>. The ticket is now unclaimed.`);
    await api.saveMessage(ticket.id, { direction: "System", authorDiscordId: actor.id, authorName: actor.tag || actor.username, content: `Ticket transferred to ${team.name}.` });
    return result.ticket;
  }

  async function sendPreset(ticket, presetId, actor) {
    await getConfig();
    const preset = (cachedConfig.presets || []).find(item => item.id === presetId && (!item.teamId || item.teamId === ticket.teamId));
    if (!preset) throw new Error("That preset is no longer available for this support team.");
    if (ticket.claimedByDiscordId !== actor.id) throw new Error("Claim this ticket before sending a preset reply.");
    const user = await client.users.fetch(ticket.discordUserId);
    await user.send(`**Unity Airlines Support · ${actor.tag || actor.username}**\n${preset.message}`);
    await api.saveMessage(ticket.id, { direction: "Staff to User", authorDiscordId: actor.id, authorName: actor.tag || actor.username, content: preset.message });
    const channel = await ensureChannel(ticket);
    await channel.send(`📨 **${actor.tag || actor.username}** sent preset **${preset.label}**:\n${preset.message}`);
  }

  async function closeTicket(ticket, actor, reason = "Closed") {
    const result = await api.updateTicket(ticket.id, {
      action: "close",
      discordActorId: actor.id,
      actorName: actor.tag || actor.username || "Hub staff",
      reason
    });
    await api.saveMessage(ticket.id, { direction: "System", authorDiscordId: actor.id, authorName: actor.tag || actor.username || "Hub staff", content: `Ticket closed. Reason: ${reason}` });
    const config = await getConfig();
    const user = await client.users.fetch(ticket.discordUserId).catch(() => null);
    if (user) await user.send(`${config.settings?.closedMessage || "Your Unity Airlines support ticket has been closed."}\n**Reason:** ${reason}`).catch(() => null);
    const transcript = await api.transcript(ticket.id);
    const text = transcriptText(transcript.ticket, transcript.messages);
    const logChannelId = config.settings?.logChannelId;
    const logChannel = logChannelId ? await guild.channels.fetch(logChannelId).catch(() => null) : null;
    if (logChannel?.isTextBased()) {
      const file = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `modmail-${ticket.ticketNumber}.txt` });
      const embed = new EmbedBuilder()
        .setColor(0x64748b)
        .setTitle(`Closed modmail #${ticket.ticketNumber}`)
        .addFields(
          { name: "User", value: `${ticket.discordUsername} (${ticket.discordUserId})` },
          { name: "Closed by", value: actor.tag || actor.username || "Hub staff", inline: true },
          { name: "Reason", value: reason.slice(0, 1024), inline: true }
        )
        .setTimestamp();
      await logChannel.send({ embeds: [embed], files: [file] });
    }
    const channel = ticket.channelId ? await guild.channels.fetch(ticket.channelId).catch(() => null) : null;
    if (channel?.isTextBased()) {
      await channel.send(`🔒 Ticket closed by <@${actor.id}>. **Reason:** ${reason}`).catch(() => null);
      await channel.setName(`closed-${ticket.ticketNumber}`).catch(() => null);
      const timer = setTimeout(() => channel.delete(`Modmail #${ticket.ticketNumber} closed`).catch(() => null), 10_000);
      timer.unref?.();
    }
    return result.ticket;
  }

  async function ticketFromInteraction(interaction, ticketId) {
    const result = await api.transcript(ticketId);
    const ticket = result.ticket;
    if (!ticket || ticket.status !== "Open") throw new Error("This ticket is already closed.");
    const member = interaction.member || await guild.members.fetch(interaction.user.id).catch(() => null);
    await getConfig();
    if (!hasTeamAccess(member, ticket)) throw new Error("You are not part of the support team assigned to this ticket.");
    return ticket;
  }

  async function handleInteraction(interaction) {
    if (!interaction.customId?.startsWith(`${PREFIX}:`)) return false;
    const [, action, target] = interaction.customId.split(":");
    try {
      if (action === "new" && interaction.isStringSelectMenu()) {
        if (interaction.user.id !== target) throw new Error("This support menu belongs to another user.");
        await interaction.deferUpdate();
        const message = pendingMessages.get(interaction.user.id);
        if (!message) throw new Error("That request expired. Send the bot a new direct message to try again.");
        pendingMessages.delete(interaction.user.id);
        const ticket = await openForMessage(message, interaction.values[0]);
        await interaction.editReply({ content: `Your support ticket **#${ticket.ticketNumber}** has been created.`, components: [] });
        return true;
      }
      if (action === "close" && interaction.isButton()) {
        await ticketFromInteraction(interaction, target);
        const input = new TextInputBuilder().setCustomId("reason").setLabel("Reason for closing").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500);
        await interaction.showModal(new ModalBuilder().setCustomId(`${PREFIX}:close-submit:${target}`).setTitle("Close modmail ticket").addComponents(new ActionRowBuilder().addComponents(input)));
        return true;
      }
      if (action === "close-submit" && interaction.isModalSubmit()) {
        await interaction.deferReply({ ephemeral: true });
        const ticket = await ticketFromInteraction(interaction, target);
        await closeTicket(ticket, interaction.user, interaction.fields.getTextInputValue("reason"));
        await interaction.editReply("Ticket closed and its transcript was logged.");
        return true;
      }
      await interaction.deferReply({ ephemeral: true });
      const ticket = await ticketFromInteraction(interaction, target);
      if (action === "claim" && interaction.isButton()) {
        const claimed = await claimTicket(ticket, interaction.user);
        await interaction.editReply(`You claimed modmail #${claimed.ticketNumber}.`);
      } else if (action === "preset" && interaction.isButton()) {
        if (ticket.claimedByDiscordId !== interaction.user.id) throw new Error("Claim this ticket before sending a preset reply.");
        const presets = (cachedConfig.presets || []).filter(item => !item.teamId || item.teamId === ticket.teamId).slice(0, 25);
        if (!presets.length) throw new Error("No preset replies are configured for this team.");
        const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}:send:${ticket.id}`).setPlaceholder("Choose a preset reply").addOptions(presets.map(item => ({ label: item.label.slice(0, 100), value: item.id })));
        await interaction.editReply({ content: "Choose the reply to send:", components: [new ActionRowBuilder().addComponents(select)] });
      } else if (action === "send" && interaction.isStringSelectMenu()) {
        await sendPreset(ticket, interaction.values[0], interaction.user);
        await interaction.editReply({ content: "Preset reply sent.", components: [] });
      } else if (action === "transfer" && interaction.isButton()) {
        const teams = (cachedConfig.teams || []).filter(team => team.id !== ticket.teamId).slice(0, 25);
        if (!teams.length) throw new Error("No other support teams are configured.");
        const select = new StringSelectMenuBuilder().setCustomId(`${PREFIX}:move:${ticket.id}`).setPlaceholder("Choose the new support team").addOptions(teams.map(team => ({ label: team.name.slice(0, 100), value: team.id, description: (team.description || "Transfer ticket").slice(0, 100) })));
        await interaction.editReply({ content: "Transfer this ticket to:", components: [new ActionRowBuilder().addComponents(select)] });
      } else if (action === "move" && interaction.isStringSelectMenu()) {
        const moved = await transferTicket(ticket, interaction.values[0], interaction.user);
        await interaction.editReply({ content: `Ticket #${moved.ticketNumber} transferred and unclaimed.`, components: [] });
      }
      return true;
    } catch (error) {
      logger.warn(`Modmail interaction failed: ${error.message}`);
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: error.message, components: [] }).catch(() => null);
      else await interaction.reply({ content: error.message, ephemeral: interaction.inGuild() }).catch(() => null);
      return true;
    }
  }

  async function handleMessage(message) {
    if (message.author.bot) return;
    try {
      if (message.channel.type === ChannelType.DM) await handleDirectMessage(message);
      else await handleStaffMessage(message);
    } catch (error) {
      logger.error(`Modmail message failed: ${error.stack || error.message}`);
      await message.reply("I couldn't process that modmail message. Please try again shortly.").catch(() => null);
    }
  }

  async function processPendingActions() {
    if (pollingActions) return;
    pollingActions = true;
    try {
      const { actions = [] } = await api.pendingActions();
      for (const action of actions) {
        try {
          const { ticket } = await api.transcript(action.ticketId);
          const actor = { id: action.requestedByDiscordId, tag: action.requestedByName, username: action.requestedByName };
          if (action.action === "claim") await claimTicket(ticket, actor);
          else if (action.action === "transfer") await transferTicket(ticket, action.payload?.teamId, actor);
          else if (action.action === "close") await closeTicket(ticket, actor, action.payload?.reason || "Closed from the Hub");
          else throw new Error("Unknown dashboard action.");
          await api.completeAction(action.id, "Completed", "Applied by the main-server bot.");
        } catch (error) {
          await api.completeAction(action.id, "Failed", error.message).catch(() => null);
        }
      }
    } catch (error) {
      logger.warn(`Could not poll dashboard modmail actions: ${error.message}`);
    } finally {
      pollingActions = false;
    }
  }

  return { closeTicket, getConfig, handleInteraction, handleMessage, processPendingActions };
}

module.exports = { createModmail, messagePayload, safeChannelName, transcriptText };
