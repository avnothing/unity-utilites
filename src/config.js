function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function discordId(value, name) {
  if (!/^\d{17,20}$/.test(value)) throw new Error(`${name} must be a valid Discord ID.`);
  return value;
}

function webUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} must use HTTP or HTTPS.`);
  return parsed.toString().replace(/\/$/, "");
}

function loadConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
  return {
    token: required(env, "DISCORD_TOKEN"),
    clientId: discordId(required(env, "DISCORD_CLIENT_ID"), "DISCORD_CLIENT_ID"),
    guildId: discordId(required(env, "MAIN_GUILD_ID"), "MAIN_GUILD_ID"),
    portalUrl: webUrl(required(env, "PORTAL_URL"), "PORTAL_URL"),
    botApiSecret: required(env, "BOT_API_SECRET"),
    port
  };
}

module.exports = { loadConfig };
