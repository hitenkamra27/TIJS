const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');
require('dotenv').config();

// ─── Client Setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
});

const PREFIX = process.env.PREFIX || '!';

// ─── Status System ────────────────────────────────────────────────────────────
//
// Behaviour:
//   • 0 statuses  → no activity set
//   • 1 status    → shown permanently, never rotated (stays until you change it)
//   • 2+ statuses → rotate on an interval forever
//
// STATUS_DELAY in .env = ms between rotations (default: 30000 = 30s)

// Default statuses — owner can add/remove/clear via commands
const statusList = [
  { text: `${process.env.PREFIX || '!'}help | Multipurpose Bot`, type: 'PLAYING' },
];

let statusIndex = 0;
let statusInterval = null;

// How long each status shows when rotating (ms). Default 30 seconds.
const STATUS_DELAY = parseInt(process.env.STATUS_DELAY) || 30000;

const ActivityTypeMap = {
  PLAYING:   0,
  STREAMING: 1,
  LISTENING: 2,
  WATCHING:  3,
  COMPETING: 5,
};

/** Apply the status at the current index without advancing it. */
function applyCurrentStatus() {
  if (!statusList.length) return;
  const s = statusList[statusIndex % statusList.length];
  client.user.setActivity(s.text, { type: ActivityTypeMap[s.type] ?? 0 });
}

/** Advance to the next status and apply it. Called by the rotation interval. */
function rotateStatus() {
  if (!statusList.length) return;
  statusIndex = (statusIndex + 1) % statusList.length;
  applyCurrentStatus();
}

/**
 * Start (or restart) the status system:
 *  - 0 statuses  → clear activity, stop any interval
 *  - 1 status    → apply immediately, NO interval (stays forever)
 *  - 2+ statuses → apply immediately, rotate on interval forever
 */
function startStatusSystem() {
  // Clear any existing rotation first
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }

  if (!statusList.length) {
    client.user?.setActivity(null);
    return;
  }

  // Show current status immediately
  applyCurrentStatus();

  // Only start rotation if there are multiple statuses
  if (statusList.length > 1) {
    statusInterval = setInterval(rotateStatus, STATUS_DELAY);
  }
  // Single status: no interval — it stays on screen forever
}

function stopSlideshow() {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
}

// ─── Global Error Handlers ────────────────────────────────────────────────────
process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function missingPerm(message, perm) {
  return message.reply(`❌ You need the **${perm}** permission to use this command.`);
}

function botMissingPerm(message, perm) {
  return message.reply(`❌ I need the **${perm}** permission to do that.`);
}

function parseDuration(str) {
  const match = str?.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const units = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(match[1]) * units[match[2].toLowerCase()];
}

function formatDuration(ms) {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h`;
  return `${Math.floor(ms / 86400000)}d`;
}

function successEmbed(title, desc) {
  return new EmbedBuilder().setColor('#57F287').setTitle(`✅ ${title}`).setDescription(desc).setTimestamp();
}

function errorEmbed(desc) {
  return new EmbedBuilder().setColor('#ED4245').setTitle('❌ Error').setDescription(desc).setTimestamp();
}

function infoEmbed(title, desc) {
  return new EmbedBuilder().setColor('#5865F2').setTitle(title).setDescription(desc).setTimestamp();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`✅ ${client.user.username} is online!`);
  console.log(`📡 Serving ${client.guilds.cache.size} server(s)`);
  // FIX: Fetch application info so client.application.owner is populated
  // Without this, the owner check in status commands always fails
  await client.application.fetch().catch((err) => {
    console.warn('⚠️ Could not fetch application info (owner checks may fail):', err.message);
  });
  startStatusSystem();
});

// ─── Welcome System ───────────────────────────────────────────────────────────
//
// Per-guild config stored in welcomeSettings[guildId].
// Supports:
//   • Custom channel (set via button wizard)
//   • Embed OR plain text message
//   • Custom title, description, colour (embed mode)
//   • Auto-delete after N seconds (0 = never)
// Placeholders in title/description/text: {user}, {username}, {server}, {count}

const welcomeSettings = {};   // in-memory; replace with a DB for persistence

function getWelcomeSettings(guildId) {
  if (!welcomeSettings[guildId]) {
    welcomeSettings[guildId] = {
      enabled     : false,
      channelId   : null,
      mode        : 'embed',          // 'embed' | 'text'
      title       : '👋 Welcome to {server}!',
      description : 'Hey {user}, welcome to **{server}**! 🎉\nWe now have **{count}** members.\nMake sure to read the rules!',
      color       : '#57F287',
      text        : 'Welcome {user} to **{server}**! You are member #{count}.',
      deleteAfter : 0,                // seconds; 0 = never delete
      thumbnail   : true,             // show user avatar in embed
      footer      : 'Member #{count}',
    };
  }
  return welcomeSettings[guildId];
}

/** Replace placeholders with live values */
function resolvePlaceholders(str, member) {
  return str
    .replace(/{user}/g,     member.toString())
    .replace(/{username}/g, member.user.username)
    .replace(/{server}/g,   member.guild.name)
    .replace(/{count}/g,    member.guild.memberCount);
}

// ─── Welcome Panel Builder ─────────────────────────────────────────────────────

// Tracks the live control-panel message per guild so buttons can refresh it
const welcomePanelMessages = {};

/** Build the embed shown in the !welcomeset control panel */
function buildWelcomePanel(guild, cfg) {
  const channelDisplay = cfg.channelId
    ? `<#${cfg.channelId}>`
    : '`Not set`';

  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🎉 Welcome System — Control Panel')
    .setDescription(
      `Configure every aspect of the welcome message below.\n` +
      `Use the buttons to edit each setting. Changes save instantly.`
    )
    .addFields(
      { name: '🟢 Status',        value: cfg.enabled ? '✅ **Enabled**' : '❌ **Disabled**', inline: true },
      { name: '📢 Channel',       value: channelDisplay, inline: true },
      { name: '💬 Mode',          value: cfg.mode === 'embed' ? '📦 Embed' : '📝 Plain Text', inline: true },
      { name: '⏱️ Auto-Delete',   value: cfg.deleteAfter > 0 ? `${cfg.deleteAfter}s` : 'Never', inline: true },
      { name: '🖼️ Thumbnail',     value: cfg.thumbnail ? 'On' : 'Off', inline: true },
      { name: '​',           value: '​', inline: true },
    )
    .setTimestamp()
    .setFooter({ text: `${guild.name} • Welcome Settings` });

  if (cfg.mode === 'embed') {
    embed.addFields(
      { name: '📋 Embed Title',       value: `\`${cfg.title.slice(0, 80)}\``,       inline: false },
      { name: '📝 Embed Description', value: `\`\`\`${cfg.description.slice(0, 300)}\`\`\``, inline: false },
      { name: '🎨 Embed Color',       value: cfg.color, inline: true },
      { name: '📄 Embed Footer',      value: cfg.footer ? `\`${cfg.footer}\`` : '*(none)*', inline: true },
    );
  } else {
    embed.addFields(
      { name: '💬 Text Message', value: `\`\`\`${cfg.text.slice(0, 500)}\`\`\``, inline: false },
    );
  }

  embed.addFields({
    name: '📌 Placeholders',
    value: '`{user}` — mention  `{username}` — name  `{server}` — server name  `{count}` — member count',
  });

  return embed;
}

/** Build the button rows for the !welcomeset control panel */
function buildWelcomeRows(cfg) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('welcome:toggle')
      .setLabel(cfg.enabled ? '🔴 Disable' : '🟢 Enable')
      .setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('welcome:mode')
      .setLabel(cfg.mode === 'embed' ? '📝 Switch to Text' : '📦 Switch to Embed')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('welcome:preview')
      .setLabel('👁️ Preview')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('welcome:reset')
      .setLabel('🔄 Reset Defaults')
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('welcome:channel')
      .setLabel('📢 Set Channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('welcome:deletafter')
      .setLabel('⏱️ Auto-Delete Time')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('welcome:thumbnail')
      .setLabel(cfg.thumbnail ? '🖼️ Thumbnail: ON' : '🖼️ Thumbnail: OFF')
      .setStyle(cfg.thumbnail ? ButtonStyle.Success : ButtonStyle.Secondary),
  );

  // Embed-only buttons
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('welcome:title')
      .setLabel('📋 Title')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cfg.mode !== 'embed'),
    new ButtonBuilder()
      .setCustomId('welcome:description')
      .setLabel('📝 Description')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cfg.mode !== 'embed'),
    new ButtonBuilder()
      .setCustomId('welcome:color')
      .setLabel('🎨 Color')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cfg.mode !== 'embed'),
    new ButtonBuilder()
      .setCustomId('welcome:footer')
      .setLabel('📄 Footer')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cfg.mode !== 'embed'),
    new ButtonBuilder()
      .setCustomId('welcome:text')
      .setLabel('💬 Text Msg')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(cfg.mode !== 'text'),
  );

  return [row1, row2, row3];
}

client.on('guildMemberAdd', async (member) => {
  const cfg = getWelcomeSettings(member.guild.id);
  if (!cfg.enabled || !cfg.channelId) return;

  const channel = member.guild.channels.cache.get(cfg.channelId);
  if (!channel) return;

  let sentMsg;

  if (cfg.mode === 'embed') {
    const embed = new EmbedBuilder()
      .setColor(cfg.color || '#57F287')
      .setTitle(resolvePlaceholders(cfg.title, member))
      .setDescription(resolvePlaceholders(cfg.description, member))
      .setTimestamp();
    if (cfg.thumbnail) embed.setThumbnail(member.user.displayAvatarURL({ forceStatic: false }));
    if (cfg.footer)    embed.setFooter({ text: resolvePlaceholders(cfg.footer, member) });
    sentMsg = await channel.send({ embeds: [embed] });
  } else {
    sentMsg = await channel.send(resolvePlaceholders(cfg.text, member));
  }

  if (cfg.deleteAfter > 0) {
    setTimeout(() => sentMsg.delete().catch(() => {}), cfg.deleteAfter * 1000);
  }
});

// ─── Log Member Leave ─────────────────────────────────────────────────────────

client.on('guildMemberRemove', async (member) => {
  const logChannel = member.guild.channels.cache.find(
    (ch) => ch.name === 'logs' || ch.name === 'audit-log' || ch.name === 'mod-log'
  );
  if (!logChannel) return;

  const embed = new EmbedBuilder()
    .setColor('#ED4245')
    .setTitle('👋 Member Left')
    .setDescription(`**${(member.user.tag || member.user.username)}** has left the server.`)
    .setThumbnail(member.user.displayAvatarURL({ forceStatic: false }))
    .setTimestamp();

  logChannel.send({ embeds: [embed] });
});


// ─── Ticket System ────────────────────────────────────────────────────────────

// Stores open tickets: { channelId: { userId, guildId } }
const openTickets = {};

// Stores active setup wizards: { userId: { step, cfg, guildId, promptMsg } }
const setupSessions = {};

// Per-guild ticket settings: { guildId: { channelName, panelTitle, panelDesc, insideTitle, insideDesc, buttonLabel } }
const ticketSettings = {};

function getTicketSettings(guildId) {
  if (!ticketSettings[guildId]) {
    ticketSettings[guildId] = {
      channelName : 'ticket-{username}',
      panelTitle  : '🎫 Support Tickets',
      panelDesc   : 'Need help? Click the button below to open a private support ticket.\n\nA staff member will assist you as soon as possible.',
      buttonLabel : '🎫 Open a Ticket',
      insideTitle : '🎫 Ticket Opened',
      insideDesc  : 'Welcome {mention}, support will be with you shortly!\n\nPlease describe your issue and a staff member will assist you.',
    };
  }
  return ticketSettings[guildId];
}

client.on('interactionCreate', async (interaction) => {

  // ── Open Ticket Button ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    const guild   = interaction.guild;
    const member  = interaction.member;
    const cfg     = getTicketSettings(guild.id);

    // Check if user already has an open ticket
    const existing = Object.entries(openTickets).find(
      ([, t]) => t.userId === member.id && t.guildId === guild.id
    );
    if (existing) {
      return interaction.reply({
        embeds: [errorEmbed(`You already have an open ticket: <#${existing[0]}>`)],
        ephemeral: true,
      });
    }

    // Defer immediately — creating channels + setting permissions can exceed the 3s limit
    await interaction.deferReply({ ephemeral: true });

    // Find or create the Tickets category and place it at position 0 (top)
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'tickets'
    );
    if (!category) {
      category = await guild.channels.create({
        name    : 'Tickets',
        type    : ChannelType.GuildCategory,
        position: 0,
      });
    } else {
      // Move existing category to top if it isn't already
      if (category.position !== 0) await category.setPosition(0).catch(() => {});
    }

    // Resolve channel name (replace {username} placeholder)
    const chName = cfg.channelName.replace('{username}', member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, ''));

    // Create a private ticket channel
    const ticketChannel = await guild.channels.create({
      name: chName,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id  : guild.roles.everyone,
          deny: [PermissionsBitField.Flags.ViewChannel],
        },
        {
          id   : member.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id   : guild.members.me.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ],
    });

    // Give access to all staff roles (Manage Guild)
    const modRoles = guild.roles.cache.filter(
      (r) => r.permissions.has(PermissionsBitField.Flags.ManageGuild) && r.id !== guild.id
    );
    for (const [, role] of modRoles) {
      await ticketChannel.permissionOverwrites.edit(role, {
        ViewChannel      : true,
        SendMessages     : true,
        ReadMessageHistory: true,
      });
    }

    openTickets[ticketChannel.id] = { userId: member.id, guildId: guild.id };

    // Inside-ticket welcome message
    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('🔒 Close Ticket')
        .setStyle(ButtonStyle.Danger)
    );

    const insideDesc = cfg.insideDesc.replace('{mention}', member.toString());

    await ticketChannel.send({
      embeds: [
        new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle(cfg.insideTitle)
          .setDescription(insideDesc)
          .setFooter({ text: 'Click the button below to close this ticket.' })
          .setTimestamp(),
      ],
      components: [closeRow],
    });

    await interaction.editReply({
      embeds: [successEmbed('Ticket Created', `Your ticket has been opened: ${ticketChannel}`)],
    });
    return; // prevent fall-through to welcome/close handlers
  }

  // ── Close Ticket Button ─────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'close_ticket') {
    const channel = interaction.channel;
    const guild   = interaction.guild;
    const member  = interaction.member;

    const ticketData = openTickets[channel.id];
    const isStaff    = member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    const isOwner    = ticketData?.userId === member.id;

    if (!ticketData) {
      return interaction.reply({ embeds: [errorEmbed('This is not a ticket channel.')], ephemeral: true });
    }
    if (!isOwner && !isStaff) {
      return interaction.reply({ embeds: [errorEmbed('Only the ticket owner or staff can close this ticket.')], ephemeral: true });
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('🔒 Ticket Closing')
          .setDescription(`Ticket closed by ${member}. This channel will be deleted in **5 seconds**.`)
          .setTimestamp(),
      ],
    });

    delete openTickets[channel.id];
    setTimeout(async () => { await channel.delete().catch(() => {}); }, 5000);
    return; // prevent fall-through to welcome handlers
  }

  // ── Welcome Setup Button / Select Interactions ─────────────────────────────

  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const customId = interaction.customId || '';
  if (!customId.startsWith('welcome:')) return;

  // Only Manage Guild members may use these controls
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    return interaction.reply({ embeds: [errorEmbed('You need **Manage Server** permission.')], ephemeral: true });
  }

  const action = customId.split(':')[1];
  const wcfg   = getWelcomeSettings(interaction.guild.id);

  // Helper: refresh the main control panel after a setting changes
  async function refreshPanel() {
    const panelMsg = welcomePanelMessages[interaction.guild.id];
    if (panelMsg) {
      await panelMsg.edit({
        embeds    : [buildWelcomePanel(interaction.guild, wcfg)],
        components: buildWelcomeRows(wcfg),
      }).catch(() => {});
    }
  }

  // Helper: collect one text reply from the user
  function collectText(promptEmbed, timeMs, callback) {
    interaction.reply({ embeds: [promptEmbed], ephemeral: true });
    const collector = interaction.channel.createMessageCollector({
      filter: m => m.author.id === interaction.user.id && m.channel.id === interaction.channel.id,
      time: timeMs,
      max: 1,
    });
    collector.on('collect', async m => {
      const val = m.content;
      m.delete().catch(() => {});
      if (val.toLowerCase() === 'cancel') {
        return interaction.editReply({ embeds: [errorEmbed('Cancelled.')], components: [] });
      }
      await callback(val);
    });
    collector.on('end', collected => {
      if (!collected.size) interaction.editReply({ embeds: [errorEmbed('Timed out. Run `!welcomeset` again.')], components: [] }).catch(() => {});
    });
  }

  // ── Toggle enable ────────────────────────────────────────────────────────────
  if (action === 'toggle') {
    wcfg.enabled = !wcfg.enabled;
    return interaction.update({
      embeds    : [buildWelcomePanel(interaction.guild, wcfg)],
      components: buildWelcomeRows(wcfg),
    });
  }

  // ── Toggle mode (embed / text) ───────────────────────────────────────────────
  if (action === 'mode') {
    wcfg.mode = wcfg.mode === 'embed' ? 'text' : 'embed';
    return interaction.update({
      embeds    : [buildWelcomePanel(interaction.guild, wcfg)],
      components: buildWelcomeRows(wcfg),
    });
  }

  // ── Toggle thumbnail ─────────────────────────────────────────────────────────
  if (action === 'thumbnail') {
    wcfg.thumbnail = !wcfg.thumbnail;
    return interaction.update({
      embeds    : [buildWelcomePanel(interaction.guild, wcfg)],
      components: buildWelcomeRows(wcfg),
    });
  }

  // ── Set channel ──────────────────────────────────────────────────────────────
  if (action === 'channel') {
    const prompt = new EmbedBuilder()
      .setColor('#FEE75C').setTitle('📢 Set Welcome Channel')
      .setDescription('Mention the channel you want (e.g. #welcome).\nType `cancel` to abort.')
      .setTimestamp();
    collectText(prompt, 60000, async val => {
      const ch = interaction.guild.channels.cache.find(c => val.includes(c.id));
      if (!ch || ch.type !== ChannelType.GuildText) {
        return interaction.editReply({ embeds: [errorEmbed('Invalid channel. Mention a text channel.')], components: [] });
      }
      wcfg.channelId = ch.id;
      await interaction.editReply({ embeds: [successEmbed('Channel Set', `Welcome channel set to <#${ch.id}>.`)], components: [] });
      await refreshPanel();
    });
    return;
  }

  // ── Set title ────────────────────────────────────────────────────────────────
  if (action === 'title') {
    const prompt = new EmbedBuilder()
      .setColor('#FEE75C').setTitle('📝 Set Embed Title')
      .setDescription(`**Current:** \`${wcfg.title}\`\n\nType the new title. Placeholders: \`{user}\` \`{username}\` \`{server}\` \`{count}\`\nType \`cancel\` to abort.`)
      .setTimestamp();
    collectText(prompt, 120000, async val => {
      if (val.length > 256) return interaction.editReply({ embeds: [errorEmbed('Title must be 256 chars or less.')], components: [] });
      wcfg.title = val;
      await interaction.editReply({ embeds: [successEmbed('Title Updated', `\`${wcfg.title}\``)], components: [] });
      await refreshPanel();
    });
    return;
  }

  // ── Set description ──────────────────────────────────────────────────────────
  if (action === 'description') {
    const prompt = new EmbedBuilder()
      .setColor('#FEE75C').setTitle('📝 Set Embed Description')
      .setDescription(`**Current:**\n\`\`\`${wcfg.description.slice(0, 900)}\`\`\`\nPlaceholders: \`{user}\` \`{username}\` \`{server}\` \`{count}\`\nType \`cancel\` to abort.`)
      .setTimestamp();
    collectText(prompt, 180000, async val => {
      if (val.length > 4096) return interaction.editReply({ embeds: [errorEmbed('Description must be 4096 chars or less.')], components: [] });
      wcfg.description = val;
      await interaction.editReply({ embeds: [successEmbed('Description Updated', 'Embed description saved.')], components: [] });
      await refreshPanel();
    });
    return;
  }

  // ── Set colour ───────────────────────────────────────────────────────────────
  if (action === 'color') {
    const prompt = new EmbedBuilder()
      .setColor('#FEE75C').setTitle('🎨 Set Embed Color')
      .setDescription(`**Current:** \`${wcfg.color}\`\n\nType a hex colour like \`#FF5733\`.\nType \`cancel\` to abort.`)
      .setTimestamp();
    collectText(prompt, 60000, async val => {
      if (!/^#[0-9A-Fa-f]{6}$/.test(val.trim())) {
        return interaction.editReply({ embeds: [errorEmbed('Invalid colour. Use format `#RRGGBB` e.g. `#FF5733`.')], components: [] });
      }
      wcfg.color = val.trim();
      await interaction.editReply({ embeds: [successEmbed('Color Updated', `Colour set to \`${wcfg.color}\`.`)], components: [] });
      await refreshPanel();
    });
    return;
  }

  // ── Set footer ───────────────────────────────────────────────────────────────
  if (action === 'footer') {
    const prompt = new EmbedBuilder()
      .setColor('#FEE75C').setTitle('📄 Set Embed Footer')
      .setDescription(`**Current:** \`${wcfg.footer || '(none)'}\`\n\nType the footer text or \`none\` to remove it.\nPlaceholders work here too. Type \`cancel\` to abort.`)
      .setTimestamp();
    collectText(prompt, 120000, async val => {
      wcfg.footer = val.toLowerCase() === 'none' ? '' : val;
      await interaction.editReply({ embeds: [successEmbed('Footer Updated', wcfg.footer ? `\`${wcfg.footer}\`` : 'Footer removed.')], components: [] });
      await refreshPanel();
    });
    return;
  }

  // ── Set plain text message ────────────────────────────────────────────────────
  if (action === 'text') {
    const prompt = new EmbedBuilder()
      .setColor('#FEE75C').setTitle('💬 Set Plain Text Message')
      .setDescription(`**Current:**\n\`\`\`${wcfg.text.slice(0, 900)}\`\`\`\nPlaceholders: \`{user}\` \`{username}\` \`{server}\` \`{count}\`\nType \`cancel\` to abort.`)
      .setTimestamp();
    collectText(prompt, 180000, async val => {
      if (val.length > 2000) return interaction.editReply({ embeds: [errorEmbed('Message must be 2000 chars or less.')], components: [] });
      wcfg.text = val;
      await interaction.editReply({ embeds: [successEmbed('Text Message Updated', 'Plain text message saved.')], components: [] });
      await refreshPanel();
    });
    return;
  }

  // ── Set auto-delete time ──────────────────────────────────────────────────────
  if (action === 'deletafter') {
    const prompt = new EmbedBuilder()
      .setColor('#FEE75C').setTitle('⏱️ Set Auto-Delete Time')
      .setDescription(`**Current:** \`${wcfg.deleteAfter > 0 ? wcfg.deleteAfter + 's' : 'Never'}\`\n\nType the number of **seconds** before the welcome message is deleted.\n\`0\` = never delete. Type \`cancel\` to abort.`)
      .setTimestamp();
    collectText(prompt, 60000, async val => {
      const secs = parseInt(val);
      if (isNaN(secs) || secs < 0) return interaction.editReply({ embeds: [errorEmbed('Enter a valid number of seconds (0 = never).')], components: [] });
      wcfg.deleteAfter = secs;
      await interaction.editReply({
        embeds: [successEmbed('Auto-Delete Set', secs === 0 ? 'Welcome messages will **never** be deleted.' : `Welcome messages will be deleted after **${secs}s**.`)],
        components: [],
      });
      await refreshPanel();
    });
    return;
  }

  // ── Preview ──────────────────────────────────────────────────────────────────
  if (action === 'preview') {
    const member = interaction.member;
    if (wcfg.mode === 'embed') {
      const embed = new EmbedBuilder()
        .setColor(wcfg.color || '#57F287')
        .setTitle(resolvePlaceholders(wcfg.title, member))
        .setDescription(resolvePlaceholders(wcfg.description, member))
        .setTimestamp();
      if (wcfg.thumbnail) embed.setThumbnail(member.user.displayAvatarURL({ forceStatic: false }));
      if (wcfg.footer)    embed.setFooter({ text: resolvePlaceholders(wcfg.footer, member) });
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } else {
      return interaction.reply({ content: resolvePlaceholders(wcfg.text, member), ephemeral: true });
    }
  }

  // ── Reset to defaults ─────────────────────────────────────────────────────────
  if (action === 'reset') {
    delete welcomeSettings[interaction.guild.id];
    const fresh = getWelcomeSettings(interaction.guild.id);
    return interaction.update({
      embeds    : [buildWelcomePanel(interaction.guild, fresh)],
      components: buildWelcomeRows(fresh),
    });
  }

});

// ─── Message Handler ──────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // ── Ticket Setup Wizard Collector ─────────────────────────────────────────
  const session = setupSessions[message.author.id];
  if (session && message.channel.id === session.channelId) {
    const input = message.content.trim();

    // Cancel wizard
    if (input.toLowerCase() === 'cancel') {
      delete setupSessions[message.author.id];
      return message.reply({ embeds: [errorEmbed('Ticket setup wizard cancelled. No changes were saved.')] });
    }

    const step  = session.steps[session.step];

    if (input.toLowerCase() !== 'skip') {
      // Validate input
      const valid = step.validate(input);
      if (typeof valid === 'string') {
        return message.reply(`❌ ${valid} Please try again.`);
      }
      session.draft[step.key] = input;
    }

    session.step++;

    // More steps remaining?
    if (session.step < session.steps.length) {
      const nextStep = session.steps[session.step];
      // Update hint with current draft value so user sees live progress
      nextStep.hint = `Current: ${session.draft[nextStep.key]}`;
      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('⚙️ Ticket Setup Wizard')
        .setDescription(`${nextStep.question}\n\n${nextStep.hint}`)
        .setFooter({ text: 'Type your answer below • Type "skip" to keep current value • Type "cancel" to stop' })
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    }

    // All steps done — save and show summary
    const cfg = getTicketSettings(session.guildId);
    Object.assign(cfg, session.draft);
    delete setupSessions[message.author.id];

    const summaryEmbed = new EmbedBuilder()
      .setColor('#57F287')
      .setTitle('✅ Ticket Setup Complete!')
      .setDescription('All settings have been saved. Run `!ticket` to send a fresh panel.')
      .addFields(
        { name: '📋 Panel Title',          value: cfg.panelTitle,   inline: false },
        { name: '📝 Panel Description',    value: cfg.panelDesc,    inline: false },
        { name: '🔘 Button Label',         value: cfg.buttonLabel,  inline: true  },
        { name: '📁 Channel Name',         value: cfg.channelName,  inline: true  },
        { name: '🎫 Inside Ticket Title',  value: cfg.insideTitle,  inline: false },
        { name: '💬 Inside Ticket Message',value: cfg.insideDesc,   inline: false },
      )
      .setTimestamp();

    return message.reply({ embeds: [summaryEmbed] });
  }
  // FIX: If we were in a wizard session above, we've already returned.
  // This guard must come AFTER the wizard block so wizard input never
  // falls through into the command switch below.
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  switch (command) {

    // ── !help ────────────────────────────────────────────────────────────────
    case 'help':
    case 'h': {
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('📚 Multipurpose Bot Commands')
        .setDescription(`Prefix: \`${PREFIX}\``)
        .addFields(
          {
            name: '🛡️ Moderation',
            value: [
              `\`${PREFIX}kick <@user> [reason]\` — Kick a member`,
              `\`${PREFIX}ban <@user> [reason]\` — Ban a member`,
              `\`${PREFIX}unban <userID>\` — Unban a user`,
              `\`${PREFIX}mute <@user> [duration] [reason]\` — Timeout a member (e.g. 10m, 1h, 1d)`,
              `\`${PREFIX}unmute <@user>\` — Remove timeout`,
              `\`${PREFIX}warn <@user> <reason>\` — Warn a member`,
              `\`${PREFIX}warnings <@user>\` — View warnings`,
              `\`${PREFIX}clearwarnings <@user>\` — Clear warnings`,
              `\`${PREFIX}slowmode <seconds>\` — Set slowmode (0 to disable)`,
              `\`${PREFIX}lock\` — Lock the current channel`,
              `\`${PREFIX}unlock\` — Unlock the current channel`,
            ].join('\n'),
          },
          {
            name: '🗑️ Message Management',
            value: [
              `\`${PREFIX}purge <amount>\` — Delete up to 100 messages`,
              `\`${PREFIX}purgeuser <@user> <amount>\` — Delete messages from a specific user`,
            ].join('\n'),
          },
          {
            name: '📩 DM',
            value: [
              `\`${PREFIX}dm <@user> <message>\` — Send a DM to a user`,
              `\`${PREFIX}dmall <message>\` — DM all server members (admin only)`,
              `\`${PREFIX}announce <#channel> <message>\` — Send an announcement embed`,
            ].join('\n'),
          },
          {
            name: '📊 Info',
            value: [
              `\`${PREFIX}userinfo [@user]\` — Info about a user`,
              `\`${PREFIX}serverinfo\` — Info about the server`,
              `\`${PREFIX}botinfo\` — Info about the bot`,
              `\`${PREFIX}ping\` — Bot latency`,
              `\`${PREFIX}avatar [@user]\` — Get a user's avatar`,
              `\`${PREFIX}roleinfo <rolename>\` — Info about a role`,
            ].join('\n'),
          },
          {
            name: '🎉 Fun / Utility',
            value: [
              `\`${PREFIX}say <message>\` — Make the bot say something`,
              `\`${PREFIX}embed <title> | <description>\` — Send a custom embed`,
              `\`${PREFIX}poll <question>\` — Create a yes/no poll`,
              `\`${PREFIX}roll [sides]\` — Roll a dice`,
              `\`${PREFIX}coinflip\` — Flip a coin`,
            ].join('\n'),
          },
          {
            name: '🎫 Ticket System',
            value: [
              `\`${PREFIX}ticket\` — Send the ticket panel with Open Ticket button (Manage Server)`,
              `\`${PREFIX}ticketset\` — Launch interactive setup wizard (set everything step by step)`,
              `\`${PREFIX}ticketreset\` — Reset all ticket settings to defaults`,
            ].join('\n'),
          },
          {
            name: '🎉 Welcome System',
            value: [
              `\`${PREFIX}welcomeset\` — Open the welcome control panel (full button UI)`,
              `\`${PREFIX}welcometest\` — Fire a test welcome message to your configured channel`,
            ].join('\n'),
          },
          {
            name: '🎭 Status Slideshow (Bot Owner Only)',
            value: [
              `\`${PREFIX}addstatus <type> <text>\` — Add a status (types: playing, watching, listening, competing)`,
              `\`${PREFIX}removestatus <number>\` — Remove a status by its number`,
              `\`${PREFIX}liststatus\` — View all current statuses`,
              `\`${PREFIX}clearstatus\` — Remove all statuses`,
            ].join('\n'),
          }
        )
        .setFooter({ text: `${client.user.tag || client.user.username} • Multipurpose Bot` });

      message.reply({ embeds: [embed] });
      break;
    }

    // ── !ping ────────────────────────────────────────────────────────────────
    case 'ping': {
      const sent = await message.reply('Pinging...');
      sent.edit(`🏓 Pong! Latency: **${sent.createdTimestamp - message.createdTimestamp}ms** | API: **${client.ws.ping}ms**`);
      break;
    }

    // ── !kick ────────────────────────────────────────────────────────────────
    case 'kick': {
      if (!message.member.permissions.has(PermissionFlagsBits.KickMembers))
        return missingPerm(message, 'Kick Members');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers))
        return botMissingPerm(message, 'Kick Members');

      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Please mention a member to kick.');
      if (!target.kickable) return message.reply('❌ I cannot kick this member (higher role or owner).');

      const reason = args.slice(1).join(' ') || 'No reason provided';
      await target.kick(reason);
      message.reply({ embeds: [successEmbed('Member Kicked', `**${(target.user.tag || target.user.username)}** was kicked.\n**Reason:** ${reason}`)] });
      break;
    }

    // ── !ban ─────────────────────────────────────────────────────────────────
    case 'ban': {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
        return missingPerm(message, 'Ban Members');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers))
        return botMissingPerm(message, 'Ban Members');

      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Please mention a member to ban.');
      if (!target.bannable) return message.reply('❌ I cannot ban this member.');

      const reason = args.slice(1).join(' ') || 'No reason provided';
      // FIXED: deleteMessageDays deprecated in v14, use deleteMessageSeconds
      await target.ban({ reason, deleteMessageSeconds: 86400 });
      message.reply({ embeds: [successEmbed('Member Banned', `**${(target.user.tag || target.user.username)}** was banned.\n**Reason:** ${reason}`)] });
      break;
    }

    // ── !unban ───────────────────────────────────────────────────────────────
    case 'unban': {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers))
        return missingPerm(message, 'Ban Members');

      const userId = args[0];
      if (!userId) return message.reply('❌ Provide a user ID to unban.\nUsage: `!unban <userID>`');

      try {
        await message.guild.members.unban(userId);
        message.reply({ embeds: [successEmbed('Member Unbanned', `User \`${userId}\` was unbanned.`)] });
      } catch {
        message.reply({ embeds: [errorEmbed('Could not unban that user. Make sure the ID is correct.')] });
      }
      break;
    }

    // ── !mute (timeout) ──────────────────────────────────────────────────────
    case 'mute':
    case 'timeout': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
        return missingPerm(message, 'Moderate Members');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers))
        return botMissingPerm(message, 'Moderate Members');

      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Please mention a member to mute.');

      // FIXED: args[0] is the mention, so duration is args[1] and reason starts at args[2]
      let duration = parseDuration(args[1]);
      let reason;
      if (duration) {
        reason = args.slice(2).join(' ') || 'No reason provided';
      } else {
        duration = 10 * 60 * 1000;
        reason = args.slice(1).join(' ') || 'No reason provided';
      }

      const maxDuration = 28 * 24 * 60 * 60 * 1000;
      if (duration > maxDuration) return message.reply('❌ Duration cannot exceed 28 days.');

      try {
        await target.timeout(duration, reason);
        message.reply({
          embeds: [successEmbed('Member Muted', `**${(target.user.tag || target.user.username)}** has been timed out for **${formatDuration(duration)}**.\n**Reason:** ${reason}`)],
        });
      } catch (err) {
        message.reply({ embeds: [errorEmbed(`Failed to mute: ${err.message}`)] });
      }
      break;
    }

    // ── !unmute ──────────────────────────────────────────────────────────────
    case 'unmute':
    case 'untimeout': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
        return missingPerm(message, 'Moderate Members');

      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Please mention a member to unmute.');

      try {
        await target.timeout(null);
        message.reply({ embeds: [successEmbed('Member Unmuted', `**${(target.user.tag || target.user.username)}**'s timeout has been removed.`)] });
      } catch (err) {
        message.reply({ embeds: [errorEmbed(`Failed to unmute: ${err.message}`)] });
      }
      break;
    }

    // ── !warn ────────────────────────────────────────────────────────────────
    case 'warn': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
        return missingPerm(message, 'Moderate Members');

      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Please mention a member to warn.');

      // FIXED: args[0] is the mention, reason starts at args[1]
      const reason = args.slice(1).join(' ');
      if (!reason) return message.reply('❌ Provide a reason for the warning.');

      if (!client.warnings) client.warnings = {};
      if (!client.warnings[message.guild.id]) client.warnings[message.guild.id] = {};
      if (!client.warnings[message.guild.id][target.id]) client.warnings[message.guild.id][target.id] = [];

      client.warnings[message.guild.id][target.id].push({
        reason,
        moderator: message.author.tag || message.author.username,
        timestamp: new Date().toISOString(),
      });

      const count = client.warnings[message.guild.id][target.id].length;

      try {
        await target.send({
          embeds: [new EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle(`⚠️ You were warned in ${message.guild.name}`)
            .setDescription(`**Reason:** ${reason}\n**Moderator:** ${message.author.tag || message.author.username}\n**Warning #${count}**`)
            .setTimestamp()],
        });
      } catch { /* DMs disabled */ }

      message.reply({
        embeds: [successEmbed('Member Warned', `**${(target.user.tag || target.user.username)}** has been warned. (Warning #${count})\n**Reason:** ${reason}`)],
      });
      break;
    }

    // ── !warnings ────────────────────────────────────────────────────────────
    case 'warnings': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
        return missingPerm(message, 'Moderate Members');

      const target = message.mentions.members.first() || message.member;
      const userWarnings = client.warnings?.[message.guild.id]?.[target.id];

      if (!userWarnings || userWarnings.length === 0) {
        return message.reply({ embeds: [infoEmbed('⚠️ Warnings', `**${(target.user.tag || target.user.username)}** has no warnings.`)] });
      }

      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle(`⚠️ Warnings for ${(target.user.tag || target.user.username)}`)
        .setDescription(
          userWarnings
            .map((w, i) => `**#${i + 1}** — ${w.reason}\n> by ${w.moderator} • <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>`)
            .join('\n\n')
        )
        .setFooter({ text: `Total: ${userWarnings.length} warning(s)` })
        .setTimestamp();

      message.reply({ embeds: [embed] });
      break;
    }

    // ── !clearwarnings ───────────────────────────────────────────────────────
    case 'clearwarnings': {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
        return missingPerm(message, 'Administrator');

      const target = message.mentions.members.first();
      if (!target) return message.reply('❌ Please mention a member.');

      if (client.warnings?.[message.guild.id]?.[target.id]) {
        client.warnings[message.guild.id][target.id] = [];
      }
      message.reply({ embeds: [successEmbed('Warnings Cleared', `All warnings for **${(target.user.tag || target.user.username)}** have been cleared.`)] });
      break;
    }

    // ── !slowmode ────────────────────────────────────────────────────────────
    case 'slowmode': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
        return missingPerm(message, 'Manage Channels');

      const seconds = parseInt(args[0]);
      if (isNaN(seconds) || seconds < 0 || seconds > 21600)
        return message.reply('❌ Provide a value between 0 and 21600 seconds.');

      await message.channel.setRateLimitPerUser(seconds);
      message.reply({
        embeds: [successEmbed('Slowmode Updated', seconds === 0 ? 'Slowmode has been **disabled**.' : `Slowmode set to **${seconds}s**.`)],
      });
      break;
    }

    // ── !lock ────────────────────────────────────────────────────────────────
    case 'lock': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
        return missingPerm(message, 'Manage Channels');

      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: false,
      });
      message.reply({ embeds: [successEmbed('Channel Locked', `🔒 **${message.channel.name}** has been locked.`)] });
      break;
    }

    // ── !unlock ──────────────────────────────────────────────────────────────
    case 'unlock': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
        return missingPerm(message, 'Manage Channels');

      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, {
        SendMessages: null,
      });
      message.reply({ embeds: [successEmbed('Channel Unlocked', `🔓 **${message.channel.name}** has been unlocked.`)] });
      break;
    }

    // ── !purge ───────────────────────────────────────────────────────────────
    case 'purge':
    case 'clear': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
        return missingPerm(message, 'Manage Messages');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages))
        return botMissingPerm(message, 'Manage Messages');

      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 1 || amount > 100)
        return message.reply('❌ Provide a number between 1 and 100.');

      try {
        const deleted = await message.channel.bulkDelete(amount + 1, true);
        const reply = await message.channel.send({
          embeds: [successEmbed('Messages Deleted', `Deleted **${deleted.size - 1}** message(s).`)],
        });
        setTimeout(() => reply.delete().catch(() => {}), 4000);
      } catch (err) {
        message.reply({ embeds: [errorEmbed(`Failed to delete: ${err.message}`)] });
      }
      break;
    }

    // ── !purgeuser ───────────────────────────────────────────────────────────
    case 'purgeuser': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
        return missingPerm(message, 'Manage Messages');

      const target = message.mentions.users.first();
      if (!target) return message.reply('❌ Mention a user.');

      const amount = parseInt(args[1]) || 20;
      if (amount < 1 || amount > 100) return message.reply('❌ Amount must be 1–100.');

      const messages = await message.channel.messages.fetch({ limit: 100 });
      // FIXED: .first(n) doesn't exist on Collection — use .filter + .toJSON().slice()
      const toDelete = messages
        .filter((m) => m.author.id === target.id)
        .toJSON()
        .slice(0, amount);

      if (!toDelete.length) return message.reply(`❌ No recent messages found from **${target.tag || target.username}**.`);

      try {
        await message.channel.bulkDelete(toDelete, true);
        const reply = await message.channel.send({
          embeds: [successEmbed('Messages Deleted', `Deleted **${toDelete.length}** message(s) from **${target.tag || target.username}**.`)],
        });
        setTimeout(() => reply.delete().catch(() => {}), 4000);
      } catch (err) {
        message.reply({ embeds: [errorEmbed(`Failed: ${err.message}`)] });
      }
      break;
    }

    // ── !dm ──────────────────────────────────────────────────────────────────
    case 'dm': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
        return missingPerm(message, 'Moderate Members');

      const target = message.mentions.users.first();
      if (!target) return message.reply('❌ Mention a user to DM.\nUsage: `!dm @user message`');
      const dmMsg = args.slice(1).join(' ');
      if (!dmMsg) return message.reply('❌ Provide a message to send.');

      try {
        await target.send({
          embeds: [new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`📩 Message from ${message.guild.name}`)
            .setDescription(dmMsg)
            .setFooter({ text: `Sent by ${message.author.tag || message.author.username}` })
            .setTimestamp()],
        });
        message.reply({ embeds: [successEmbed('DM Sent', `Message sent to **${target.tag || target.username}**.`)] });
      } catch {
        message.reply({ embeds: [errorEmbed(`Could not DM **${target.tag || target.username}**. Their DMs may be closed.`)] });
      }
      break;
    }

    // ── !dmall ───────────────────────────────────────────────────────────────
    case 'dmall': {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator))
        return missingPerm(message, 'Administrator');

      const dmMsg = args.join(' ');
      if (!dmMsg) return message.reply('❌ Provide a message.\nUsage: `!dmall message`');

      const members = await message.guild.members.fetch();
      const humans = members.filter((m) => !m.user.bot);

      let sent = 0, failed = 0;
      const progress = await message.reply(`📤 Sending DMs to ${humans.size} members...`);

      // FIXED: 1 second delay between DMs to avoid Discord rate-limiting the bot
      for (const [, member] of humans) {
        try {
          await member.send({
            embeds: [new EmbedBuilder()
              .setColor('#5865F2')
              .setTitle(`📢 Message from ${message.guild.name}`)
              .setDescription(dmMsg)
              .setFooter({ text: `Sent by ${message.author.tag || message.author.username}` })
              .setTimestamp()],
          });
          sent++;
        } catch { failed++; }
        await sleep(1000);
      }

      progress.edit({
        embeds: [infoEmbed('📤 DM All Complete', `✅ Sent: **${sent}**\n❌ Failed: **${failed}** (DMs closed)`)],
        content: null,
      });
      break;
    }

    // ── !announce ────────────────────────────────────────────────────────────
    case 'announce': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return missingPerm(message, 'Manage Server');

      const channel = message.mentions.channels.first();
      if (!channel) return message.reply('❌ Mention a channel.\nUsage: `!announce #channel message`');
      // args[0] is the channel mention token (#channel), text starts at args[1]
      const text = args.slice(1).join(' ');
      if (!text) return message.reply('❌ Provide the announcement text.');

      try {
        await channel.send({
          embeds: [new EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle('📢 Announcement')
            .setDescription(text)
            .setFooter({ text: `Announced by ${message.author.tag || message.author.username}` })
            .setTimestamp()],
        });
        message.reply({ embeds: [successEmbed('Announcement Sent', `Message sent to ${channel}.`)] });
      } catch {
        message.reply({ embeds: [errorEmbed(`I cannot send messages in ${channel}.`)] });
      }
      break;
    }

    // ── !userinfo ────────────────────────────────────────────────────────────
    case 'userinfo':
    case 'whois': {
      const target = message.mentions.members.first() || message.member;
      const user = target.user;
      const roles = target.roles.cache
        .filter((r) => r.id !== message.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => r.toString())
        .slice(0, 10)
        .join(', ') || 'None';

      const embed = new EmbedBuilder()
        .setColor(target.displayHexColor || '#5865F2')
        .setTitle(`👤 ${user.tag || user.username}`)
        .setThumbnail(user.displayAvatarURL({ forceStatic: false, size: 256 }))
        .addFields(
          { name: '🆔 User ID', value: user.id, inline: true },
          { name: '🤖 Bot', value: user.bot ? 'Yes' : 'No', inline: true },
          { name: '📅 Account Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`, inline: false },
          { name: '📥 Joined Server', value: target.joinedAt ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:F>` : 'Unknown', inline: false },
          { name: `🎭 Roles [${target.roles.cache.size - 1}]`, value: roles },
          { name: '⭐ Highest Role', value: target.roles.highest.toString(), inline: true },
          { name: '🔑 Nickname', value: target.nickname || 'None', inline: true },
        )
        .setTimestamp();

      message.reply({ embeds: [embed] });
      break;
    }

    // ── !serverinfo ──────────────────────────────────────────────────────────
    case 'serverinfo':
    case 'server': {
      const guild = message.guild;
      await guild.fetch();

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🏠 ${guild.name}`)
        .setThumbnail(guild.iconURL({ forceStatic: false }))
        .addFields(
          { name: '🆔 Server ID', value: guild.id, inline: true },
          { name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
          { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
          { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`, inline: false },
          { name: '📢 Channels', value: `${guild.channels.cache.size}`, inline: true },
          { name: '🎭 Roles', value: `${guild.roles.cache.size}`, inline: true },
          { name: '😀 Emojis', value: `${guild.emojis.cache.size}`, inline: true },
          { name: '🔒 Verification Level', value: guild.verificationLevel.toString(), inline: true },
          { name: '🚀 Boost Level', value: `Level ${guild.premiumTier}`, inline: true },
          { name: '💎 Boosts', value: `${guild.premiumSubscriptionCount || 0}`, inline: true },
        )
        .setTimestamp();

      message.reply({ embeds: [embed] });
      break;
    }

    // ── !botinfo ─────────────────────────────────────────────────────────────
    case 'botinfo': {
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const minutes = Math.floor((uptime % 3600) / 60);
      const seconds = Math.floor(uptime % 60);

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🤖 ${client.user.tag || client.user.username}`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          { name: '📡 Servers', value: `${client.guilds.cache.size}`, inline: true },
          { name: '👥 Users', value: `${client.users.cache.size}`, inline: true },
          { name: '🏓 Ping', value: `${client.ws.ping}ms`, inline: true },
          { name: '⏱ Uptime', value: `${hours}h ${minutes}m ${seconds}s`, inline: true },
          { name: '📦 discord.js', value: require('discord.js').version, inline: true },
          { name: '🟢 Node.js', value: process.version, inline: true },
        )
        .setTimestamp();

      message.reply({ embeds: [embed] });
      break;
    }

    // ── !avatar ──────────────────────────────────────────────────────────────
    case 'avatar':
    case 'pfp': {
      const target = message.mentions.users.first() || message.author;
      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🖼️ ${target.tag || target.username}'s Avatar`)
        .setImage(target.displayAvatarURL({ forceStatic: false, size: 512 }))
        .setURL(target.displayAvatarURL({ forceStatic: false, size: 4096 }));
      message.reply({ embeds: [embed] });
      break;
    }

    // ── !roleinfo ────────────────────────────────────────────────────────────
    case 'roleinfo': {
      const roleName = args.join(' ');
      if (!roleName) return message.reply('❌ Provide a role name.\nUsage: `!roleinfo <rolename>`');

      const role = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleName.toLowerCase()
      );
      if (!role) return message.reply(`❌ Role **${roleName}** not found.`);

      const embed = new EmbedBuilder()
        .setColor(role.hexColor || '#5865F2')
        .setTitle(`🎭 ${role.name}`)
        .addFields(
          { name: '🆔 Role ID', value: role.id, inline: true },
          { name: '🎨 Color', value: role.hexColor, inline: true },
          { name: '📅 Created', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:F>`, inline: false },
          { name: '👥 Members', value: `${role.members.size}`, inline: true },
          { name: '📌 Hoisted', value: role.hoist ? 'Yes' : 'No', inline: true },
          { name: '💬 Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
          { name: '📊 Position', value: `${role.position}`, inline: true },
        )
        .setTimestamp();

      message.reply({ embeds: [embed] });
      break;
    }

    // ── !say ─────────────────────────────────────────────────────────────────
    case 'say': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
        return missingPerm(message, 'Manage Messages');

      const text = args.join(' ');
      if (!text) return message.reply('❌ Provide a message.');
      await message.delete().catch(() => {});
      message.channel.send(text);
      break;
    }

    // ── !embed ───────────────────────────────────────────────────────────────
    case 'embed': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
        return missingPerm(message, 'Manage Messages');

      const parts = args.join(' ').split('|');
      if (parts.length < 2) return message.reply('❌ Usage: `!embed Title | Description`');

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(parts[0].trim())
        .setDescription(parts[1].trim())
        .setFooter({ text: `Requested by ${message.author.tag || message.author.username}` })
        .setTimestamp();

      await message.delete().catch(() => {});
      message.channel.send({ embeds: [embed] });
      break;
    }

    // ── !poll ────────────────────────────────────────────────────────────────
    case 'poll': {
      const question = args.join(' ');
      if (!question) return message.reply('❌ Provide a question.\nUsage: `!poll <question>`');

      const embed = new EmbedBuilder()
        .setColor('#FEE75C')
        .setTitle('📊 Poll')
        .setDescription(`**${question}**`)
        .setFooter({ text: `Poll by ${message.author.tag || message.author.username}` })
        .setTimestamp();

      const poll = await message.channel.send({ embeds: [embed] });
      await poll.react('✅');
      await poll.react('❌');
      await message.delete().catch(() => {});
      break;
    }

    // ── !roll ────────────────────────────────────────────────────────────────
    case 'roll': {
      const sides = parseInt(args[0]) || 6;
      if (sides < 2) return message.reply('❌ Dice must have at least 2 sides.');
      const result = Math.floor(Math.random() * sides) + 1;
      message.reply({ embeds: [infoEmbed('🎲 Dice Roll', `You rolled a **d${sides}** and got: **${result}**`)] });
      break;
    }

    // ── !coinflip ────────────────────────────────────────────────────────────
    case 'coinflip':
    case 'coin': {
      const result = Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
      message.reply({ embeds: [infoEmbed('Coin Flip', `Result: **${result}**`)] });
      break;
    }

    // ── !ticket (send panel) ────────────────────────────────────────────────
    case 'ticket': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return missingPerm(message, 'Manage Server');

      const cfg = getTicketSettings(message.guild.id);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_ticket')
          .setLabel(cfg.buttonLabel)
          .setStyle(ButtonStyle.Primary)
      );

      const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(cfg.panelTitle)
        .setDescription(cfg.panelDesc)
        .setFooter({ text: message.guild.name })
        .setTimestamp();

      await message.channel.send({ embeds: [embed], components: [row] });
      await message.delete().catch(() => {});
      break;
    }

    // ── !ticketset (interactive wizard) ─────────────────────────────────────
    case 'ticketset': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return missingPerm(message, 'Manage Server');

      // Kill any existing wizard for this user
      if (setupSessions[message.author.id]) {
        delete setupSessions[message.author.id];
      }

      const cfg = getTicketSettings(message.guild.id);

      const STEPS = [
        {
          key      : 'panelTitle',
          label    : 'Panel Title',
          question : '**Step 1/6 — Panel Embed Title**\nWhat should the title of the ticket panel embed be?',
          hint     : `Current: \`${cfg.panelTitle}\``,
          validate : (v) => v.length <= 256 || 'Title must be 256 characters or less.',
        },
        {
          key      : 'panelDesc',
          label    : 'Panel Description',
          question : '**Step 2/6 — Panel Embed Description**\nWhat should the description of the ticket panel say?',
          hint     : `Current: ${cfg.panelDesc}`,
          validate : (v) => v.length <= 4096 || 'Description must be 4096 characters or less.',
        },
        {
          key      : 'buttonLabel',
          label    : 'Button Label',
          question : '**Step 3/6 — Open Ticket Button Label**\nWhat should the button say?',
          hint     : `Current: \`${cfg.buttonLabel}\``,
          validate : (v) => v.length <= 80 || 'Button label must be 80 characters or less.',
        },
        {
          key      : 'channelName',
          label    : 'Ticket Channel Name',
          question : '**Step 4/6 — Ticket Channel Name**\nWhat should new ticket channels be named? Use `{username}` as a placeholder.',
          hint     : `Current: \`${cfg.channelName}\``,
          validate : (v) => /^[a-z0-9\-{}_]+$/i.test(v) || 'Only letters, numbers, hyphens, underscores, and `{username}` are allowed.',
        },
        {
          key      : 'insideTitle',
          label    : 'Inside Ticket Title',
          question : '**Step 5/6 — Inside Ticket Embed Title**\nWhat should the title of the embed inside the ticket channel be?',
          hint     : `Current: \`${cfg.insideTitle}\``,
          validate : (v) => v.length <= 256 || 'Title must be 256 characters or less.',
        },
        {
          key      : 'insideDesc',
          label    : 'Inside Ticket Message',
          question : '**Step 6/6 — Inside Ticket Message**\nWhat should the welcome message inside the ticket say? Use `{mention}` to ping the user.',
          hint     : `Current: ${cfg.insideDesc}`,
          validate : (v) => v.length <= 4096 || 'Description must be 4096 characters or less.',
        },
      ];

      // Build the draft config from current values so skips keep current
      const draft = { ...cfg };

      setupSessions[message.author.id] = {
        step    : 0,
        draft,
        guildId : message.guild.id,
        channelId: message.channel.id,
        steps   : STEPS,
      };

      function buildStepEmbed(stepIdx) {
        const s = STEPS[stepIdx];
        return new EmbedBuilder()
          .setColor('#FEE75C')
          .setTitle('⚙️ Ticket Setup Wizard')
          .setDescription(`${s.question}\n\n${s.hint}`)
          .setFooter({ text: 'Type your answer below • Type "skip" to keep current value • Type "cancel" to stop' })
          .setTimestamp();
      }

      await message.reply({ embeds: [buildStepEmbed(0)] });
      break;
    }

    // ── !ticketreset (reset all settings to default) ─────────────────────────
    case 'ticketreset': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return missingPerm(message, 'Manage Server');

      delete ticketSettings[message.guild.id];
      getTicketSettings(message.guild.id); // re-init defaults
      message.reply({ embeds: [successEmbed('Ticket Settings Reset', 'All ticket settings have been reset to defaults.')] });
      break;
    }

    // ── !welcomeset (open the button control panel) ────────────────────────────
    case 'welcomeset':
    case 'wset': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return missingPerm(message, 'Manage Server');

      const wcfg = getWelcomeSettings(message.guild.id);
      const panelMsg = await message.reply({
        embeds    : [buildWelcomePanel(message.guild, wcfg)],
        components: buildWelcomeRows(wcfg),
      });
      // Store so button handlers can refresh it
      welcomePanelMessages[message.guild.id] = panelMsg;
      break;
    }

    // ── !welcometest (fire a fake welcome to test config) ─────────────────────
    case 'welcometest':
    case 'wtest': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return missingPerm(message, 'Manage Server');

      const wcfg = getWelcomeSettings(message.guild.id);
      if (!wcfg.enabled)
        return message.reply({ embeds: [errorEmbed('Welcome system is currently **disabled**. Enable it in `!welcomeset`.') ] });
      if (!wcfg.channelId)
        return message.reply({ embeds: [errorEmbed('No welcome channel set. Use `!welcomeset` → 📢 Set Channel first.')] });

      const ch = message.guild.channels.cache.get(wcfg.channelId);
      if (!ch) return message.reply({ embeds: [errorEmbed('Welcome channel not found. Please reconfigure.')] });

      const member = message.member;
      let sentMsg;
      if (wcfg.mode === 'embed') {
        const embed = new EmbedBuilder()
          .setColor(wcfg.color || '#57F287')
          .setTitle(resolvePlaceholders(wcfg.title, member))
          .setDescription(resolvePlaceholders(wcfg.description, member))
          .setTimestamp();
        if (wcfg.thumbnail) embed.setThumbnail(member.user.displayAvatarURL({ forceStatic: false }));
        if (wcfg.footer)    embed.setFooter({ text: resolvePlaceholders(wcfg.footer, member) });
        sentMsg = await ch.send({ embeds: [embed] });
      } else {
        sentMsg = await ch.send(resolvePlaceholders(wcfg.text, member));
      }

      if (wcfg.deleteAfter > 0)
        setTimeout(() => sentMsg.delete().catch(() => {}), wcfg.deleteAfter * 1000);

      message.reply({ embeds: [successEmbed('Test Sent', `A test welcome was sent to <#${wcfg.channelId}>.`)] });
      break;
    }

    // ── !addstatus ───────────────────────────────────────────────────────────
    case 'addstatus': {
      if (message.author.id !== client.application.owner?.id &&
          message.author.id !== process.env.OWNER_ID)
        return message.reply('❌ Only the **bot owner** can manage statuses.');

      const validTypes = ['PLAYING', 'WATCHING', 'LISTENING', 'COMPETING'];
      const type = args[0]?.toUpperCase();
      if (!type || !validTypes.includes(type))
        return message.reply(`❌ Invalid type. Choose from: \`playing\`, \`watching\`, \`listening\`, \`competing\``);

      const text = args.slice(1).join(' ');
      if (!text) return message.reply('❌ Provide status text.\nUsage: `!addstatus playing Among Us`');

      statusList.push({ text, type });
      startStatusSystem(); // restart so new status is included immediately

      message.reply({
        embeds: [successEmbed('Status Added',
          `Added **${type}** status: \`${text}\`\n` +
          (statusList.length === 1
            ? '📌 This status will stay **permanently** until you add more or remove it.'
            : `🔄 Rotating between **${statusList.length}** statuses every ${STATUS_DELAY / 1000}s.`)
        )],
      });
      break;
    }

    // ── !removestatus ────────────────────────────────────────────────────────
    case 'removestatus': {
      if (message.author.id !== client.application.owner?.id &&
          message.author.id !== process.env.OWNER_ID)
        return message.reply('❌ Only the **bot owner** can manage statuses.');

      const index = parseInt(args[0]) - 1;
      if (isNaN(index) || index < 0 || index >= statusList.length)
        return message.reply(`❌ Invalid number. Use \`${PREFIX}liststatus\` to see all statuses.`);

      const removed = statusList.splice(index, 1)[0];
      statusIndex = 0;
      startStatusSystem();

      message.reply({
        embeds: [successEmbed('Status Removed', `Removed: \`${removed.text}\`\n**${statusList.length}** status(es) remaining.`)],
      });
      break;
    }

    // ── !liststatus ──────────────────────────────────────────────────────────
    case 'liststatus': {
      if (!statusList.length)
        return message.reply({ embeds: [infoEmbed('🎭 Status List', 'No statuses set. Use `!addstatus` to add one.')] });

      const list = statusList
        .map((s, i) => `**${i + 1}.** \`${s.type}\` — ${s.text}`)
        .join('\n');

      const mode = statusList.length === 1
        ? '📌 Permanent (single status stays forever)'
        : `🔄 Rotating every ${STATUS_DELAY / 1000}s`;

      message.reply({
        embeds: [infoEmbed(`🎭 Status List (${statusList.length} total)`, list)
          .setFooter({ text: mode })],
      });
      break;
    }

    // ── !clearstatus ─────────────────────────────────────────────────────────
    case 'clearstatus': {
      if (message.author.id !== client.application.owner?.id &&
          message.author.id !== process.env.OWNER_ID)
        return message.reply('❌ Only the **bot owner** can manage statuses.');

      statusList.length = 0;
      statusIndex = 0;
      stopSlideshow();
      client.user.setActivity(null);

      message.reply({ embeds: [successEmbed('Statuses Cleared', 'All statuses have been removed. The bot now has no status.')] });
      break;
    }

    // ── Unknown command ──────────────────────────────────────────────────────
    default: {
      message.reply(`❓ Unknown command. Use \`${PREFIX}help\` to see all commands.`);
      break;
    }
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Failed to login. Check your DISCORD_TOKEN:', err.message);
  process.exit(1);
});
