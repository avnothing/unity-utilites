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
const path = require("node:path");

const PREFIX = "unity-modmail";
const SUPPORT_EMOJI_ID = "1532706319889600672";
const BRAND_GREEN = 0x0a8f5b;
const SUPPORT_BANNER_FILE = path.join(__dirname, "..", "assets", "support-banner.png");
const TEAM_EMOJI_IDS = {
  "public relations": "1533033769144029334",
  "general support": "1533033753793007647",
  "human resources": "1533033756577890394"
};
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
  const closeTimers = new Map();

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

  function teamEmoji(team) {
    const id = TEAM_EMOJI_IDS[String(team?.name || "").trim().toLowerCase()];
    return id ? { id } : (team?.emoji || { id: SUPPORT_EMOJI_ID });
  }

  function ticketTemplateValues(ticket, values = {}) {
    const team = teamById(ticket?.teamId);
    const normalized = {
      "ticket type": team?.name || "General Support",
      "ticket number": ticket?.ticketNumber ? String(ticket.ticketNumber) : "",
      user: ticket?.discordUsername || "Customer",
      "user id": ticket?.discordUserId || "",
      "staff name": "Unity Airlines Support",
      "staff rank": "Support Team",
      message: "",
      reason: "",
      "close time": "",
      ...values
    };
    return Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key.toLowerCase(), String(value ?? "")]));
  }

  function renderTemplate(template, values, fallback) {
    const source = String(template || fallback || "");
    return source.replace(/\[([^\]]+)\]/g, (token, key) => values[String(key).trim().toLowerCase()] ?? token);
  }

  function staffRank(member) {
    const roles = member?.roles?.cache ? [...member.roles.cache.values()] : [];
    return roles
      .filter(role => role.id !== guild.roles.everyone.id && !role.managed)
      .sort((left, right) => right.position - left.position)[0]?.name || "Unity Airlines Staff";
  }

  function hasTeamAccess(member, ticket, channel = null) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    const team = teamById(ticket.teamId);
    if (team && (team.staffRoleIds || []).some(roleId => member.roles.cache.has(roleId))) return true;
    return Boolean(
      channel &&
      channel.permissionOverwrites?.cache?.has(member.id) &&
      channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    );
  }

  function isConfiguredSupportStaff(member) {
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    const supportRoleIds = new Set((cachedConfig.teams || []).flatMap(team => team.staffRoleIds || []));
    return [...supportRoleIds].some(roleId => member.roles.cache.has(roleId));
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
    Object.assign(ticket, updated.ticket);
    const embed = new EmbedBuilder()
      .setColor(BRAND_GREEN)
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

  function ticketOpenedEmbed(ticket) {
    const values = ticketTemplateValues(ticket);
    return new EmbedBuilder()
      .setColor(BRAND_GREEN)
      .setTitle(renderTemplate(cachedConfig.settings?.ticketOpenedTitle, values, "Support ticket #[ticket number] opened"))
      .setDescription(renderTemplate(cachedConfig.settings?.ticketOpenedMessage, values, "Your message has been sent to **[ticket type]**. Reply in this direct message at any time to continue the conversation."))
      .setFooter({ text: "Unity Airlines Support" })
      .setTimestamp();
  }

  function customerTicketControls(ticket) {
    if (!cachedConfig.settings?.allowCustomerClose) return [];
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}:user-close:${ticket.id}`).setLabel("Close this ticket").setStyle(ButtonStyle.Danger)
    )];
  }

  async function sendUserMessageToStaff(ticket, message) {
    const channel = await ensureChannel(ticket);
    const attachments = attachmentList([...message.attachments.values()]);
    const embed = new EmbedBuilder()
      .setColor(BRAND_GREEN)
      .setAuthor({ name: message.author.tag || message.author.username, iconURL: message.author.displayAvatarURL() })
      .setDescription(message.content || "*Attachment only*")
      .setFooter({ text: `User → Staff · ${message.author.id}` })
      .setTimestamp(message.createdAt);
    if (attachments.length) embed.addFields({ name: "Attachments", value: attachments.map(item => `[${item.name}](${item.url})`).join("\n").slice(0, 1024) });
    await channel.send({ embeds: [embed] });
    await api.saveMessage(ticket.id, messagePayload(message, "User to Staff"));
  }

  async function openForMessage(message, teamId = null, { notify = true } = {}) {
    const created = await api.createTicket({
      discordUserId: message.author.id,
      discordUsername: message.author.tag || message.author.username,
      teamId
    });
    const ticket = created.ticket;
    await sendUserMessageToStaff(ticket, message);
    if (notify) await message.author.send({ embeds: [ticketOpenedEmbed(ticket)], components: customerTicketControls(ticket) });
    return ticket;
  }

  async function promptForTeam(message) {
    const config = await getConfig();
    const teams = (config.teams || []).slice(0, 25);
    if (!teams.length) return openForMessage(message, null);
    pendingMessages.set(message.author.id, message);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`${PREFIX}:new:${message.author.id}`)
      .setPlaceholder("Choose a support team")
      .addOptions(teams.map(team => ({
        label: team.name.slice(0, 100),
        value: team.id,
        description: (team.description || `Contact ${team.name}`).slice(0, 100),
        emoji: teamEmoji(team)
      })));
    const values = ticketTemplateValues(null, { "ticket type": "Support" });
    await message.author.send({
      embeds: [new EmbedBuilder()
        .setColor(BRAND_GREEN)
        .setTitle(renderTemplate(config.settings?.supportPanelTitle, values, "Unity Airlines Support"))
        .setDescription(renderTemplate(config.settings?.welcomeMessage, values, "Welcome to Unity Airlines Support. Choose the team that can best help you."))
        .addFields({ name: "Choose a support team", value: "Use the menu below to send your message to the right team, such as Public Relations, Human Resources or General Support." })
        .setImage("attachment://support-banner.png")
        .setFooter({ text: "Your ticket is private and visible only to the assigned support team." })],
      components: [new ActionRowBuilder().addComponents(select)],
      files: [new AttachmentBuilder(SUPPORT_BANNER_FILE, { name: "support-banner.png" })]
    });
  }

  async function handleDirectMessage(message) {
    await message.react(SUPPORT_EMOJI_ID).catch(() => message.react("📩").catch(() => null));
    const existing = await api.openTicket(message.author.id);
    if (existing.ticket) {
      const ticket = await cancelCloseDelayForCustomerReply(existing.ticket, message.author);
      return sendUserMessageToStaff(ticket, message);
    }
    if (pendingMessages.has(message.author.id)) {
      pendingMessages.set(message.author.id, message);
      return;
    }
    return promptForTeam(message);
  }

  async function handleStaffMessage(message) {
    if (message.guildId !== guild.id) return;
    const result = await api.channelTicket(message.channelId);
    const ticket = result.ticket;
    if (!ticket) return;
    await getConfig();
    if (!hasTeamAccess(message.member, ticket, message.channel)) return message.reply("You are not part of the support team assigned to this ticket.");
    if (!ticket.claimedByDiscordId) return message.reply("Claim this ticket before replying to the user.");
    if (ticket.claimedByDiscordId !== message.author.id) return message.reply(`This ticket is claimed by **${ticket.claimedByName || "another staff member"}**.`);
    const attachments = attachmentList([...message.attachments.values()]);
    await sendStaffReply(ticket, message.member, message.author, message.content || "", attachments);
    await api.saveMessage(ticket.id, messagePayload(message, "Staff to User"));
    await message.react("✅").catch(() => null);
  }

  async function sendStaffReply(ticket, member, actor, content, attachments = []) {
    await getConfig();
    const staffName = member?.displayName || actor.globalName || actor.username;
    const rank = staffRank(member);
    const values = ticketTemplateValues(ticket, {
      "staff name": staffName,
      "staff rank": rank,
      message: content || "*Attachment only*"
    });
    const embed = new EmbedBuilder()
      .setColor(BRAND_GREEN)
      .setAuthor({ name: staffName, iconURL: actor.displayAvatarURL?.() })
      .setTitle(renderTemplate(cachedConfig.settings?.staffReplyTitle, values, "Unity Airlines Support"))
      .setDescription(renderTemplate(cachedConfig.settings?.staffReplyMessage, values, "[message]").slice(0, 4096))
      .setFooter({ text: `Rank · ${rank}` })
      .setTimestamp();
    if (attachments.length) embed.addFields({ name: "Attachments", value: attachments.map(item => `[${item.name}](${item.url})`).join("\n").slice(0, 1024) });
    const user = await client.users.fetch(ticket.discordUserId);
    await user.send({ embeds: [embed] });
  }

  async function claimTicket(ticket, actor, accessChannel = null) {
    const member = await guild.members.fetch(actor.id).catch(() => null);
    await getConfig();
    if (!hasTeamAccess(member, ticket, accessChannel)) throw new Error("You are not part of the support team assigned to this ticket.");
    const result = await api.updateTicket(ticket.id, {
      action: "claim",
      discordActorId: actor.id,
      actorName: actor.tag || actor.username
    });
    const ticketChannel = await ensureChannel(result.ticket);
    await ticketChannel.send(`🔒 Ticket claimed by <@${actor.id}>.`);
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
    const member = await guild.members.fetch(actor.id).catch(() => null);
    await sendStaffReply(ticket, member, actor, preset.message);
    await api.saveMessage(ticket.id, { direction: "Staff to User", authorDiscordId: actor.id, authorName: actor.tag || actor.username, content: preset.message });
    const channel = await ensureChannel(ticket);
    await channel.send(`📨 **${actor.tag || actor.username}** sent preset **${preset.label}**:\n${preset.message}`);
  }

  function closeDelayTimestamp(ticket) {
    return Math.floor(new Date(ticket.closeDelayAt).getTime() / 1000);
  }

  async function startCloseDelay(ticket, actor) {
    const result = await api.updateTicket(ticket.id, {
      action: "close-delay",
      discordActorId: actor.id,
      actorName: actor.tag || actor.username || "Staff"
    });
    const delayed = result.ticket;
    const closeAt = closeDelayTimestamp(delayed);
    const config = await getConfig();
    const user = await client.users.fetch(delayed.discordUserId).catch(() => null);
    if (user) {
      const values = ticketTemplateValues(delayed, { "close time": `<t:${closeAt}:F>` });
      await user.send({
        embeds: [new EmbedBuilder()
          .setColor(BRAND_GREEN)
          .setTitle(renderTemplate(config.settings?.closeDelayTitle, values, "Your support ticket will close soon"))
          .setDescription(renderTemplate(config.settings?.closeDelayMessage, values, "We have not heard from you. This ticket will automatically close in six hours unless you reply."))
          .addFields({ name: "Automatic closure", value: `<t:${closeAt}:F>`, inline: true })
          .setFooter({ text: "Reply in this direct message to keep the ticket open." })]
      }).catch(() => null);
    }
    const channel = await ensureChannel(delayed);
    await channel.send(`⏳ <@${actor.id}> started a close delay. This ticket will close <t:${closeAt}:F> unless the customer replies.`);
    await api.saveMessage(delayed.id, {
      direction: "System",
      authorDiscordId: actor.id,
      authorName: actor.tag || actor.username || "Staff",
      content: `Close delay started; automatic closure is scheduled for ${delayed.closeDelayAt}.`
    });
    return delayed;
  }

  async function cancelCloseDelayForCustomerReply(ticket, user) {
    if (!ticket.closeDelayAt) return ticket;
    const result = await api.updateTicket(ticket.id, { action: "cancel-close-delay" });
    const active = result.ticket;
    await user.send({
      embeds: [new EmbedBuilder()
        .setColor(BRAND_GREEN)
        .setTitle("Ticket closure cancelled")
        .setDescription("Your reply has been received, so the scheduled ticket closure has been cancelled. A staff member will continue to help you shortly.")
        .setFooter({ text: "Unity Airlines Support" })
        .setTimestamp()]
    }).catch(() => null);
    const channel = await ensureChannel(active);
    await channel.send("↩️ The customer replied, so the scheduled close was cancelled.");
    await api.saveMessage(active.id, {
      direction: "System",
      authorDiscordId: user.id,
      authorName: user.tag || user.username || "Customer",
      content: "Close delay cancelled because the customer replied."
    });
    return active;
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
    if (user) {
      const values = ticketTemplateValues(ticket, { reason });
      await user.send({ embeds: [new EmbedBuilder()
        .setColor(BRAND_GREEN)
        .setTitle(renderTemplate(config.settings?.closedTitle, values, "Your support ticket has been closed"))
        .setDescription(renderTemplate(config.settings?.closedMessage, values, "Your Unity Airlines support ticket has been closed."))
        .addFields({ name: "Reason", value: reason.slice(0, 1024) })
        .setFooter({ text: "Unity Airlines Support" })
        .setTimestamp()] }).catch(() => null);
    }
    const transcript = await api.transcript(ticket.id);
    const text = transcriptText(transcript.ticket, transcript.messages);
    const logChannelId = config.settings?.logChannelId;
    const logChannel = logChannelId ? await guild.channels.fetch(logChannelId).catch(() => null) : null;
    if (logChannel?.isTextBased()) {
      const file = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `modmail-${ticket.ticketNumber}.txt` });
      const embed = new EmbedBuilder()
        .setColor(BRAND_GREEN)
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
      const timer = setTimeout(() => {
        closeTimers.delete(ticket.id);
        channel.delete(`Modmail #${ticket.ticketNumber} closed`).catch(() => null);
      }, 10_000);
      timer.unref?.();
      closeTimers.set(ticket.id, timer);
    }
    return result.ticket;
  }

  async function closeForMemberLeave(member) {
    const { ticket } = await api.openTicket(member.id);
    if (!ticket) return false;
    await closeTicket(ticket, {
      id: client.user.id,
      tag: client.user.tag,
      username: client.user.username
    }, "Closed automatically because the customer left the main server.");
    return true;
  }

  async function reopenTicket(ticket, actor) {
    const pendingDelete = closeTimers.get(ticket.id);
    if (pendingDelete) clearTimeout(pendingDelete);
    closeTimers.delete(ticket.id);
    const result = await api.updateTicket(ticket.id, {
      action: "reopen",
      discordActorId: actor.id,
      actorName: actor.tag || actor.username || "Hub staff"
    });
    const channel = await ensureChannel(result.ticket);
    await channel.setName(safeChannelName(result.ticket)).catch(() => null);
    await channel.send({ content: `🔓 Ticket reopened by <@${actor.id}>. It is unclaimed.`, components: [ticketControls(ticket.id)] });
    await api.saveMessage(ticket.id, {
      direction: "System",
      authorDiscordId: actor.id,
      authorName: actor.tag || actor.username || "Hub staff",
      content: "Ticket reopened."
    });
    const user = await client.users.fetch(ticket.discordUserId).catch(() => null);
    if (user) await user.send(`Your Unity Airlines support ticket **#${ticket.ticketNumber}** has been reopened. Reply here to continue.`).catch(() => null);
    return result.ticket;
  }

  async function ticketFromInteraction(interaction, ticketId) {
    const result = await api.transcript(ticketId);
    const ticket = result.ticket;
    if (!ticket || ticket.status !== "Open") throw new Error("This ticket is already closed.");
    const member = interaction.member || await guild.members.fetch(interaction.user.id).catch(() => null);
    await getConfig();
    if (!hasTeamAccess(member, ticket, interaction.channel)) throw new Error("You are not part of the support team assigned to this ticket.");
    return ticket;
  }

  async function ticketForChannel(interaction) {
    const { ticket } = await api.channelTicket(interaction.channelId);
    if (!ticket) throw new Error("Use this command inside an open modmail ticket channel.");
    await getConfig();
    const member = interaction.member || await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!hasTeamAccess(member, ticket, interaction.channel)) throw new Error("You are not part of the support team assigned to this ticket.");
    return ticket;
  }

  async function handleTicketCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });
    try {
      await getConfig();
      const commandMember = interaction.member || await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!isConfiguredSupportStaff(commandMember)) throw new Error("Only configured Unity Airlines support staff can use ticket commands.");
      if (subcommand === "reopen") {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) throw new Error("You need Manage Messages to reopen tickets.");
        const ticketNumber = interaction.options.getInteger("ticket_number", true);
        const { ticket } = await api.ticketByNumber(ticketNumber);
        if (!ticket) throw new Error(`Modmail #${ticketNumber} was not found.`);
        if (ticket.status !== "Closed") throw new Error(`Modmail #${ticketNumber} is already open.`);
        const reopened = await reopenTicket(ticket, interaction.user);
        await interaction.editReply(`Modmail #${reopened.ticketNumber} was reopened and is unclaimed.`);
        return true;
      }

      const ticket = await ticketForChannel(interaction);
      if (subcommand === "claim") {
        const claimed = await claimTicket(ticket, interaction.user, interaction.channel);
        await interaction.editReply(`You claimed modmail #${claimed.ticketNumber}.`);
      } else if (subcommand === "close") {
        const reason = interaction.options.getString("reason", true);
        await closeTicket(ticket, interaction.user, reason);
        await interaction.editReply("Ticket closed and its transcript was logged.");
      } else if (subcommand === "close-delay") {
        const delayed = await startCloseDelay(ticket, interaction.user);
        await interaction.editReply(`Modmail #${delayed.ticketNumber} will close <t:${closeDelayTimestamp(delayed)}:R> unless the customer replies.`);
      } else if (subcommand === "note") {
        const note = interaction.options.getString("note", true).trim();
        const member = interaction.member || await guild.members.fetch(interaction.user.id).catch(() => null);
        const rank = staffRank(member);
        await interaction.channel.send({ embeds: [new EmbedBuilder()
          .setColor(BRAND_GREEN)
          .setAuthor({ name: member?.displayName || interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
          .setTitle("Private staff note")
          .setDescription(note)
          .setFooter({ text: `Private note · ${rank}` })
          .setTimestamp()] });
        await api.saveMessage(ticket.id, {
          direction: "System",
          authorDiscordId: interaction.user.id,
          authorName: interaction.user.tag || interaction.user.username,
          content: `Private staff note: ${note}`
        });
        await interaction.editReply("Private note added to this ticket. It was not sent to the customer.");
      } else if (subcommand === "transfer") {
        const moved = await transferTicket(ticket, interaction.options.getString("team", true), interaction.user);
        await interaction.editReply(`Modmail #${moved.ticketNumber} was transferred and is now unclaimed.`);
      } else if (subcommand === "add") {
        const user = interaction.options.getUser("staff_member", true);
        const member = await guild.members.fetch(user.id).catch(() => null);
        if (!member || member.user.bot) throw new Error("Choose a non-bot member of this server.");
        await interaction.channel.permissionOverwrites.edit(member.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
          AttachFiles: true,
          EmbedLinks: true
        }, { reason: `Added to modmail #${ticket.ticketNumber} by ${interaction.user.tag}` });
        await interaction.channel.send(`➕ <@${member.id}> was added to this ticket by <@${interaction.user.id}>.`);
        await api.saveMessage(ticket.id, { direction: "System", authorDiscordId: interaction.user.id, authorName: interaction.user.tag, content: `${member.user.tag} was added to the ticket.` });
        await interaction.editReply(`${member.user.tag} can now access this ticket.`);
      } else if (subcommand === "user") {
        const team = teamById(ticket.teamId);
        const embed = new EmbedBuilder()
          .setColor(BRAND_GREEN)
          .setTitle(`Customer · Modmail #${ticket.ticketNumber}`)
          .addFields(
            { name: "Discord", value: `${ticket.discordUsername}\n<@${ticket.discordUserId}>\n\`${ticket.discordUserId}\`` },
            { name: "Support team", value: team?.name || "General", inline: true },
            { name: "Claimed by", value: ticket.claimedByName || "Unclaimed", inline: true },
            { name: "Opened", value: `<t:${Math.floor(new Date(ticket.openedAt).getTime() / 1000)}:F>` }
          );
        await interaction.editReply({ embeds: [embed] });
      } else if (subcommand === "transcript") {
        const detail = await api.transcript(ticket.id);
        const text = transcriptText(detail.ticket, detail.messages);
        if (Buffer.byteLength(text, "utf8") > 7_500_000) throw new Error("This transcript is too large for Discord. Download it from the Hub dashboard instead.");
        const file = new AttachmentBuilder(Buffer.from(text, "utf8"), { name: `modmail-${ticket.ticketNumber}.txt` });
        await interaction.editReply({ content: `Transcript for modmail #${ticket.ticketNumber}:`, files: [file] });
      }
      return true;
    } catch (error) {
      logger.warn(`Ticket command failed: ${error.message}`);
      await interaction.editReply(error.message).catch(() => null);
      return true;
    }
  }

  async function handleAutocomplete(interaction) {
    if (!interaction.isAutocomplete() || interaction.commandName !== "ticket") return false;
    const focused = interaction.options.getFocused().toLowerCase();
    try {
      await getConfig();
      const choices = (cachedConfig.teams || [])
        .filter(team => team.name.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(team => ({ name: team.name.slice(0, 100), value: team.id }));
      await interaction.respond(choices);
    } catch (_) {
      await interaction.respond([]).catch(() => null);
    }
    return true;
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
        const ticket = await openForMessage(message, interaction.values[0], { notify: false });
        await interaction.editReply({ embeds: [ticketOpenedEmbed(ticket)], components: customerTicketControls(ticket), attachments: [] });
        return true;
      }
      if (action === "user-close" && interaction.isButton()) {
        await getConfig();
        if (!cachedConfig.settings?.allowCustomerClose) throw new Error("Customer ticket closing is disabled.");
        const { ticket } = await api.transcript(target);
        if (!ticket || ticket.status !== "Open") throw new Error("This ticket is already closed.");
        if (interaction.user.id !== ticket.discordUserId) throw new Error("Only the customer who opened this ticket can close it.");
        await interaction.deferUpdate();
        await closeTicket(ticket, interaction.user, "Closed by the customer.");
        await interaction.editReply({ content: "Your ticket has been closed.", embeds: [], components: [] });
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
        const claimed = await claimTicket(ticket, interaction.user, interaction.channel);
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
      const { tickets: dueCloseDelays = [] } = await api.dueCloseDelays();
      for (const ticket of dueCloseDelays) {
        await closeTicket(ticket, {
          id: client.user.id,
          tag: client.user.tag,
          username: client.user.username
        }, "Automatically closed after six hours without a customer reply.").catch(error => logger.warn(`Could not apply close delay for #${ticket.ticketNumber}: ${error.message}`));
      }
      const { actions = [] } = await api.pendingActions();
      for (const action of actions) {
        try {
          const { ticket } = await api.transcript(action.ticketId);
          const actor = { id: action.requestedByDiscordId, tag: action.requestedByName, username: action.requestedByName };
          if (action.action === "claim") await claimTicket(ticket, actor);
          else if (action.action === "transfer") await transferTicket(ticket, action.payload?.teamId, actor);
          else if (action.action === "close") await closeTicket(ticket, actor, action.payload?.reason || "Closed from the Hub");
          else if (action.action === "close-delay") await startCloseDelay(ticket, actor);
          else if (action.action === "reopen") await reopenTicket(ticket, actor);
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

  return { closeForMemberLeave, closeTicket, getConfig, handleAutocomplete, handleInteraction, handleMessage, handleTicketCommand, processPendingActions, reopenTicket };
}

module.exports = { createModmail, messagePayload, safeChannelName, transcriptText };
