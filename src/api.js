class HubApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HubApiError";
    this.status = status;
  }
}

function createHubApi({ portalUrl, botApiSecret }) {
  async function request(path, { method = "GET", body } = {}) {
    const response = await fetch(new URL(path, portalUrl), {
      method,
      headers: {
        Authorization: `Bearer ${botApiSecret}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : { error: `The Hub returned HTTP ${response.status}.` };
    if (!response.ok) throw new HubApiError(data.error || "The Hub request failed.", response.status);
    return data;
  }

  return {
    publishCatalogue: payload => request("/api/bot/main/catalogue", { method: "POST", body: payload }),
    config: () => request("/api/bot/main/config"),
    roleSyncAll: () => request("/api/bot/main/role-sync"),
    roleSyncMember: discordId => request(`/api/bot/main/role-sync/${encodeURIComponent(discordId)}`),
    openTicket: discordId => request(`/api/bot/main/tickets/open/${encodeURIComponent(discordId)}`),
    channelTicket: channelId => request(`/api/bot/main/tickets/channel/${encodeURIComponent(channelId)}`),
    ticketByNumber: ticketNumber => request(`/api/bot/main/tickets/number/${encodeURIComponent(ticketNumber)}`),
    createTicket: payload => request("/api/bot/main/tickets", { method: "POST", body: payload }),
    updateTicket: (ticketId, payload) => request(`/api/bot/main/tickets/${encodeURIComponent(ticketId)}`, { method: "PATCH", body: payload }),
    saveMessage: (ticketId, payload) => request(`/api/bot/main/tickets/${encodeURIComponent(ticketId)}/messages`, { method: "POST", body: payload }),
    transcript: ticketId => request(`/api/bot/main/tickets/${encodeURIComponent(ticketId)}/transcript`),
    pendingActions: () => request("/api/bot/main/actions"),
    completeAction: (actionId, status, result) => request(`/api/bot/main/actions/${encodeURIComponent(actionId)}`, { method: "PATCH", body: { status, result } })
  };
}

module.exports = { HubApiError, createHubApi };
