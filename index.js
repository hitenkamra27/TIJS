require('./keep_alive'); // Starts HTTP server so Render detects an open port

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

// ─── Single-Instance Guard (TCP Port Lock) ────────────────────────────────────
// Uses a local TCP server as an atomic process lock — works on Windows & Linux.
// If a second instance starts and the port is taken, it exits cleanly.
const net = require('net');
const LOCK_PORT = parseInt(process.env.LOCK_PORT) || 47392;
const lockServer = net.createServer();
lockServer.listen(LOCK_PORT, '127.0.0.1', () => { /* Port acquired — sole instance */ });
lockServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Bot already running (port ${LOCK_PORT} in use).\nThis prevents double responses.\nClose the other process first, then restart.\n`);
    process.exit(1);
  }
});

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
const statusList = [{ text: `${PREFIX}help | Multipurpose Bot`, type: 'PLAYING' }];
let statusIndex = 0, statusInterval = null;
const STATUS_DELAY = parseInt(process.env.STATUS_DELAY) || 30000;
const ActivityTypeMap = { PLAYING: 0, STREAMING: 1, LISTENING: 2, WATCHING: 3, COMPETING: 5 };

function applyCurrentStatus() {
  if (!statusList.length) return;
  const s = statusList[statusIndex % statusList.length];
  client.user.setActivity(s.text, { type: ActivityTypeMap[s.type] ?? 0 });
}
function rotateStatus() {
  if (!statusList.length) return;
  statusIndex = (statusIndex + 1) % statusList.length;
  applyCurrentStatus();
}
function startStatusSystem() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
  if (!statusList.length) { client.user?.setActivity(null); return; }
  applyCurrentStatus();
  if (statusList.length > 1) statusInterval = setInterval(rotateStatus, STATUS_DELAY);
}
function stopSlideshow() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}

// ─── Global Error Handlers ────────────────────────────────────────────────────
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException',  (e) => console.error('Uncaught exception:', e));
client.on('error',               (e) => console.error('Discord client error:', e));

// ─── Utility Helpers ──────────────────────────────────────────────────────────
const missingPerm    = (msg, p) => msg.reply(`❌ You need the **${p}** permission.`);
const botMissingPerm = (msg, p) => msg.reply(`❌ I need the **${p}** permission.`);
function parseDuration(str) {
  const m = str?.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;
  return parseInt(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
}
function formatDuration(ms) {
  if (ms < 60000) return `${Math.floor(ms/1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms/60000)}m`;
  if (ms < 86400000) return `${Math.floor(ms/3600000)}h`;
  return `${Math.floor(ms/86400000)}d`;
}
const successEmbed = (t, d) => new EmbedBuilder().setColor('#57F287').setTitle(`✅ ${t}`).setDescription(d).setTimestamp();
const errorEmbed   = (d)    => new EmbedBuilder().setColor('#ED4245').setTitle('❌ Error').setDescription(d).setTimestamp();
const infoEmbed    = (t, d) => new EmbedBuilder().setColor('#5865F2').setTitle(t).setDescription(d).setTimestamp();
const sleep        = (ms)   => new Promise(r => setTimeout(r, ms));

// ─── Fun Helpers ──────────────────────────────────────────────────────────────
function pct(userId, seed) {
  let h = 0, str = userId + seed + new Date().toDateString();
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 101;
}
const meterBar = (v, max = 100) => '█'.repeat(Math.round(v/max*10)) + '░'.repeat(10 - Math.round(v/max*10));

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ ${client.user.username} is online! Serving ${client.guilds.cache.size} server(s)`);
  await client.application.fetch().catch(e => console.warn('⚠️ Could not fetch app info:', e.message));
  startStatusSystem();
});

// ─── Welcome System ───────────────────────────────────────────────────────────
const welcomeSettings = {}, welcomePanelMessages = {};
function getWelcomeSettings(gid) {
  if (!welcomeSettings[gid]) welcomeSettings[gid] = {
    enabled: false, channelId: null, mode: 'embed',
    title: '👋 Welcome to {server}!',
    description: 'Hey {user}, welcome to **{server}**! 🎉\nWe now have **{count}** members.',
    color: '#57F287', text: 'Welcome {user} to **{server}**! You are member #{count}.',
    deleteAfter: 0, thumbnail: true, footer: 'Member #{count}',
  };
  return welcomeSettings[gid];
}
function resolvePlaceholders(str, member) {
  return str.replace(/{user}/g, member.toString()).replace(/{username}/g, member.user.username)
            .replace(/{server}/g, member.guild.name).replace(/{count}/g, member.guild.memberCount);
}
function buildWelcomePanel(guild, cfg) {
  const embed = new EmbedBuilder().setColor('#5865F2').setTitle('🎉 Welcome System — Control Panel')
    .setDescription('Use the buttons below to configure the welcome message.')
    .addFields(
      { name: '🟢 Status',      value: cfg.enabled ? '✅ Enabled' : '❌ Disabled', inline: true },
      { name: '📢 Channel',     value: cfg.channelId ? `<#${cfg.channelId}>` : '`Not set`', inline: true },
      { name: '💬 Mode',        value: cfg.mode === 'embed' ? '📦 Embed' : '📝 Text', inline: true },
      { name: '⏱️ Auto-Delete', value: cfg.deleteAfter > 0 ? `${cfg.deleteAfter}s` : 'Never', inline: true },
      { name: '🖼️ Thumbnail',   value: cfg.thumbnail ? 'On' : 'Off', inline: true },
      { name: '\u200b',         value: '\u200b', inline: true },
    ).setTimestamp().setFooter({ text: `${guild.name} • Welcome Settings` });
  if (cfg.mode === 'embed') {
    embed.addFields(
      { name: '📋 Title',       value: `\`${cfg.title.slice(0,80)}\``, inline: false },
      { name: '📝 Description', value: `\`\`\`${cfg.description.slice(0,300)}\`\`\``, inline: false },
      { name: '🎨 Color',       value: cfg.color, inline: true },
      { name: '📄 Footer',      value: cfg.footer ? `\`${cfg.footer}\`` : '*(none)*', inline: true },
    );
  } else {
    embed.addFields({ name: '💬 Text', value: `\`\`\`${cfg.text.slice(0,500)}\`\`\``, inline: false });
  }
  embed.addFields({ name: '📌 Placeholders', value: '`{user}` `{username}` `{server}` `{count}`' });
  return embed;
}
function buildWelcomeRows(cfg) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('welcome:toggle').setLabel(cfg.enabled ? '🔴 Disable' : '🟢 Enable').setStyle(cfg.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('welcome:mode').setLabel(cfg.mode === 'embed' ? '📝 Switch to Text' : '📦 Switch to Embed').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('welcome:preview').setLabel('👁️ Preview').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('welcome:reset').setLabel('🔄 Reset').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('welcome:channel').setLabel('📢 Set Channel').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('welcome:deletafter').setLabel('⏱️ Auto-Delete').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('welcome:thumbnail').setLabel(cfg.thumbnail ? '🖼️ Thumbnail: ON' : '🖼️ Thumbnail: OFF').setStyle(cfg.thumbnail ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('welcome:title').setLabel('📋 Title').setStyle(ButtonStyle.Secondary).setDisabled(cfg.mode !== 'embed'),
      new ButtonBuilder().setCustomId('welcome:description').setLabel('📝 Description').setStyle(ButtonStyle.Secondary).setDisabled(cfg.mode !== 'embed'),
      new ButtonBuilder().setCustomId('welcome:color').setLabel('🎨 Color').setStyle(ButtonStyle.Secondary).setDisabled(cfg.mode !== 'embed'),
      new ButtonBuilder().setCustomId('welcome:footer').setLabel('📄 Footer').setStyle(ButtonStyle.Secondary).setDisabled(cfg.mode !== 'embed'),
      new ButtonBuilder().setCustomId('welcome:text').setLabel('💬 Text Msg').setStyle(ButtonStyle.Secondary).setDisabled(cfg.mode !== 'text'),
    ),
  ];
}
client.on('guildMemberAdd', async (member) => {
  const cfg = getWelcomeSettings(member.guild.id);
  if (!cfg.enabled || !cfg.channelId) return;
  const channel = member.guild.channels.cache.get(cfg.channelId);
  if (!channel) return;
  let sentMsg;
  if (cfg.mode === 'embed') {
    const embed = new EmbedBuilder().setColor(cfg.color || '#57F287')
      .setTitle(resolvePlaceholders(cfg.title, member))
      .setDescription(resolvePlaceholders(cfg.description, member)).setTimestamp();
    if (cfg.thumbnail) embed.setThumbnail(member.user.displayAvatarURL({ forceStatic: false }));
    if (cfg.footer)    embed.setFooter({ text: resolvePlaceholders(cfg.footer, member) });
    sentMsg = await channel.send({ embeds: [embed] });
  } else sentMsg = await channel.send(resolvePlaceholders(cfg.text, member));
  if (cfg.deleteAfter > 0) setTimeout(() => sentMsg.delete().catch(() => {}), cfg.deleteAfter * 1000);
});
client.on('guildMemberRemove', async (member) => {
  const ch = member.guild.channels.cache.find(c => ['logs','audit-log','mod-log'].includes(c.name));
  if (!ch) return;
  ch.send({ embeds: [new EmbedBuilder().setColor('#ED4245').setTitle('👋 Member Left')
    .setDescription(`**${member.user.tag || member.user.username}** left the server.`)
    .setThumbnail(member.user.displayAvatarURL({ forceStatic: false })).setTimestamp()] });
});

// ─── Ticket System ────────────────────────────────────────────────────────────
const openTickets = {}, setupSessions = {}, ticketSettings = {};
function getTicketSettings(gid) {
  if (!ticketSettings[gid]) ticketSettings[gid] = {
    channelName: 'ticket-{username}', panelTitle: '🎫 Support Tickets',
    panelDesc: 'Need help? Click below to open a private support ticket.',
    buttonLabel: '🎫 Open a Ticket', insideTitle: '🎫 Ticket Opened',
    insideDesc: 'Welcome {mention}! Please describe your issue and staff will assist you.',
  };
  return ticketSettings[gid];
}

// ─── Game State ───────────────────────────────────────────────────────────────
const tttGames = {}, hangmanGames = {}, triviaGames = {}, guessGames = {};
const bjGames  = {}, slotsCD = {}, minesGames = {}, c4Games = {}, wordleGames = {};

// ─── TTT Helpers ──────────────────────────────────────────────────────────────
const TTT_WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const checkTTT = (b) => TTT_WINS.some(([a,c,d]) => b[a] && b[a]===b[c] && b[a]===b[d]);
function buildTTTEmbed(g, status) {
  return new EmbedBuilder().setColor('#5865F2').setTitle('❌ Tic Tac Toe ⭕')
    .setDescription(`<@${g.player1}> ❌ vs ⭕ <@${g.player2}>\n\n${status}`).setTimestamp();
}
function buildTTTRows(board, disabled) {
  const labels = ['↖️','⬆️','↗️','⬅️','⏺️','➡️','↙️','⬇️','↘️'];
  return [0,1,2].map(r => {
    const row = new ActionRowBuilder();
    [0,1,2].forEach(c => {
      const i = r*3+c, cell = board[i];
      row.addComponents(new ButtonBuilder().setCustomId(`ttt:${i}`).setLabel(cell||labels[i])
        .setStyle(cell==='❌'?ButtonStyle.Danger:cell==='⭕'?ButtonStyle.Success:ButtonStyle.Secondary)
        .setDisabled(disabled||cell!==null));
    });
    return row;
  });
}

// ─── Connect4 Helpers ─────────────────────────────────────────────────────────
const makeC4Board = () => Array.from({length:6}, ()=>Array(7).fill(null));
function dropC4(board, col, sym) {
  for (let r=5; r>=0; r--) { if (!board[r][col]) { board[r][col]=sym; return r; } } return -1;
}
function checkC4(board) {
  for (let r=0; r<6; r++) for (let c=0; c<7; c++) {
    const s=board[r][c]; if (!s) continue;
    if (c+3<7&&board[r][c+1]===s&&board[r][c+2]===s&&board[r][c+3]===s) return true;
    if (r+3<6&&board[r+1][c]===s&&board[r+2][c]===s&&board[r+3][c]===s) return true;
    if (r+3<6&&c+3<7&&board[r+1][c+1]===s&&board[r+2][c+2]===s&&board[r+3][c+3]===s) return true;
    if (r+3<6&&c-3>=0&&board[r+1][c-1]===s&&board[r+2][c-2]===s&&board[r+3][c-3]===s) return true;
  }
  return false;
}
function buildC4Embed(g, status) {
  return new EmbedBuilder().setColor('#FEE75C').setTitle('🔴 Connect 4 🟡')
    .setDescription(`<@${g.player1}> 🔴 vs 🟡 <@${g.player2}>\n\n${g.board.map(r=>r.map(c=>c||'⚫').join('')).join('\n')}\n\n${status}`).setTimestamp();
}
const buildC4Rows = (disabled) => [new ActionRowBuilder().addComponents(
  ...[0,1,2,3,4,5,6].map(c => new ButtonBuilder().setCustomId(`c4:${c}`).setLabel(`${c+1}`).setStyle(ButtonStyle.Primary).setDisabled(disabled))
)];

// ─── Blackjack Helpers ────────────────────────────────────────────────────────
const SUITS=['♠','♥','♦','♣'], RANKS=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
function makeDeck() {
  const d=[]; for (const s of SUITS) for (const r of RANKS) d.push({s,r});
  for (let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}
  return d;
}
const drawCard = (d) => d.pop();
const cardVal  = (c) => c.r==='A'?11:['J','Q','K'].includes(c.r)?10:parseInt(c.r);
function handValue(hand) {
  let v=hand.reduce((a,c)=>a+cardVal(c),0), aces=hand.filter(c=>c.r==='A').length;
  while(v>21&&aces>0){v-=10;aces--;}return v;
}
const fmtHand = (h) => h.map(c=>`${c.r}${c.s}`).join(' ');
const buildBJEmbed = (g) => new EmbedBuilder().setColor('#FEE75C').setTitle('🃏 Blackjack')
  .setDescription(`**Your hand:** ${fmtHand(g.playerHand)} (${handValue(g.playerHand)})\n**Dealer shows:** ${fmtHand([g.dealerHand[0]])} + 🂠\n\nBet: **${g.bet} coins**`).setTimestamp();
const buildBJRows = () => [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('bj:hit').setLabel('👊 Hit').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId('bj:stand').setLabel('✋ Stand').setStyle(ButtonStyle.Secondary),
)];

// ─── Mines Helpers ────────────────────────────────────────────────────────────
function buildMinesRows(game, disabled, reveal=false) {
  const rows = [];
  for (let r=0;r<5;r++) {
    const row = new ActionRowBuilder();
    for (let c=0;c<5;c++) {
      const idx=r*5+c, isMine=game.mines.includes(idx), isRev=game.revealed[idx];
      let label='❓', style=ButtonStyle.Secondary;
      if (isRev) {label='💎';style=ButtonStyle.Success;}
      if (reveal&&isMine) {label='💣';style=ButtonStyle.Danger;}
      row.addComponents(new ButtonBuilder().setCustomId(`mines:tile:${idx}`).setLabel(label).setStyle(style).setDisabled(disabled||isRev));
    }
    rows.push(row);
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('mines:cashout')
      .setLabel(`💰 Cash Out (${(game.bet*game.multiplier).toFixed(0)} coins)`)
      .setStyle(ButtonStyle.Success).setDisabled(disabled||game.found===0)
  ));
  return rows;
}

// ─── Hangman Data ─────────────────────────────────────────────────────────────
const HM_WORDS = ['javascript','discord','programming','keyboard','elephant','midnight','rainbow','adventure','telescope','butterfly','champion','universe','developer','algorithm','database'];
const HM_STAGES = [
  '```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```',
];

// ─── Trivia Data ──────────────────────────────────────────────────────────────
const TRIVIA = [
  {q:'What is the capital of France?',          a:'paris',         c:['London','Paris','Berlin','Madrid']},
  {q:'How many sides does a hexagon have?',      a:'6',             c:['5','6','7','8']},
  {q:'Which planet is called the Red Planet?',  a:'mars',          c:['Venus','Mars','Jupiter','Saturn']},
  {q:'What is the largest ocean on Earth?',     a:'pacific',       c:['Atlantic','Indian','Pacific','Arctic']},
  {q:'What gas do plants absorb?',              a:'carbon dioxide', c:['Oxygen','Nitrogen','Carbon Dioxide','Hydrogen']},
  {q:'Who wrote Romeo and Juliet?',             a:'shakespeare',   c:['Dickens','Shakespeare','Austen','Twain']},
  {q:'What is 12 × 12?',                        a:'144',           c:['124','136','144','156']},
  {q:'Chemical symbol for gold?',               a:'au',            c:['Go','Gd','Au','Ag']},
  {q:'How many continents are there?',          a:'7',             c:['5','6','7','8']},
  {q:'Fastest land animal?',                    a:'cheetah',       c:['Lion','Horse','Cheetah','Falcon']},
];

// ─── Wordle Words ─────────────────────────────────────────────────────────────
const WORDLE_WORDS = ['apple','brave','crane','drive','eagle','flame','grace','happy','image','joker','knife','lemon','magic','night','ocean','piano','queen','river','stone','tiger','uncle','vivid','water','xenon','yacht','zebra'];

function evaluateWordle(guess, word) {
  const res = Array(5).fill(null).map((_,i) => ({l:guess[i], e:'⬛'}));
  const wa  = word.split('');
  for (let i=0;i<5;i++) if (guess[i]===word[i]) {res[i].e='🟩';wa[i]=null;}
  for (let i=0;i<5;i++) {
    if (res[i].e==='🟩') continue;
    const idx=wa.indexOf(guess[i]);
    if (idx!==-1) {res[i].e='🟨';wa[idx]=null;}
  }
  return res;
}

// ─── Interaction Handler ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // Open Ticket
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    const {guild, member} = interaction;
    const cfg = getTicketSettings(guild.id);
    const existing = Object.entries(openTickets).find(([,t])=>t.userId===member.id&&t.guildId===guild.id);
    if (existing) return interaction.reply({embeds:[errorEmbed(`Ticket already open: <#${existing[0]}>`)],ephemeral:true});
    await interaction.deferReply({ephemeral:true});
    let cat = guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name.toLowerCase()==='tickets');
    if (!cat) cat = await guild.channels.create({name:'Tickets',type:ChannelType.GuildCategory,position:0});
    const chName = cfg.channelName.replace('{username}',member.user.username.toLowerCase().replace(/[^a-z0-9-]/g,''));
    const tc = await guild.channels.create({name:chName,type:ChannelType.GuildText,parent:cat.id,
      permissionOverwrites:[
        {id:guild.roles.everyone,deny:[PermissionsBitField.Flags.ViewChannel]},
        {id:member.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory]},
        {id:guild.members.me.id,allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ReadMessageHistory,PermissionsBitField.Flags.ManageChannels]},
      ]});
    const mods = guild.roles.cache.filter(r=>r.permissions.has(PermissionsBitField.Flags.ManageGuild)&&r.id!==guild.id);
    for (const [,role] of mods) await tc.permissionOverwrites.edit(role,{ViewChannel:true,SendMessages:true,ReadMessageHistory:true});
    openTickets[tc.id] = {userId:member.id,guildId:guild.id};
    await tc.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(cfg.insideTitle).setDescription(cfg.insideDesc.replace('{mention}',member.toString())).setFooter({text:'Click below to close.'}).setTimestamp()],
      components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger))]});
    await interaction.editReply({embeds:[successEmbed('Ticket Created',`Opened: ${tc}`)]});
    return;
  }

  // Close Ticket
  if (interaction.isButton() && interaction.customId === 'close_ticket') {
    const td = openTickets[interaction.channel.id];
    if (!td) return interaction.reply({embeds:[errorEmbed('Not a ticket channel.')],ephemeral:true});
    const isStaff = interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    if (td.userId !== interaction.user.id && !isStaff) return interaction.reply({embeds:[errorEmbed('Only ticket owner or staff can close this.')],ephemeral:true});
    await interaction.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔒 Closing').setDescription(`Closed by ${interaction.member}. Deleting in 5 seconds.`).setTimestamp()]});
    delete openTickets[interaction.channel.id];
    setTimeout(() => interaction.channel.delete().catch(()=>{}), 5000);
    return;
  }

  // TTT
  if (interaction.isButton() && interaction.customId.startsWith('ttt:')) {
    const game = tttGames[interaction.channel.id];
    if (!game) return interaction.reply({content:'❌ No active TTT game.',ephemeral:true});
    if (interaction.user.id !== game.currentPlayer) return interaction.reply({content:'❌ Not your turn!',ephemeral:true});
    const idx = parseInt(interaction.customId.split(':')[1]);
    if (game.board[idx]) return interaction.reply({content:'❌ Cell taken.',ephemeral:true});
    game.board[idx] = game.symbol;
    const win  = checkTTT(game.board);
    const full = game.board.every(c=>c!==null);
    if (win) { delete tttGames[interaction.channel.id]; return interaction.update({embeds:[buildTTTEmbed(game,`🎉 <@${interaction.user.id}> wins!`)],components:buildTTTRows(game.board,true)}); }
    if (full){ delete tttGames[interaction.channel.id]; return interaction.update({embeds:[buildTTTEmbed(game,"🤝 Draw!")],components:buildTTTRows(game.board,true)}); }
    game.currentPlayer = game.currentPlayer===game.player1 ? game.player2 : game.player1;
    game.symbol = game.symbol==='❌' ? '⭕' : '❌';
    return interaction.update({embeds:[buildTTTEmbed(game,`<@${game.currentPlayer}>'s turn (${game.symbol})`)],components:buildTTTRows(game.board,false)});
  }

  // Mines
  if (interaction.isButton() && interaction.customId.startsWith('mines:')) {
    const [,action,idxStr] = interaction.customId.split(':');
    const game = minesGames[interaction.user.id];
    if (!game) return interaction.reply({content:'❌ No mines game. Use `!mines` to start.',ephemeral:true});
    if (interaction.user.id !== game.userId) return interaction.reply({content:'❌ Not your game.',ephemeral:true});
    if (action === 'cashout') {
      const win = (game.bet * game.multiplier).toFixed(0);
      delete minesGames[interaction.user.id];
      return interaction.update({embeds:[successEmbed('💰 Cashed Out!',`You won **${win} coins** at **${game.multiplier}x**!\nGems found: **${game.found}**`)],components:buildMinesRows(game,true)});
    }
    const idx = parseInt(idxStr);
    if (game.revealed[idx]) return interaction.reply({content:'❌ Already revealed.',ephemeral:true});
    game.revealed[idx] = true;
    if (game.mines.includes(idx)) {
      delete minesGames[interaction.user.id];
      return interaction.update({embeds:[errorEmbed(`💥 BOOM! You hit a mine and lost **${game.bet} coins**!`)],components:buildMinesRows(game,true,true)});
    }
    game.found++; game.multiplier = parseFloat((1+game.found*0.5).toFixed(2));
    return interaction.update({embeds:[infoEmbed('💎 Mines',`Gems: **${game.found}** | Multiplier: **${game.multiplier}x**\nPotential: **${(game.bet*game.multiplier).toFixed(0)} coins**`)],components:buildMinesRows(game,false)});
  }

  // Connect4
  if (interaction.isButton() && interaction.customId.startsWith('c4:')) {
    const game = c4Games[interaction.channel.id];
    if (!game) return interaction.reply({content:'❌ No active game.',ephemeral:true});
    if (interaction.user.id !== game.currentPlayer) return interaction.reply({content:'❌ Not your turn!',ephemeral:true});
    const col = parseInt(interaction.customId.split(':')[1]);
    if (dropC4(game.board,col,game.symbol) === -1) return interaction.reply({content:'❌ Column full!',ephemeral:true});
    const win  = checkC4(game.board);
    const full = game.board[0].every(c=>c!==null);
    if (win) { delete c4Games[interaction.channel.id]; return interaction.update({embeds:[buildC4Embed(game,`🎉 <@${interaction.user.id}> wins!`)],components:buildC4Rows(true)}); }
    if (full){ delete c4Games[interaction.channel.id]; return interaction.update({embeds:[buildC4Embed(game,"🤝 Draw!")],components:buildC4Rows(true)}); }
    game.currentPlayer = game.currentPlayer===game.player1?game.player2:game.player1;
    game.symbol = game.symbol==='🔴'?'🟡':'🔴';
    return interaction.update({embeds:[buildC4Embed(game,`<@${game.currentPlayer}>'s turn (${game.symbol})`)],components:buildC4Rows(false)});
  }

  // Blackjack
  if (interaction.isButton() && interaction.customId.startsWith('bj:')) {
    const action = interaction.customId.split(':')[1];
    const game   = bjGames[interaction.user.id];
    if (!game) return interaction.reply({content:'❌ No active blackjack game.',ephemeral:true});
    if (action === 'hit') {
      game.playerHand.push(drawCard(game.deck));
      const pv = handValue(game.playerHand);
      if (pv > 21) { delete bjGames[interaction.user.id]; return interaction.update({embeds:[errorEmbed(`💥 Bust! Over 21 — lost **${game.bet} coins**.\nHand: ${fmtHand(game.playerHand)} (${pv})`)],components:[]}); }
      return interaction.update({embeds:[buildBJEmbed(game)],components:buildBJRows()});
    }
    if (action === 'stand') {
      while (handValue(game.dealerHand)<17) game.dealerHand.push(drawCard(game.deck));
      const pv=handValue(game.playerHand), dv=handValue(game.dealerHand);
      const result = dv>21||pv>dv ? `🎉 You win **${game.bet*2} coins**!` : pv===dv ? `🤝 Push — **${game.bet} coins** back.` : `😞 Dealer wins. Lost **${game.bet} coins**.`;
      delete bjGames[interaction.user.id];
      return interaction.update({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🃏 Blackjack — Result')
        .setDescription(`**Your hand:** ${fmtHand(game.playerHand)} (${pv})\n**Dealer:** ${fmtHand(game.dealerHand)} (${dv})\n\n${result}`).setTimestamp()],components:[]});
    }
  }

  // Welcome Panel Buttons
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
  if (!interaction.customId?.startsWith('welcome:')) return;
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild))
    return interaction.reply({embeds:[errorEmbed('Need **Manage Server** permission.')],ephemeral:true});
  const action = interaction.customId.split(':')[1];
  const wcfg   = getWelcomeSettings(interaction.guild.id);
  const refreshPanel = async () => {
    const pm = welcomePanelMessages[interaction.guild.id];
    if (pm) await pm.edit({embeds:[buildWelcomePanel(interaction.guild,wcfg)],components:buildWelcomeRows(wcfg)}).catch(()=>{});
  };
  const collectText = (prompt, ms, cb) => {
    interaction.reply({embeds:[prompt],ephemeral:true});
    const col = interaction.channel.createMessageCollector({filter:m=>m.author.id===interaction.user.id,time:ms,max:1});
    col.on('collect', async m => { const v=m.content; m.delete().catch(()=>{}); if(v.toLowerCase()==='cancel') return interaction.editReply({embeds:[errorEmbed('Cancelled.')],components:[]}); await cb(v); });
    col.on('end', c => { if(!c.size) interaction.editReply({embeds:[errorEmbed('Timed out.')],components:[]}).catch(()=>{}); });
  };
  if (action==='toggle')    { wcfg.enabled=!wcfg.enabled; return interaction.update({embeds:[buildWelcomePanel(interaction.guild,wcfg)],components:buildWelcomeRows(wcfg)}); }
  if (action==='mode')      { wcfg.mode=wcfg.mode==='embed'?'text':'embed'; return interaction.update({embeds:[buildWelcomePanel(interaction.guild,wcfg)],components:buildWelcomeRows(wcfg)}); }
  if (action==='thumbnail') { wcfg.thumbnail=!wcfg.thumbnail; return interaction.update({embeds:[buildWelcomePanel(interaction.guild,wcfg)],components:buildWelcomeRows(wcfg)}); }
  if (action==='channel')   { collectText(new EmbedBuilder().setColor('#FEE75C').setTitle('📢 Set Channel').setDescription('Mention the channel or type `cancel`.'),60000,async v=>{const ch=interaction.guild.channels.cache.find(c=>v.includes(c.id));if(!ch||ch.type!==ChannelType.GuildText)return interaction.editReply({embeds:[errorEmbed('Invalid channel.')],components:[]});wcfg.channelId=ch.id;await interaction.editReply({embeds:[successEmbed('Channel Set',`<#${ch.id}>`)],components:[]});await refreshPanel();}); return; }
  if (action==='title')     { collectText(new EmbedBuilder().setColor('#FEE75C').setTitle('📝 Set Title').setDescription(`Current: \`${wcfg.title}\``),120000,async v=>{if(v.length>256)return interaction.editReply({embeds:[errorEmbed('Max 256 chars.')],components:[]});wcfg.title=v;await interaction.editReply({embeds:[successEmbed('Updated',`\`${v}\``)],components:[]});await refreshPanel();}); return; }
  if (action==='description'){ collectText(new EmbedBuilder().setColor('#FEE75C').setTitle('📝 Set Description').setDescription('Type new description or `cancel`.'),180000,async v=>{if(v.length>4096)return interaction.editReply({embeds:[errorEmbed('Max 4096 chars.')],components:[]});wcfg.description=v;await interaction.editReply({embeds:[successEmbed('Updated','Saved.')],components:[]});await refreshPanel();}); return; }
  if (action==='color')     { collectText(new EmbedBuilder().setColor('#FEE75C').setTitle('🎨 Set Color').setDescription('Type hex like `#FF5733` or `cancel`.'),60000,async v=>{if(!/^#[0-9A-Fa-f]{6}$/.test(v.trim()))return interaction.editReply({embeds:[errorEmbed('Use `#RRGGBB` format.')],components:[]});wcfg.color=v.trim();await interaction.editReply({embeds:[successEmbed('Updated',v.trim())],components:[]});await refreshPanel();}); return; }
  if (action==='footer')    { collectText(new EmbedBuilder().setColor('#FEE75C').setTitle('📄 Set Footer').setDescription('Type footer or `none` to remove. Type `cancel` to abort.'),120000,async v=>{wcfg.footer=v.toLowerCase()==='none'?'':v;await interaction.editReply({embeds:[successEmbed('Updated',wcfg.footer||'Removed.')],components:[]});await refreshPanel();}); return; }
  if (action==='text')      { collectText(new EmbedBuilder().setColor('#FEE75C').setTitle('💬 Set Text').setDescription('Type plain text message or `cancel`.'),180000,async v=>{if(v.length>2000)return interaction.editReply({embeds:[errorEmbed('Max 2000 chars.')],components:[]});wcfg.text=v;await interaction.editReply({embeds:[successEmbed('Updated','Saved.')],components:[]});await refreshPanel();}); return; }
  if (action==='deletafter'){ collectText(new EmbedBuilder().setColor('#FEE75C').setTitle('⏱️ Auto-Delete').setDescription('Seconds before welcome is deleted. `0` = never.'),60000,async v=>{const s=parseInt(v);if(isNaN(s)||s<0)return interaction.editReply({embeds:[errorEmbed('Enter valid seconds.')],components:[]});wcfg.deleteAfter=s;await interaction.editReply({embeds:[successEmbed('Set',s===0?'Never.': `${s}s`)],components:[]});await refreshPanel();}); return; }
  if (action==='preview') {
    const m=interaction.member;
    if (wcfg.mode==='embed') {
      const e=new EmbedBuilder().setColor(wcfg.color||'#57F287').setTitle(resolvePlaceholders(wcfg.title,m)).setDescription(resolvePlaceholders(wcfg.description,m)).setTimestamp();
      if(wcfg.thumbnail) e.setThumbnail(m.user.displayAvatarURL({forceStatic:false}));
      if(wcfg.footer)    e.setFooter({text:resolvePlaceholders(wcfg.footer,m)});
      return interaction.reply({embeds:[e],ephemeral:true});
    } return interaction.reply({content:resolvePlaceholders(wcfg.text,m),ephemeral:true});
  }
  if (action==='reset') { delete welcomeSettings[interaction.guild.id]; const f=getWelcomeSettings(interaction.guild.id); return interaction.update({embeds:[buildWelcomePanel(interaction.guild,f)],components:buildWelcomeRows(f)}); }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  // Ticket wizard
  const session = setupSessions[message.author.id];
  if (session && message.channel.id === session.channelId) {
    const input = message.content.trim();
    if (input.toLowerCase()==='cancel') { delete setupSessions[message.author.id]; return message.reply({embeds:[errorEmbed('Setup cancelled.')]}); }
    const step = session.steps[session.step];
    if (input.toLowerCase()!=='skip') {
      const v = step.validate(input);
      if (typeof v==='string') return message.reply(`❌ ${v} Try again.`);
      session.draft[step.key] = input;
    }
    session.step++;
    if (session.step < session.steps.length) {
      const ns = session.steps[session.step];
      return message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('⚙️ Ticket Setup')
        .setDescription(`${ns.question}\n\nCurrent: \`${session.draft[ns.key]}\``)
        .setFooter({text:'"skip" to keep • "cancel" to stop'}).setTimestamp()]});
    }
    Object.assign(getTicketSettings(session.guildId), session.draft);
    delete setupSessions[message.author.id];
    return message.reply({embeds:[successEmbed('Setup Complete!','All settings saved. Use `!ticket` to send the panel.')]});
  }

  // Hangman guess
  const hmGame = hangmanGames[message.channel.id];
  if (hmGame && hmGame.userId===message.author.id && !message.content.startsWith(PREFIX)) {
    const g = message.content.trim().toLowerCase();
    if (g.length===1 && /[a-z]/.test(g)) {
      if (hmGame.guessed.includes(g)) return message.reply('❌ Already guessed!');
      hmGame.guessed.push(g);
      if (!hmGame.word.includes(g)) hmGame.wrong++;
      const disp = hmGame.word.split('').map(l=>hmGame.guessed.includes(l)?l:'_').join(' ');
      const won=!disp.includes('_'), lost=hmGame.wrong>=6;
      if (won||lost) delete hangmanGames[message.channel.id];
      return message.reply({embeds:[new EmbedBuilder().setColor(won?'#57F287':lost?'#ED4245':'#5865F2')
        .setTitle(`🪓 Hangman${won?' — You Won! 🎉':lost?' — Game Over! 💀':''}`)
        .setDescription(`${HM_STAGES[hmGame.wrong]}\n**Word:** \`${disp}\`\nWrong: ${hmGame.guessed.filter(x=>!hmGame.word.includes(x)).join(', ')||'none'} (${hmGame.wrong}/6)${lost?`\n\nWord: **${hmGame.word}**`:''}`)
        .setTimestamp()]});
    }
  }

  // Trivia answer
  const tvGame = triviaGames[message.channel.id];
  if (tvGame && tvGame.userId===message.author.id && !message.content.startsWith(PREFIX)) {
    const g=message.content.trim().toLowerCase(), correct=tvGame.q.a;
    const ok=g===correct||g===tvGame.q.c.find(c=>c.toLowerCase()===correct)?.toLowerCase();
    delete triviaGames[message.channel.id];
    return message.reply({embeds:[new EmbedBuilder().setColor(ok?'#57F287':'#ED4245').setTitle(ok?'✅ Correct!':'❌ Wrong!')
      .setDescription(ok?'🎉 Well done!':`The answer was: **${tvGame.q.c.find(c=>c.toLowerCase()===correct)}**`).setTimestamp()]});
  }

  // Number guess
  const ngGame = guessGames[message.channel.id];
  if (ngGame && ngGame.userId===message.author.id && !message.content.startsWith(PREFIX)) {
    const n=parseInt(message.content.trim()); if(isNaN(n)) return;
    ngGame.attempts++;
    if (n===ngGame.number) { delete guessGames[message.channel.id]; return message.reply({embeds:[successEmbed('🎯 Correct!',`Number was **${ngGame.number}**! Got it in **${ngGame.attempts}** attempt(s)!`)]}); }
    const hint = n<ngGame.number?'📈 Too low!':'📉 Too high!';
    if (ngGame.attempts>=7) { delete guessGames[message.channel.id]; return message.reply({embeds:[errorEmbed(`Out of attempts! Number was **${ngGame.number}**.`)]}); }
    return message.reply({embeds:[infoEmbed('🔢 Guess',`${hint} Attempts: **${ngGame.attempts}/7**`)]});
  }

  // Wordle guess
  const wlGame = wordleGames[message.channel.id];
  if (wlGame && wlGame.userId===message.author.id && !message.content.startsWith(PREFIX)) {
    const g=message.content.trim().toLowerCase();
    if (g.length!==5||!/^[a-z]+$/.test(g)) return message.reply('❌ Type a valid 5-letter word!');
    const result=evaluateWordle(g,wlGame.word);
    wlGame.guesses.push({g,result});
    const won=g===wlGame.word, lost=wlGame.guesses.length>=6&&!won;
    if (won||lost) delete wordleGames[message.channel.id];
    const board=wlGame.guesses.map(x=>x.result.map(r=>r.e).join('')).join('\n');
    return message.reply({embeds:[new EmbedBuilder().setColor(won?'#538D4E':lost?'#ED4245':'#5865F2')
      .setTitle(`🟩 Wordle${won?' — Won! 🎉':lost?` — Over! Word: **${wlGame.word}**`:` — Guess ${wlGame.guesses.length}/6`}`)
      .setDescription(board).setFooter({text:won||lost?'Game over!':'Type next guess!'}).setTimestamp()]});
  }

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd  = args.shift().toLowerCase();

  switch (cmd) {

    // ── !help ───────────────────────────────────────────────────────────────
    case 'help': case 'h': {
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('📚 Bot Commands').setDescription(`Prefix: \`${PREFIX}\``)
        .addFields(
          {name:'🛡️ Moderation', value:`\`kick\` \`ban\` \`unban\` \`mute\` \`unmute\` \`warn\` \`warnings\` \`clearwarnings\` \`slowmode\` \`lock\` \`unlock\``},
          {name:'🗑️ Messages',   value:`\`purge\` \`purgeuser\``},
          {name:'📊 Info',       value:`\`userinfo\` \`serverinfo\` \`botinfo\` \`ping\` \`avatar\` \`roleinfo\` \`profile\``},
          {name:'📩 DM',         value:`\`dm\` \`dmall\` \`announce\``},
          {name:'😂 Fun',        value:`\`meme\` \`joke\` \`8ball\` \`ship\` \`fight\` \`slap\` \`hug\` \`kiss\` \`pat\` \`coinflip\` \`roll\` \`gay\` \`iq\` \`rizz\` \`aura\` \`simp\` \`drip\` \`sus\``},
          {name:'🎮 Games',      value:`\`ttt\` \`hangman\` \`trivia\` \`guess\` \`rps\` \`blackjack\` \`slots\` \`mines\` \`connect4\` \`wordle\``},
          {name:'🎫 Tickets',    value:`\`ticket\` \`ticketset\` \`ticketreset\``},
          {name:'🎉 Welcome',    value:`\`welcomeset\` \`welcometest\``},
          {name:'🛠️ Utility',   value:`\`say\` \`embed\` \`poll\``},
          {name:'🎭 Status',     value:`\`addstatus\` \`removestatus\` \`liststatus\` \`clearstatus\``},
        ).setFooter({text:`${client.user.tag||client.user.username} • All commands use prefix ${PREFIX}`})]});
      break;
    }

    // ── !ping ───────────────────────────────────────────────────────────────
    case 'ping': {
      const s = await message.reply('Pinging...');
      s.edit(`🏓 Pong! Latency: **${s.createdTimestamp-message.createdTimestamp}ms** | API: **${client.ws.ping}ms**`);
      break;
    }

    // ── !kick ───────────────────────────────────────────────────────────────
    case 'kick': {
      if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return missingPerm(message,'Kick Members');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) return botMissingPerm(message,'Kick Members');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      if (!t.kickable) return message.reply('❌ Cannot kick this member.');
      const reason=args.slice(1).join(' ')||'No reason provided';
      await t.kick(reason);
      message.reply({embeds:[successEmbed('Member Kicked',`**${t.user.tag||t.user.username}** kicked.\n**Reason:** ${reason}`)]});
      break;
    }

    // ── !ban ────────────────────────────────────────────────────────────────
    case 'ban': {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return missingPerm(message,'Ban Members');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return botMissingPerm(message,'Ban Members');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      if (!t.bannable) return message.reply('❌ Cannot ban this member.');
      const reason=args.slice(1).join(' ')||'No reason provided';
      await t.ban({reason,deleteMessageSeconds:86400});
      message.reply({embeds:[successEmbed('Member Banned',`**${t.user.tag||t.user.username}** banned.\n**Reason:** ${reason}`)]});
      break;
    }

    // ── !unban ──────────────────────────────────────────────────────────────
    case 'unban': {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return missingPerm(message,'Ban Members');
      const uid=args[0]; if(!uid) return message.reply('❌ Provide a user ID.');
      try { await message.guild.members.unban(uid); message.reply({embeds:[successEmbed('Unbanned',`\`${uid}\` unbanned.`)]}); }
      catch { message.reply({embeds:[errorEmbed('Could not unban. Check the ID.')]}); }
      break;
    }

    // ── !mute ───────────────────────────────────────────────────────────────
    case 'mute': case 'timeout': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) return botMissingPerm(message,'Moderate Members');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      let dur=parseDuration(args[1]), reason;
      if(dur){reason=args.slice(2).join(' ')||'No reason';}else{dur=600000;reason=args.slice(1).join(' ')||'No reason';}
      if(dur>28*86400000) return message.reply('❌ Max 28 days.');
      try { await t.timeout(dur,reason); message.reply({embeds:[successEmbed('Muted',`**${t.user.tag||t.user.username}** timed out for **${formatDuration(dur)}**.\n**Reason:** ${reason}`)]}); }
      catch(e){ message.reply({embeds:[errorEmbed(e.message)]}); }
      break;
    }

    // ── !unmute ─────────────────────────────────────────────────────────────
    case 'unmute': case 'untimeout': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      try { await t.timeout(null); message.reply({embeds:[successEmbed('Unmuted',`**${t.user.tag||t.user.username}** timeout removed.`)]}); }
      catch(e){ message.reply({embeds:[errorEmbed(e.message)]}); }
      break;
    }

    // ── !warn ───────────────────────────────────────────────────────────────
    case 'warn': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      const reason=args.slice(1).join(' '); if(!reason) return message.reply('❌ Provide a reason.');
      if(!client.warnings) client.warnings={};
      if(!client.warnings[message.guild.id]) client.warnings[message.guild.id]={};
      if(!client.warnings[message.guild.id][t.id]) client.warnings[message.guild.id][t.id]=[];
      client.warnings[message.guild.id][t.id].push({reason,mod:message.author.tag||message.author.username,ts:new Date().toISOString()});
      const cnt=client.warnings[message.guild.id][t.id].length;
      try { await t.send({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(`⚠️ Warned in ${message.guild.name}`).setDescription(`**Reason:** ${reason}\n**Warning #${cnt}**`).setTimestamp()]}); } catch{}
      message.reply({embeds:[successEmbed('Warned',`**${t.user.tag||t.user.username}** warned (#${cnt}).\n**Reason:** ${reason}`)]});
      break;
    }

    // ── !warnings ───────────────────────────────────────────────────────────
    case 'warnings': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      const t=message.mentions.members.first()||message.member;
      const w=client.warnings?.[message.guild.id]?.[t.id];
      if(!w||!w.length) return message.reply({embeds:[infoEmbed('⚠️ Warnings',`**${t.user.tag||t.user.username}** has no warnings.`)]});
      message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(`⚠️ Warnings for ${t.user.tag||t.user.username}`)
        .setDescription(w.map((x,i)=>`**#${i+1}** — ${x.reason}\n> by ${x.mod}`).join('\n\n'))
        .setFooter({text:`Total: ${w.length}`}).setTimestamp()]});
      break;
    }

    // ── !clearwarnings ──────────────────────────────────────────────────────
    case 'clearwarnings': {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return missingPerm(message,'Administrator');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      if(client.warnings?.[message.guild.id]?.[t.id]) client.warnings[message.guild.id][t.id]=[];
      message.reply({embeds:[successEmbed('Cleared',`All warnings for **${t.user.tag||t.user.username}** cleared.`)]});
      break;
    }

    // ── !slowmode ───────────────────────────────────────────────────────────
    case 'slowmode': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return missingPerm(message,'Manage Channels');
      const s=parseInt(args[0]); if(isNaN(s)||s<0||s>21600) return message.reply('❌ Value must be 0–21600 seconds.');
      await message.channel.setRateLimitPerUser(s);
      message.reply({embeds:[successEmbed('Slowmode',s===0?'Disabled.`':'Set to **'+s+'s**.')]});
      break;
    }

    // ── !lock ───────────────────────────────────────────────────────────────
    case 'lock': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return missingPerm(message,'Manage Channels');
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone,{SendMessages:false});
      message.reply({embeds:[successEmbed('Locked',`🔒 **${message.channel.name}** locked.`)]});
      break;
    }

    // ── !unlock ─────────────────────────────────────────────────────────────
    case 'unlock': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return missingPerm(message,'Manage Channels');
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone,{SendMessages:null});
      message.reply({embeds:[successEmbed('Unlocked',`🔓 **${message.channel.name}** unlocked.`)]});
      break;
    }

    // ── !purge ──────────────────────────────────────────────────────────────
    case 'purge': case 'clear': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return missingPerm(message,'Manage Messages');
      if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) return botMissingPerm(message,'Manage Messages');
      const n=parseInt(args[0]); if(isNaN(n)||n<1||n>100) return message.reply('❌ Provide a number 1–100.');
      try {
        await message.delete().catch(()=>{});
        const del=await message.channel.bulkDelete(n,true);
        const skip=n-del.size;
        let desc=`Deleted **${del.size}** message(s).`;
        if(skip>0) desc+=`\n⚠️ **${skip}** skipped (older than 14 days).`;
        const r=await message.channel.send({embeds:[successEmbed('Deleted',desc)]});
        setTimeout(()=>r.delete().catch(()=>{}),4000);
      } catch(e){ message.channel.send({embeds:[errorEmbed(e.message)]}); }
      break;
    }

    // ── !purgeuser ──────────────────────────────────────────────────────────
    case 'purgeuser': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return missingPerm(message,'Manage Messages');
      const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention a user.');
      const n=parseInt(args[1])||20; if(n<1||n>100) return message.reply('❌ Amount 1–100.');
      const msgs=await message.channel.messages.fetch({limit:100});
      const del=msgs.filter(m=>m.author.id===t.id).toJSON().slice(0,n);
      if(!del.length) return message.reply(`❌ No messages from **${t.tag||t.username}**.`);
      try { await message.channel.bulkDelete(del,true); const r=await message.channel.send({embeds:[successEmbed('Deleted',`Deleted **${del.length}** msg(s) from **${t.tag||t.username}**.`)]}); setTimeout(()=>r.delete().catch(()=>{}),4000); }
      catch(e){ message.reply({embeds:[errorEmbed(e.message)]}); }
      break;
    }

    // ── !dm ─────────────────────────────────────────────────────────────────
    case 'dm': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention a user.');
      const txt=args.slice(1).join(' '); if(!txt) return message.reply('❌ Provide a message.');
      try { await t.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`📩 From ${message.guild.name}`).setDescription(txt).setFooter({text:`By ${message.author.tag||message.author.username}`}).setTimestamp()]}); message.reply({embeds:[successEmbed('DM Sent',`Sent to **${t.tag||t.username}**.`)]}); }
      catch { message.reply({embeds:[errorEmbed(`Cannot DM **${t.tag||t.username}**. DMs closed.`)]}); }
      break;
    }

    // ── !dmall ──────────────────────────────────────────────────────────────
    case 'dmall': {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return missingPerm(message,'Administrator');
      const txt=args.join(' '); if(!txt) return message.reply('❌ Provide a message.');
      const members=await message.guild.members.fetch();
      const humans=members.filter(m=>!m.user.bot);
      let sent=0,failed=0;
      const prog=await message.reply(`📤 DMing ${humans.size} members...`);
      for(const[,m]of humans){try{await m.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`📢 ${message.guild.name}`).setDescription(txt).setTimestamp()]});sent++;}catch{failed++;}await sleep(1000);}
      prog.edit({embeds:[infoEmbed('DM All Done',`✅ Sent: **${sent}**\n❌ Failed: **${failed}**`)],content:''});
      break;
    }

    // ── !announce ────────────────────────────────────────────────────────────
    case 'announce': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return missingPerm(message,'Manage Server');
      const ch=message.mentions.channels.first(); if(!ch) return message.reply('❌ Mention a channel.');
      const txt=args.slice(1).join(' '); if(!txt) return message.reply('❌ Provide text.');
      try { await ch.send({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('📢 Announcement').setDescription(txt).setFooter({text:`By ${message.author.tag||message.author.username}`}).setTimestamp()]}); message.reply({embeds:[successEmbed('Sent',`Announcement sent to ${ch}.`)]}); }
      catch { message.reply({embeds:[errorEmbed(`Cannot send to ${ch}.`)]}); }
      break;
    }

    // ── !userinfo ────────────────────────────────────────────────────────────
    case 'userinfo': case 'whois': {
      const t=message.mentions.members.first()||message.member, u=t.user;
      const roles=t.roles.cache.filter(r=>r.id!==message.guild.id).sort((a,b)=>b.position-a.position).map(r=>r.toString()).slice(0,10).join(', ')||'None';
      message.reply({embeds:[new EmbedBuilder().setColor(t.displayHexColor||'#5865F2').setTitle(`👤 ${u.tag||u.username}`)
        .setThumbnail(u.displayAvatarURL({forceStatic:false,size:256}))
        .addFields(
          {name:'🆔 ID',          value:u.id,inline:true},
          {name:'🤖 Bot',         value:u.bot?'Yes':'No',inline:true},
          {name:'📅 Created',     value:`<t:${Math.floor(u.createdTimestamp/1000)}:F>`,inline:false},
          {name:'📥 Joined',      value:t.joinedAt?`<t:${Math.floor(t.joinedTimestamp/1000)}:F>`:'Unknown',inline:false},
          {name:`🎭 Roles (${t.roles.cache.size-1})`,value:roles},
          {name:'⭐ Top Role',    value:t.roles.highest.toString(),inline:true},
          {name:'🔑 Nickname',    value:t.nickname||'None',inline:true},
        ).setTimestamp()]});
      break;
    }

    // ── !serverinfo ──────────────────────────────────────────────────────────
    case 'serverinfo': case 'server': {
      const g=message.guild; await g.fetch();
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`🏠 ${g.name}`)
        .setThumbnail(g.iconURL({forceStatic:false}))
        .addFields(
          {name:'🆔 ID',         value:g.id,inline:true},
          {name:'👑 Owner',      value:`<@${g.ownerId}>`,inline:true},
          {name:'👥 Members',    value:`${g.memberCount}`,inline:true},
          {name:'📅 Created',    value:`<t:${Math.floor(g.createdTimestamp/1000)}:F>`,inline:false},
          {name:'📢 Channels',   value:`${g.channels.cache.size}`,inline:true},
          {name:'🎭 Roles',      value:`${g.roles.cache.size}`,inline:true},
          {name:'😀 Emojis',     value:`${g.emojis.cache.size}`,inline:true},
          {name:'🚀 Boost Lvl',  value:`Level ${g.premiumTier}`,inline:true},
          {name:'💎 Boosts',     value:`${g.premiumSubscriptionCount||0}`,inline:true},
        ).setTimestamp()]});
      break;
    }

    // ── !botinfo ─────────────────────────────────────────────────────────────
    case 'botinfo': {
      const up=process.uptime(), h=Math.floor(up/3600), m=Math.floor((up%3600)/60), s=Math.floor(up%60);
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`🤖 ${client.user.tag||client.user.username}`)
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          {name:'📡 Servers',   value:`${client.guilds.cache.size}`,inline:true},
          {name:'👥 Users',     value:`${client.users.cache.size}`,inline:true},
          {name:'🏓 Ping',      value:`${client.ws.ping}ms`,inline:true},
          {name:'⏱ Uptime',     value:`${h}h ${m}m ${s}s`,inline:true},
          {name:'📦 discord.js',value:require('discord.js').version,inline:true},
          {name:'🟢 Node.js',   value:process.version,inline:true},
        ).setTimestamp()]});
      break;
    }

    // ── !avatar ──────────────────────────────────────────────────────────────
    case 'avatar': case 'pfp': {
      const t=message.mentions.users.first()||message.author;
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`🖼️ ${t.tag||t.username}'s Avatar`).setImage(t.displayAvatarURL({forceStatic:false,size:512})).setURL(t.displayAvatarURL({forceStatic:false,size:4096}))]});
      break;
    }

    // ── !roleinfo ────────────────────────────────────────────────────────────
    case 'roleinfo': {
      const rn=args.join(' '); if(!rn) return message.reply('❌ Provide a role name.');
      const r=message.guild.roles.cache.find(x=>x.name.toLowerCase()===rn.toLowerCase());
      if(!r) return message.reply(`❌ Role **${rn}** not found.`);
      message.reply({embeds:[new EmbedBuilder().setColor(r.hexColor||'#5865F2').setTitle(`🎭 ${r.name}`)
        .addFields(
          {name:'🆔 ID',          value:r.id,inline:true},
          {name:'🎨 Color',       value:r.hexColor,inline:true},
          {name:'👥 Members',     value:`${r.members.size}`,inline:true},
          {name:'📌 Hoisted',     value:r.hoist?'Yes':'No',inline:true},
          {name:'💬 Mentionable', value:r.mentionable?'Yes':'No',inline:true},
          {name:'📊 Position',    value:`${r.position}`,inline:true},
        ).setTimestamp()]});
      break;
    }

    // ── !profile ─────────────────────────────────────────────────────────────
    case 'profile': {
      const t=message.mentions.members.first()||message.member, u=t.user;
      const badges=[];
      if(u.bot) badges.push('🤖 Bot');
      if(t.permissions.has(PermissionFlagsBits.Administrator)) badges.push('🛡️ Admin');
      if(t.permissions.has(PermissionFlagsBits.ManageGuild)) badges.push('⚙️ Manager');
      if(message.guild.ownerId===u.id) badges.push('👑 Owner');
      const joinedDays=Math.floor((Date.now()-t.joinedTimestamp)/86400000);
      const acctDays=Math.floor((Date.now()-u.createdTimestamp)/86400000);
      message.reply({embeds:[new EmbedBuilder().setColor(t.displayHexColor||'#5865F2').setTitle(`🪪 ${u.tag||u.username}'s Profile`)
        .setThumbnail(u.displayAvatarURL({forceStatic:false,size:256}))
        .addFields(
          {name:'🆔 User ID',      value:u.id,inline:true},
          {name:'🎨 Color',        value:t.displayHexColor||'#000',inline:true},
          {name:'🔑 Nickname',     value:t.nickname||'None',inline:true},
          {name:'📅 Account Age',  value:`${acctDays} days`,inline:true},
          {name:'📥 Member For',   value:`${joinedDays} days`,inline:true},
          {name:'⭐ Top Role',     value:t.roles.highest.toString(),inline:true},
          {name:`🎭 Roles (${t.roles.cache.size-1})`,value:t.roles.cache.filter(r=>r.id!==message.guild.id).sort((a,b)=>b.position-a.position).map(r=>r.toString()).slice(0,8).join(', ')||'None',inline:false},
          {name:'🏅 Badges',       value:badges.join('  ')||'None',inline:false},
        ).setFooter({text:`Requested by ${message.author.tag||message.author.username}`}).setTimestamp()]});
      break;
    }

    // ── !say (everyone can use) ──────────────────────────────────────────────
    case 'say': {
      const txt=args.join(' '); if(!txt) return message.reply('❌ Provide a message.');
      await message.delete().catch(()=>{});
      message.channel.send(txt);
      break;
    }

    // ── !embed ───────────────────────────────────────────────────────────────
    case 'embed': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return missingPerm(message,'Manage Messages');
      const parts=args.join(' ').split('|');
      if(parts.length<2) return message.reply('❌ Usage: `!embed Title | Description`');
      await message.delete().catch(()=>{});
      message.channel.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(parts[0].trim()).setDescription(parts[1].trim()).setFooter({text:`By ${message.author.tag||message.author.username}`}).setTimestamp()]});
      break;
    }

    // ── !poll ────────────────────────────────────────────────────────────────
    case 'poll': {
      const q=args.join(' '); if(!q) return message.reply('❌ Provide a question.');
      const poll=await message.channel.send({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('📊 Poll').setDescription(`**${q}**`).setFooter({text:`By ${message.author.tag||message.author.username}`}).setTimestamp()]});
      await poll.react('✅'); await poll.react('❌');
      await message.delete().catch(()=>{});
      break;
    }

    // ── !roll ────────────────────────────────────────────────────────────────
    case 'roll': {
      const n=parseInt(args[0])||6; if(n<2) return message.reply('❌ At least 2 sides.');
      message.reply({embeds:[infoEmbed('🎲 Dice Roll',`Rolled a **d${n}** → **${Math.floor(Math.random()*n)+1}**`)]});
      break;
    }

    // ── !coinflip ────────────────────────────────────────────────────────────
    case 'coinflip': case 'coin':
      message.reply({embeds:[infoEmbed('🪙 Coin Flip',`Result: **${Math.random()<0.5?'Heads':'Tails'}**`)]});
      break;

    // ── FUN COMMANDS ─────────────────────────────────────────────────────────

    case 'meme': {
      const memes=[
        {t:'When the code works first try 😱',i:'https://i.imgur.com/UOqFCIW.jpg'},
        {t:'Me explaining to rubber duck 🦆',i:'https://i.imgur.com/ZSY7108.jpg'},
        {t:'Debugging at 3am 😵',i:'https://i.imgur.com/nFHUKFi.jpg'},
        {t:'When someone touches my code 😤',i:'https://i.imgur.com/Qq2K5gD.jpg'},
        {t:"It works. Don't touch it.",i:'https://i.imgur.com/7pAbWeq.jpg'},
      ];
      const m=memes[Math.floor(Math.random()*memes.length)];
      message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(`😂 ${m.t}`).setImage(m.i).setTimestamp()]});
      break;
    }

    case 'joke': {
      const jokes=[
        {q:'Why do programmers prefer dark mode?',a:'Because light attracts bugs!'},
        {q:'Why did the programmer quit?',a:"They didn't get arrays!"},
        {q:'How many programmers to change a lightbulb?',a:"None. It's a hardware problem."},
        {q:'Why do Java devs wear glasses?',a:"Because they don't C#!"},
        {q:"What's a computer's fave snack?",a:'Microchips!'},
        {q:'Why was the math book sad?',a:'Too many problems.'},
        {q:'What do you call a bear with no teeth?',a:'A gummy bear!'},
      ];
      const j=jokes[Math.floor(Math.random()*jokes.length)];
      message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('😂 Joke').addFields({name:'❓',value:j.q},{name:'💡 Answer',value:`||${j.a}||`}).setTimestamp()]});
      break;
    }

    case '8ball': {
      const q=args.join(' '); if(!q) return message.reply('❌ Ask a question!');
      const ans=['🟢 Definitely!','🟢 Yes!','🟢 Without doubt.','🟢 Most likely.','🟡 Ask again later.','🟡 Cannot predict.','🔴 No.','🔴 Very doubtful.','🔴 Absolutely not.'];
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🎱 Magic 8-Ball').addFields({name:'❓',value:q},{name:'🎱',value:ans[Math.floor(Math.random()*ans.length)]}).setTimestamp()]});
      break;
    }

    case 'ship': {
      const u1=message.mentions.users.first(), u2=message.mentions.users.toJSON()[1]||message.author;
      if(!u1) return message.reply('❌ Mention at least one user!');
      let h=0; for(const c of u1.id+u2.id) h=(h*31+c.charCodeAt(0))>>>0;
      const love=h%101, bar=meterBar(love);
      const emoji=love>=80?'💕':love>=50?'💛':love>=30?'🤝':'💔';
      message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle(`${emoji} Ship`)
        .setDescription(`**${u1.username}** 💘 **${u2.username}**\n\n\`${bar}\` **${love}%**\n\n${love>=80?'Perfect match! 💑':love>=50?'There\'s potential! 😊':love>=30?'Just friends 🤝':'Not meant to be 💔'}`)
        .setTimestamp()]});
      break;
    }

    case 'fight': {
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention someone!');
      const win=Math.random()<0.5?message.member:t, lose=win.id===message.member.id?t:message.member;
      const moves=['a devastating punch','a spinning kick','a power slam','a critical hit'];
      message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('⚔️ Fight!')
        .setDescription(`**${message.author.username}** vs **${t.user.username}**\n\n🥊 **${win.user.username}** lands ${moves[Math.floor(Math.random()*moves.length)]}!\n\n🏆 **${win.user.username}** wins! **${lose.user.username}** is knocked out!`)
        .setTimestamp()]});
      break;
    }

    case 'slap': { const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!'); message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('👋 Slap!').setDescription(`**${message.author.username}** slaps **${t.username}** with a giant trout! 🐟`).setTimestamp()]}); break; }
    case 'hug':  { const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!'); message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('🤗 Hug!').setDescription(`**${message.author.username}** gives **${t.username}** a warm hug! 💕`).setTimestamp()]}); break; }
    case 'kiss': { const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!'); message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('😘 Kiss!').setDescription(`**${message.author.username}** gives **${t.username}** a kiss! 💋`).setTimestamp()]}); break; }
    case 'pat':  { const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!'); message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🫳 Pat!').setDescription(`**${message.author.username}** pats **${t.username}** on the head! ✨`).setTimestamp()]}); break; }

    case 'gay': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'gay'); message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('🏳️‍🌈 Gay Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>80?'✨ Very gay!':v>50?'🌈 Pretty gay!':v>30?'🤔 A little...':'😐 Not really.'}`).setTimestamp()]}); break; }
    case 'iq':   { const t=message.mentions.members.first()||message.member,v=pct(t.id,'iq')+50; message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🧠 IQ Test').setDescription(`**${t.user.username}**'s IQ: **${v}**\n\n${v>=130?'🎓 Galaxy brain!':v>=110?'😎 Above avg!':v>=90?'😐 Average.':'🥴 Uhh...'}`).setTimestamp()]}); break; }
    case 'rizz': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'rizz'); message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('😎 Rizz Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'🔥 God-tier rizz!':v>=60?'😏 Solid rizz!':v>=40?'😊 Decent.':'💀 No rizz.'}`).setTimestamp()]}); break; }
    case 'aura': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'aura')*1000; message.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('✨ Aura Points').setDescription(`**${t.user.username}**: **${v.toLocaleString()} pts**\n\n${v>=80000?'🌟 Legendary!':v>=60000?'💜 Strong!':v>=40000?'🔵 Average.':'⚫ Weak.'}`).setTimestamp()]}); break; }
    case 'simp': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'simp'); message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('🥺 Simp Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'😭 Certified Simp!':v>=50?'😅 A bit simpy...':v>=30?'🤨 Borderline.':'😎 Not a simp.'}`).setTimestamp()]}); break; }
    case 'drip': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'drip'); message.reply({embeds:[new EmbedBuilder().setColor('#00BFFF').setTitle('💧 Drip Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'🔥 Absolute drip!':v>=60?'😎 Nice drip!':v>=40?'👕 Basic.':'💀 No drip.'}`).setTimestamp()]}); break; }
    case 'sus':  { const t=message.mentions.members.first()||message.member,v=pct(t.id,'sus'); message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔴 Sus Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'📮 EJECTED!':v>=60?'🤨 Pretty sus...':v>=40?'🧐 Hmm...':'✅ Not sus.'}`).setTimestamp()]}); break; }

    // ── GAME COMMANDS ────────────────────────────────────────────────────────

    case 'ttt': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(tttGames[message.channel.id]) return message.reply('❌ Game already running here.');
      const g={board:Array(9).fill(null),player1:message.author.id,player2:opp.id,currentPlayer:message.author.id,symbol:'❌'};
      tttGames[message.channel.id]=g;
      message.reply({embeds:[buildTTTEmbed(g,`<@${message.author.id}>'s turn (❌)`)],components:buildTTTRows(g.board,false)});
      break;
    }

    case 'hangman': {
      if(hangmanGames[message.channel.id]) return message.reply('❌ Hangman already running here!');
      const word=HM_WORDS[Math.floor(Math.random()*HM_WORDS.length)];
      hangmanGames[message.channel.id]={word,guessed:[],wrong:0,userId:message.author.id};
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🪓 Hangman')
        .setDescription(`${HM_STAGES[0]}\n**Word:** \`${'_ '.repeat(word.length).trim()}\`\n\nType a **single letter** in chat!`)
        .setFooter({text:`${word.length} letters • 6 wrong guesses allowed`}).setTimestamp()]});
      break;
    }

    case 'trivia': {
      if(triviaGames[message.channel.id]) return message.reply('❌ Trivia already running!');
      const q=TRIVIA[Math.floor(Math.random()*TRIVIA.length)];
      triviaGames[message.channel.id]={q,userId:message.author.id};
      const choices=q.c.map((c,i)=>`${['🇦','🇧','🇨','🇩'][i]} **${c}**`).join('\n');
      message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🧠 Trivia').setDescription(`**${q.q}**\n\n${choices}\n\nType your answer!`).setFooter({text:'30 seconds!'}).setTimestamp()]});
      setTimeout(()=>{if(triviaGames[message.channel.id]){delete triviaGames[message.channel.id];message.channel.send({embeds:[errorEmbed(`Time's up! Answer: **${q.c.find(c=>c.toLowerCase()===q.a)}**`)]}).catch(()=>{});}},30000);
      break;
    }

    case 'guess': {
      if(guessGames[message.channel.id]) return message.reply('❌ Already running!');
      const n=Math.floor(Math.random()*100)+1;
      guessGames[message.channel.id]={number:n,attempts:0,userId:message.author.id};
      message.reply({embeds:[infoEmbed('🔢 Guess the Number','I picked a number **1–100**!\nType your guess. **7 attempts**. 60 seconds!')]});
      setTimeout(()=>{if(guessGames[message.channel.id]){delete guessGames[message.channel.id];message.channel.send({embeds:[errorEmbed(`Time's up! Number was **${n}**.`)]}).catch(()=>{});}},60000);
      break;
    }

    case 'rps': {
      const map={rock:'🪨',paper:'📄',scissors:'✂️'};
      const uc=args[0]?.toLowerCase(); if(!map[uc]) return message.reply('❌ Choose `rock`, `paper`, or `scissors`!');
      const bc=Object.keys(map)[Math.floor(Math.random()*3)];
      const wins={rock:'scissors',paper:'rock',scissors:'paper'};
      const res=uc===bc?'🤝 Tie!':wins[uc]===bc?'🎉 You win!':'🤖 I win!';
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('✊ RPS').setDescription(`You: **${map[uc]} ${uc}**\nMe: **${map[bc]} ${bc}**\n\n${res}`).setTimestamp()]});
      break;
    }

    case 'blackjack': case 'bj': {
      if(bjGames[message.author.id]) return message.reply('❌ Finish your current game first!');
      const bet=parseInt(args[0])||50;
      const deck=makeDeck();
      const ph=[drawCard(deck),drawCard(deck)], dh=[drawCard(deck),drawCard(deck)];
      bjGames[message.author.id]={deck,playerHand:ph,dealerHand:dh,bet};
      if(handValue(ph)===21){delete bjGames[message.author.id];return message.reply({embeds:[successEmbed('🃏 Blackjack! 🎉',`Natural Blackjack! Win **${Math.floor(bet*2.5)} coins**!\nHand: ${fmtHand(ph)}`)]});}
      message.reply({embeds:[buildBJEmbed(bjGames[message.author.id])],components:buildBJRows()});
      break;
    }

    case 'slots': {
      const now=Date.now();
      if(slotsCD[message.author.id]&&now-slotsCD[message.author.id]<10000) return message.reply(`❌ Cooldown! Wait **${Math.ceil((10000-(now-slotsCD[message.author.id]))/1000)}s**.`);
      slotsCD[message.author.id]=now;
      const syms=['🍒','🍋','🍊','🍇','⭐','💎','7️⃣'], spin=()=>syms[Math.floor(Math.random()*syms.length)];
      const [s1,s2,s3]=[spin(),spin(),spin()];
      const won=s1===s2&&s2===s3, jp=won&&s1==='💎';
      message.reply({embeds:[new EmbedBuilder().setColor(jp?'#FFD700':won?'#57F287':'#ED4245')
        .setTitle(`🎰 Slots${jp?' — JACKPOT! 🎊':won?' — Winner! 🎉':''}`)
        .setDescription(`╔══════════╗\n║  ${s1} │ ${s2} │ ${s3}  ║\n╚══════════╝\n\n${jp?'💎 **JACKPOT! 1000 coins!**':won?'🎉 **You win 100 coins!**':'😞 No luck. Try again!'}`)
        .setTimestamp()]});
      break;
    }

    case 'mines': {
      if(minesGames[message.author.id]) return message.reply('❌ Finish your current mines game first!');
      const bet=parseInt(args[0])||50, mc=parseInt(args[1])||5;
      if(mc<1||mc>20) return message.reply('❌ Mines must be 1–20.');
      const mines=[];
      while(mines.length<mc){const i=Math.floor(Math.random()*25);if(!mines.includes(i))mines.push(i);}
      minesGames[message.author.id]={userId:message.author.id,bet,mines,revealed:Array(25).fill(false),found:0,multiplier:1.0};
      const g=minesGames[message.author.id];
      message.reply({embeds:[infoEmbed('💎 Mines',`Bet: **${bet} coins** | Mines: **${mc}**\nClick tiles to find gems! Avoid 💣\nCash out anytime!`)],components:buildMinesRows(g,false)});
      break;
    }

    case 'connect4': case 'c4': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(c4Games[message.channel.id]) return message.reply('❌ Game already running here!');
      const g={board:makeC4Board(),player1:message.author.id,player2:opp.id,currentPlayer:message.author.id,symbol:'🔴'};
      c4Games[message.channel.id]=g;
      message.reply({embeds:[buildC4Embed(g,`<@${message.author.id}>'s turn (🔴)`)],components:buildC4Rows(false)});
      break;
    }

    case 'wordle': {
      if(wordleGames[message.channel.id]) return message.reply('❌ Wordle already running here!');
      const word=WORDLE_WORDS[Math.floor(Math.random()*WORDLE_WORDS.length)];
      wordleGames[message.channel.id]={word,guesses:[],userId:message.author.id};
      message.reply({embeds:[new EmbedBuilder().setColor('#538D4E').setTitle('🟩 Wordle')
        .setDescription('Guess the **5-letter word** in 6 tries!\n\n🟩 Right letter + spot\n🟨 Right letter, wrong spot\n⬛ Wrong letter\n\nType your first guess!')
        .setFooter({text:'6 guesses'}).setTimestamp()]});
      break;
    }

    // ── TICKET & WELCOME ─────────────────────────────────────────────────────

    case 'ticket': {
      if(!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return missingPerm(message,'Manage Server');
      const cfg=getTicketSettings(message.guild.id);
      await message.channel.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(cfg.panelTitle).setDescription(cfg.panelDesc).setFooter({text:message.guild.name}).setTimestamp()],
        components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel(cfg.buttonLabel).setStyle(ButtonStyle.Primary))]});
      await message.delete().catch(()=>{});
      break;
    }

    case 'ticketset': {
      if(!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return missingPerm(message,'Manage Server');
      if(setupSessions[message.author.id]) delete setupSessions[message.author.id];
      const cfg=getTicketSettings(message.guild.id);
      const STEPS=[
        {key:'panelTitle', question:'**Step 1/6 — Panel Title**',            validate:v=>v.length<=256||'Max 256 chars.'},
        {key:'panelDesc',  question:'**Step 2/6 — Panel Description**',       validate:v=>v.length<=4096||'Max 4096 chars.'},
        {key:'buttonLabel',question:'**Step 3/6 — Button Label**',             validate:v=>v.length<=80||'Max 80 chars.'},
        {key:'channelName',question:'**Step 4/6 — Channel Name** (`{username}` supported)', validate:v=>/^[a-z0-9\-{}_]+$/i.test(v)||'Letters/numbers/hyphens only.'},
        {key:'insideTitle',question:'**Step 5/6 — Inside Ticket Title**',      validate:v=>v.length<=256||'Max 256 chars.'},
        {key:'insideDesc', question:'**Step 6/6 — Inside Ticket Message** (`{mention}` = user ping)', validate:v=>v.length<=4096||'Max 4096 chars.'},
      ];
      setupSessions[message.author.id]={step:0,draft:{...cfg},guildId:message.guild.id,channelId:message.channel.id,steps:STEPS};
      message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('⚙️ Ticket Setup Wizard').setDescription(`${STEPS[0].question}\n\nCurrent: \`${cfg[STEPS[0].key]}\``).setFooter({text:'"skip" to keep • "cancel" to stop'}).setTimestamp()]});
      break;
    }

    case 'ticketreset': {
      if(!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return missingPerm(message,'Manage Server');
      delete ticketSettings[message.guild.id]; getTicketSettings(message.guild.id);
      message.reply({embeds:[successEmbed('Reset','All ticket settings reset to defaults.')]});
      break;
    }

    case 'welcomeset': case 'wset': {
      if(!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return missingPerm(message,'Manage Server');
      const wcfg=getWelcomeSettings(message.guild.id);
      const pm=await message.reply({embeds:[buildWelcomePanel(message.guild,wcfg)],components:buildWelcomeRows(wcfg)});
      welcomePanelMessages[message.guild.id]=pm;
      break;
    }

    case 'welcometest': case 'wtest': {
      if(!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return missingPerm(message,'Manage Server');
      const wcfg=getWelcomeSettings(message.guild.id);
      if(!wcfg.channelId) return message.reply({embeds:[errorEmbed('No welcome channel set.')]});
      const ch=message.guild.channels.cache.get(wcfg.channelId);
      if(!ch) return message.reply({embeds:[errorEmbed('Channel not found.')]});
      const mem=message.member;
      let sm;
      if(wcfg.mode==='embed'){
        const e=new EmbedBuilder().setColor(wcfg.color||'#57F287').setTitle(resolvePlaceholders(wcfg.title,mem)).setDescription(resolvePlaceholders(wcfg.description,mem)).setTimestamp();
        if(wcfg.thumbnail) e.setThumbnail(mem.user.displayAvatarURL({forceStatic:false}));
        if(wcfg.footer) e.setFooter({text:resolvePlaceholders(wcfg.footer,mem)});
        sm=await ch.send({embeds:[e]});
      } else sm=await ch.send(resolvePlaceholders(wcfg.text,mem));
      if(wcfg.deleteAfter>0) setTimeout(()=>sm.delete().catch(()=>{}),wcfg.deleteAfter*1000);
      message.reply({embeds:[successEmbed('Test Sent',`Welcome sent to <#${wcfg.channelId}>.`)]});
      break;
    }

    // ── STATUS ───────────────────────────────────────────────────────────────

    case 'addstatus': {
      if(message.author.id!==client.application.owner?.id&&message.author.id!==process.env.OWNER_ID) return message.reply('❌ Bot owner only.');
      const types=['PLAYING','WATCHING','LISTENING','COMPETING'];
      const type=args[0]?.toUpperCase(); if(!types.includes(type)) return message.reply('❌ Types: playing watching listening competing');
      const txt=args.slice(1).join(' '); if(!txt) return message.reply('❌ Provide status text.');
      statusList.push({text:txt,type}); startStatusSystem();
      message.reply({embeds:[successEmbed('Status Added',`**${type}:** \`${txt}\``)]});
      break;
    }

    case 'removestatus': {
      if(message.author.id!==client.application.owner?.id&&message.author.id!==process.env.OWNER_ID) return message.reply('❌ Bot owner only.');
      const i=parseInt(args[0])-1; if(isNaN(i)||i<0||i>=statusList.length) return message.reply('❌ Invalid number.');
      const r=statusList.splice(i,1)[0]; statusIndex=0; startStatusSystem();
      message.reply({embeds:[successEmbed('Removed',`\`${r.text}\` removed.`)]});
      break;
    }

    case 'liststatus':
      if(!statusList.length) return message.reply({embeds:[infoEmbed('🎭 Status List','No statuses set.')]});
      message.reply({embeds:[infoEmbed(`🎭 Status List (${statusList.length})`,statusList.map((s,i)=>`**${i+1}.** \`${s.type}\` — ${s.text}`).join('\n')).setFooter({text:statusList.length===1?'📌 Permanent':`🔄 Every ${STATUS_DELAY/1000}s`})]});
      break;

    case 'clearstatus': {
      if(message.author.id!==client.application.owner?.id&&message.author.id!==process.env.OWNER_ID) return message.reply('❌ Bot owner only.');
      statusList.length=0; statusIndex=0; stopSlideshow(); client.user.setActivity(null);
      message.reply({embeds:[successEmbed('Cleared','All statuses removed.')]});
      break;
    }

    default: break;
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('❌ Login failed. Check DISCORD_TOKEN:', e.message);
  process.exit(1);
});
