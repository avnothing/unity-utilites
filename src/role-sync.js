function roleChanges(currentRoleIds, targetRoleIds, managedRoleIds) {
  const current = new Set((currentRoleIds || []).map(String));
  const target = new Set((targetRoleIds || []).map(String));
  const managed = new Set((managedRoleIds || []).map(String));
  return {
    add: [...target].filter(roleId => managed.has(roleId) && !current.has(roleId)),
    remove: [...managed].filter(roleId => current.has(roleId) && !target.has(roleId))
  };
}

async function reconcileMemberRoles(member, syncTarget, reason = "Unity Airlines staff role sync") {
  const changes = roleChanges(
    [...member.roles.cache.keys()],
    syncTarget?.targetRoleIds || [],
    syncTarget?.managedRoleIds || []
  );
  const editable = roleId => member.guild.roles.cache.get(roleId)?.editable;
  const add = changes.add.filter(editable);
  const remove = changes.remove.filter(editable);
  if (remove.length) await member.roles.remove(remove, reason);
  if (add.length) await member.roles.add(add, reason);
  return {
    added: add,
    removed: remove,
    skipped: [...changes.add, ...changes.remove].filter(roleId => !editable(roleId))
  };
}

function createRoleSync({ guild, api, logger = console }) {
  let running = false;

  async function syncMember(member) {
    if (!member || member.user?.bot) return null;
    const target = await api.roleSyncMember(member.id);
    return reconcileMemberRoles(member, target);
  }

  async function syncAll() {
    if (running) return { skipped: true };
    running = true;
    try {
      const payload = await api.roleSyncAll();
      const linked = new Map((payload.members || []).map(item => [String(item.discordUserId), item]));
      const members = await guild.members.fetch();
      let changed = 0;
      let failures = 0;
      for (const member of members.values()) {
        if (member.user.bot) continue;
        const target = linked.get(member.id) || {
          linked: false,
          staff: false,
          targetRoleIds: payload.fallbackRoleIds || [],
          managedRoleIds: payload.managedRoleIds || []
        };
        try {
          const result = await reconcileMemberRoles(member, target);
          if (result.added.length || result.removed.length) changed += 1;
        } catch (error) {
          failures += 1;
          logger.warn(`Could not sync roles for ${member.user.tag}: ${error.message}`);
        }
      }
      logger.info(`Main-server role sync checked ${members.size} members; ${changed} changed, ${failures} failed.`);
      return { checked: members.size, changed, failures };
    } finally {
      running = false;
    }
  }

  return { syncMember, syncAll };
}

module.exports = { createRoleSync, reconcileMemberRoles, roleChanges };
