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
    .setDescription(`**${member.user.username}** left the server.`)
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
// New games (batch 1)
const snakeGames = {}, game2048 = {}, rpsGames = {}, mathDuelGames = {}, wordChainGames = {}, triviaBattleGames = {};
// New games (batch 2)
const battleshipGames = {}, memoryGames = {}, holGames = {}, dicePokerGames = {}, scrambleGames = {}, emojiDecodeGames = {};

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

// ─── Snake Helpers ────────────────────────────────────────────────────────────
const SNAKE_W = 8, SNAKE_H = 6;
function makeSnakeGame() {
  const snake = [{x:3,y:2},{x:2,y:2}];
  let food; do { food={x:Math.floor(Math.random()*SNAKE_W),y:Math.floor(Math.random()*SNAKE_H)}; }
  while (snake.some(s=>s.x===food.x&&s.y===food.y));
  return { snake, food, dir:{x:1,y:0}, score:0, alive:true };
}
function renderSnake(g) {
  const grid=[];
  for(let y=0;y<SNAKE_H;y++){const row=[];for(let x=0;x<SNAKE_W;x++) row.push('⬛');grid.push(row);}
  g.snake.forEach((s,i)=>{if(s.y>=0&&s.y<SNAKE_H&&s.x>=0&&s.x<SNAKE_W) grid[s.y][s.x]=i===0?'🟢':'🟩';});
  if(g.food.y>=0&&g.food.y<SNAKE_H&&g.food.x>=0&&g.food.x<SNAKE_W) grid[g.food.y][g.food.x]='🍎';
  return grid.map(r=>r.join('')).join('\n');
}
function moveSnake(g, dir) {
  const dirMap={up:{x:0,y:-1},down:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}};
  if(dir) g.dir=dirMap[dir];
  const head={x:g.snake[0].x+g.dir.x,y:g.snake[0].y+g.dir.y};
  if(head.x<0||head.x>=SNAKE_W||head.y<0||head.y>=SNAKE_H||g.snake.some(s=>s.x===head.x&&s.y===head.y)){g.alive=false;return;}
  g.snake.unshift(head);
  if(head.x===g.food.x&&head.y===g.food.y){
    g.score++;
    let food; do{ food={x:Math.floor(Math.random()*SNAKE_W),y:Math.floor(Math.random()*SNAKE_H)}; }while(g.snake.some(s=>s.x===food.x&&s.y===food.y));
    g.food=food;
  } else g.snake.pop();
}
function buildSnakeEmbed(g, uid) {
  return new EmbedBuilder().setColor(g.alive?'#57F287':'#ED4245').setTitle(`🐍 Snake${g.alive?'':' — Game Over!'}`)
    .setDescription(`${renderSnake(g)}\n\n**Score:** ${g.score} | **Length:** ${g.snake.length}`)
    .setFooter({text:g.alive?'Use buttons to move!':'Game over!'}).setTimestamp();
}
function buildSnakeRows(disabled) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('snake:noop').setLabel('↖').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('snake:up').setLabel('⬆️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('snake:noop2').setLabel('↗').setStyle(ButtonStyle.Secondary).setDisabled(true),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('snake:left').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('snake:down').setLabel('⬇️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('snake:right').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('snake:quit').setLabel('🛑 Quit').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    ),
  ];
}

// ─── 2048 Helpers ─────────────────────────────────────────────────────────────
function make2048Board() {
  const b=Array.from({length:4},()=>Array(4).fill(0));
  spawn2048(b); spawn2048(b); return b;
}
function spawn2048(b) {
  const empty=[];
  for(let r=0;r<4;r++) for(let c=0;c<4;c++) if(!b[r][c]) empty.push([r,c]);
  if(!empty.length) return;
  const [r,c]=empty[Math.floor(Math.random()*empty.length)];
  b[r][c]=Math.random()<0.9?2:4;
}
function slide2048Row(row) {
  let r=row.filter(v=>v); let score=0;
  for(let i=0;i<r.length-1;i++) if(r[i]===r[i+1]){r[i]*=2;score+=r[i];r.splice(i+1,1);i++;}
  while(r.length<4) r.push(0);
  return {row:r,score};
}
function move2048(b, dir) {
  let moved=false, score=0;
  const nb=b.map(r=>[...r]);
  const ops={left:()=>{for(let r=0;r<4;r++){const{row,score:s}=slide2048Row(nb[r]);if(row.join()!==nb[r].join())moved=true;nb[r]=row;score+=s;}},
    right:()=>{for(let r=0;r<4;r++){const rev=[...nb[r]].reverse();const{row,score:s}=slide2048Row(rev);const fin=row.reverse();if(fin.join()!==nb[r].join())moved=true;nb[r]=fin;score+=s;}},
    up:()=>{for(let c=0;c<4;c++){const col=nb.map(r=>r[c]);const{row,score:s}=slide2048Row(col);if(row.join()!==col.join())moved=true;for(let r=0;r<4;r++)nb[r][c]=row[r];score+=s;}},
    down:()=>{for(let c=0;c<4;c++){const col=nb.map(r=>r[c]).reverse();const{row,score:s}=slide2048Row(col);const fin=row.reverse();if(fin.join()!==col.reverse().join())moved=true;for(let r=0;r<4;r++)nb[r][c]=fin[r];score+=s;}}
  };
  ops[dir]?.();
  if(moved) spawn2048(nb);
  return {board:nb,moved,score};
}
function render2048(b) {
  const em={0:'⬛',2:'2️⃣',4:'4️⃣',8:'8️⃣',16:'🔟',32:'🔸',64:'🔶',128:'💛',256:'🟡',512:'🟠',1024:'🔴',2048:'⭐'};
  return b.map(r=>r.map(v=>em[v]??'🌟').join('')).join('\n');
}
function build2048Embed(g) {
  const best=Math.max(...g.board.flat());
  return new EmbedBuilder().setColor('#FEE75C').setTitle('🎯 2048')
    .setDescription(`${render2048(g.board)}\n\n**Score:** ${g.score} | **Best Tile:** ${best}`)
    .setFooter({text:'Swipe tiles to combine them!'}).setTimestamp();
}
function build2048Rows(disabled) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('2048:noop').setLabel(' ').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('2048:up').setLabel('⬆️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('2048:noop2').setLabel(' ').setStyle(ButtonStyle.Secondary).setDisabled(true),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('2048:left').setLabel('⬅️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('2048:down').setLabel('⬇️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
      new ButtonBuilder().setCustomId('2048:right').setLabel('➡️').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    ),
  ];
}

// ─── RPS Tournament Helpers ───────────────────────────────────────────────────
const RPS_EMOJI={rock:'🪨',paper:'📄',scissors:'✂️'};
const RPS_BEATS={rock:'scissors',scissors:'paper',paper:'rock'};
function buildRPSLobbyEmbed(g) {
  return new EmbedBuilder().setColor('#FEE75C').setTitle('🎮 Rock Paper Scissors — Multiplayer')
    .setDescription(`**Best of ${g.bestOf}** | Round **${g.round}/${g.bestOf}**\n\n<@${g.p1}> ${g.score1} — ${g.score2} <@${g.p2}>\n\n*Waiting for both players to pick...*\n${g.choice1?`✅ <@${g.p1}> has chosen`:'⏳ <@'+g.p1+'> thinking...'}\n${g.choice2?`✅ <@${g.p2}> has chosen`:'⏳ <@'+g.p2+'> thinking...'}`)
    .setTimestamp();
}
function buildRPSRows(disabled) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('rps:rock').setLabel('🪨 Rock').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('rps:paper').setLabel('📄 Paper').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('rps:scissors').setLabel('✂️ Scissors').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

// ─── Math Duel Helpers ────────────────────────────────────────────────────────
function genMathQ(diff) {
  if(diff===1){const a=Math.floor(Math.random()*20)+1,b=Math.floor(Math.random()*20)+1;return{q:`${a} + ${b}`,a:a+b};}
  if(diff===2){const a=Math.floor(Math.random()*12)+2,b=Math.floor(Math.random()*12)+2;return{q:`${a} × ${b}`,a:a*b};}
  const a=Math.floor(Math.random()*30)+5,b=Math.floor(Math.random()*30)+5;return{q:`${a} × ${b} - ${Math.floor(a/2)}`,a:a*b-Math.floor(a/2)};
}
function buildMathEmbed(g) {
  const bar = (n,max) => n===0?'░░░░░░░░░░':'█'.repeat(Math.round(n/max*10))+'░'.repeat(10-Math.round(n/max*10));
  return new EmbedBuilder().setColor('#5865F2').setTitle('🧮 Math Duel')
    .setDescription(`**Question ${g.qNum}/5** (Diff: ${'⭐'.repeat(g.diff)})\n\n> 🔢 **${g.current.q} = ?**\n\nType your answer in chat — fastest correct answer wins the point!\n\n<@${g.p1}> \`${bar(g.score1,5)}\` ${g.score1}pts\n<@${g.p2}> \`${bar(g.score2,5)}\` ${g.score2}pts`)
    .setFooter({text:`⏱️ 15 seconds per question`}).setTimestamp();
}

// ─── Word Chain Helpers ───────────────────────────────────────────────────────
function buildWordChainEmbed(g) {
  const chain=g.chain.slice(-5).join(' → ');
  return new EmbedBuilder().setColor('#9B59B6').setTitle('🔗 Word Chain')
    .setDescription(`**Chain:** ${chain||'*Starting soon...*'}\n\n**Last word ends in:** \`${g.lastLetter.toUpperCase()}\`\n\n<@${g.currentTurn}>'s turn! Type a word starting with **${g.lastLetter.toUpperCase()}**`)
    .addFields(
      {name:'<@'+g.p1+'> Lives',value:'❤️'.repeat(g.lives1||3)+'🖤'.repeat(3-(g.lives1||3)),inline:true},
      {name:'<@'+g.p2+'> Lives',value:'❤️'.repeat(g.lives2||3)+'🖤'.repeat(3-(g.lives2||3)),inline:true},
    ).setFooter({text:'15 seconds to answer • Used words cannot repeat'}).setTimestamp();
}

// ─── Trivia Battle Helpers ────────────────────────────────────────────────────
const TRIVIA_BATTLE_Q = [
  {q:'What is 7 × 8?', a:'56', choices:['48','56','64','72']},
  {q:'Which planet has rings?', a:'Saturn', choices:['Jupiter','Saturn','Uranus','Neptune']},
  {q:'Capital of Japan?', a:'Tokyo', choices:['Osaka','Kyoto','Tokyo','Hiroshima']},
  {q:'Largest mammal?', a:'Blue Whale', choices:['Elephant','Giraffe','Blue Whale','Hippo']},
  {q:'H2O is?', a:'Water', choices:['Hydrogen','Oxygen','Water','Salt']},
  {q:'Speed of light (approx)?', a:'300,000 km/s', choices:['150,000 km/s','300,000 km/s','450,000 km/s','600,000 km/s']},
  {q:'Who invented the telephone?', a:'Bell', choices:['Edison','Bell','Tesla','Marconi']},
  {q:'First element in periodic table?', a:'Hydrogen', choices:['Helium','Oxygen','Hydrogen','Carbon']},
  {q:'Largest continent?', a:'Asia', choices:['Africa','Asia','Europe','America']},
  {q:'Number of bones in adult body?', a:'206', choices:['196','206','216','226']},
];
function buildTriviaBattleEmbed(g) {
  const q=g.questions[g.qNum];
  const bar = n => '█'.repeat(n)+'░'.repeat(5-n);
  return new EmbedBuilder().setColor('#E67E22').setTitle(`⚡ Trivia Battle — Q${g.qNum+1}/${g.questions.length}`)
    .setDescription(`**${q.q}**\n\nA) ${q.choices[0]}\nB) ${q.choices[1]}\nC) ${q.choices[2]}\nD) ${q.choices[3]}\n\n<@${g.p1}> \`[${bar(g.score1)}]\` ${g.score1}pts\n<@${g.p2}> \`[${bar(g.score2)}]\` ${g.score2}pts`)
    .setFooter({text:'Both players answer! First correct wins the point!'}).setTimestamp();
}
function buildTriviaBattleRows(disabled) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tb:0').setLabel('A').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('tb:1').setLabel('B').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('tb:2').setLabel('C').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('tb:3').setLabel('D').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  )];
}

// ─── Battleship Helpers ───────────────────────────────────────────────────────
const BS_SIZE = 5;
const BS_SHIPS = [{name:'Carrier',len:3},{name:'Destroyer',len:2},{name:'Sub',len:1},{name:'Sub2',len:1}]; // total 7 cells on 5x5
function makeBSBoard() { return Array.from({length:BS_SIZE},()=>Array(BS_SIZE).fill(0)); }
function placeBSShips(board) {
  const ships=[];
  for(const ship of BS_SHIPS){
    let placed=false;
    while(!placed){
      const horiz=Math.random()<0.5;
      const r=Math.floor(Math.random()*(BS_SIZE-(horiz?0:ship.len)));
      const c=Math.floor(Math.random()*(BS_SIZE-(horiz?ship.len:0)));
      const cells=[];
      let ok=true;
      for(let i=0;i<ship.len;i++){
        const sr=r+(horiz?0:i), sc=c+(horiz?i:0);
        if(board[sr][sc]!==0){ok=false;break;}
        cells.push([sr,sc]);
      }
      if(ok){cells.forEach(([sr,sc])=>{board[sr][sc]=1;});ships.push({name:ship.name,cells,hits:0,len:ship.len});placed=true;}
    }
  }
  return ships;
}
function renderBSGrid(board, shots, showShips=false) {
  const COLS='ABCDE';
  let out='`  A B C D E`\n';
  for(let r=0;r<BS_SIZE;r++){
    let row=`\`${r+1} `;
    for(let c=0;c<BS_SIZE;c++){
      const hit=shots.some(s=>s[0]===r&&s[1]===c);
      if(hit){ row+=board[r][c]===1?'💥':'〰'; }
      else if(showShips&&board[r][c]===1){ row+='🚢'; }
      else { row+='🟦'; }
    }
    out+=row+'`\n';
  }
  return out;
}
function parseBSCoord(str) {
  const m=str.trim().toUpperCase().match(/^([A-E])([1-5])$/);
  if(!m) return null;
  return [parseInt(m[2])-1,'ABCDE'.indexOf(m[1])];
}
function buildBSEmbed(g, whose='your') {
  const opp=whose==='your'?g.p2:g.p1;
  const board=whose==='your'?g.board2:g.board1;
  const shots=whose==='your'?g.shots1:g.shots2;
  const ships=whose==='your'?g.ships2:g.ships1;
  const sunk=ships.filter(s=>s.hits>=s.len).length;
  return new EmbedBuilder().setColor('#3498DB').setTitle(`🚢 Battleship — <@${g.currentTurn}>'s Turn`)
    .setDescription(`**Your Attack Grid** (targeting <@${opp}>)\n${renderBSGrid(board,shots)}\n💥 Hits shown | 〰 Miss | 🟦 Unknown\n\n**Ships sunk:** ${sunk}/${ships.length} | Type a coordinate like \`A1\`, \`C3\`, \`E5\``)
    .setTimestamp();
}

// ─── Memory Match Helpers ─────────────────────────────────────────────────────
const MEM_EMOJIS = ['🍎','🍊','🍋','🍇','🍓','🎯','⭐','🔥','💎','🎸','🌈','🦋'];
function makeMemoryGame() {
  const pairs=[...MEM_EMOJIS.slice(0,6),...MEM_EMOJIS.slice(0,6)];
  for(let i=pairs.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pairs[i],pairs[j]]=[pairs[j],pairs[i]];}
  return {cards:pairs,flipped:Array(12).fill(false),matched:Array(12).fill(false),first:null,score:0,moves:0};
}
function renderMemory(g) {
  let out='';
  for(let i=0;i<12;i++){
    out+=(g.flipped[i]||g.matched[i])?g.cards[i]:'🟦';
    if((i+1)%4===0) out+='\n';
  }
  return out;
}
function buildMemoryRows(g,disabled) {
  const rows=[];
  for(let r=0;r<3;r++){
    const row=new ActionRowBuilder();
    for(let c=0;c<4;c++){
      const i=r*4+c;
      row.addComponents(new ButtonBuilder().setCustomId(`mem:${i}`).setLabel(`${i+1}`).setStyle(g.matched[i]?ButtonStyle.Success:g.flipped[i]?ButtonStyle.Primary:ButtonStyle.Secondary).setDisabled(disabled||g.matched[i]||g.flipped[i]));
    }
    rows.push(row);
  }
  return rows;
}

// ─── Higher or Lower Helpers ──────────────────────────────────────────────────
const HOL_ITEMS = [
  {name:'Mount Everest Height',val:8849,unit:'m'},
  {name:'Speed of Sound',val:343,unit:'m/s'},
  {name:'Days in a Leap Year',val:366,unit:'days'},
  {name:'Human Body Temperature',val:37,unit:'°C'},
  {name:'FIFA World Cup Teams (2026)',val:48,unit:'teams'},
  {name:'Average Human Heartbeats/min',val:72,unit:'bpm'},
  {name:'Layers of Earth',val:4,unit:'layers'},
  {name:'Bones in Human Hand',val:27,unit:'bones'},
  {name:'Teeth in Adult Human',val:32,unit:'teeth'},
  {name:'Planets in Solar System',val:8,unit:'planets'},
  {name:'Countries in Africa',val:54,unit:'countries'},
  {name:'Letters in English Alphabet',val:26,unit:'letters'},
  {name:'Days in February (non-leap)',val:28,unit:'days'},
  {name:'Legs on a Spider',val:8,unit:'legs'},
  {name:'Sides of a Hexagon',val:6,unit:'sides'},
  {name:'Floors in Burj Khalifa',val:163,unit:'floors'},
  {name:'Olympic Rings',val:5,unit:'rings'},
  {name:'Miles in a Marathon',val:26,unit:'miles'},
  {name:'Ribs in a Human',val:24,unit:'ribs'},
  {name:'Seconds in an Hour',val:3600,unit:'seconds'},
];
function buildHOLEmbed(g) {
  const cur=g.items[g.idx];
  const prev=g.idx>0?g.items[g.idx-1]:null;
  return new EmbedBuilder().setColor('#1ABC9C').setTitle('📊 Higher or Lower')
    .setDescription(
      (prev?`**Previous:** ${prev.name}\n> **${prev.val} ${prev.unit}**\n\n`:'') +
      `**Current:** ${cur.name}\n> **${g.idx===0?`${cur.val} ${cur.unit}`:'??? ' +cur.unit}**\n\n` +
      `Is it **Higher** or **Lower** than ${prev?`${prev.val} ${prev.unit}`:'the previous'}?\n\n` +
      `⭐ **Streak:** ${g.streak} | 🏆 **Best:** ${g.best}`
    ).setFooter({text:'Click a button to guess!'}).setTimestamp();
}
function buildHOLRows(disabled) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('hol:higher').setLabel('📈 Higher').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('hol:lower').setLabel('📉 Lower').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('hol:quit').setLabel('🛑 Quit').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  )];
}

// ─── Dice Poker Helpers ───────────────────────────────────────────────────────
function rollDice(n=5) { return Array.from({length:n},()=>Math.floor(Math.random()*6)+1); }
function diceFace(n) { return ['','⚀','⚁','⚂','⚃','⚄','⚅'][n]; }
function evalDiceHand(dice) {
  const counts={};
  dice.forEach(d=>{counts[d]=(counts[d]||0)+1;});
  const vals=Object.values(counts).sort((a,b)=>b-a);
  const sorted=[...new Set(dice)].sort((a,b)=>a-b);
  const isStr=sorted.length===5&&sorted[4]-sorted[0]===4;
  if(vals[0]===5) return {rank:8,name:'🎰 Five of a Kind!'};
  if(isStr&&dice.includes(6)) return {rank:7,name:'👑 Royal Straight!'};
  if(isStr) return {rank:6,name:'🔀 Straight!'};
  if(vals[0]===4) return {rank:5,name:'4️⃣ Four of a Kind!'};
  if(vals[0]===3&&vals[1]===2) return {rank:4,name:'🏠 Full House!'};
  if(vals[0]===3) return {rank:3,name:'3️⃣ Three of a Kind!'};
  if(vals[0]===2&&vals[1]===2) return {rank:2,name:'👥 Two Pair!'};
  if(vals[0]===2) return {rank:1,name:'👤 One Pair!'};
  return {rank:0,name:'💨 High Card'};
}
function buildDPEmbed(g, phase) {
  const diceStr=g.dice.map((d,i)=>g.held[i]?`[${diceFace(d)}]`:diceFace(d)).join(' ');
  const hand=evalDiceHand(g.dice);
  return new EmbedBuilder().setColor('#E74C3C').setTitle('🎲 Dice Poker')
    .setDescription(`**Your Dice:**\n${diceStr}\n\n**Hand:** ${hand.name}\n\n${phase==='hold'?`Hold dice you want to keep, then click **Roll!** (${g.rerolls} reroll${g.rerolls!==1?'s':''} left)`:`**Bet:** ${g.bet} coins\n\nResult: ${hand.rank>=3?`🏆 Win! +${g.bet*hand.rank} coins`:hand.rank>=1?`↩️ Push — coins back`:hand.rank===0?`😞 Loss — -${g.bet} coins`:''}`}`)
    .setTimestamp();
}
function buildDPHoldRows(dice,held,disabled) {
  const row1=new ActionRowBuilder();
  dice.forEach((_,i)=>row1.addComponents(new ButtonBuilder().setCustomId(`dp:hold:${i}`).setLabel(`${held[i]?'✅':'⬜'} Die ${i+1}`).setStyle(held[i]?ButtonStyle.Success:ButtonStyle.Secondary).setDisabled(disabled)));
  const row2=new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dp:roll').setLabel('🎲 Roll!').setStyle(ButtonStyle.Primary).setDisabled(disabled),
  );
  return [row1,row2];
}

// ─── Scramble Helpers ─────────────────────────────────────────────────────────
const SCRAMBLE_WORDS = [
  {word:'PYTHON',hint:'A programming language 🐍'},
  {word:'DISCORD',hint:'A chat platform 💬'},
  {word:'KEYBOARD',hint:'You type on this ⌨️'},
  {word:'ELEPHANT',hint:'Biggest land animal 🐘'},
  {word:'DIAMOND',hint:'Hardest natural material 💎'},
  {word:'VAMPIRE',hint:'Drinks blood 🧛'},
  {word:'RAINBOW',hint:'Appears after rain 🌈'},
  {word:'THUNDER',hint:'Loud sky sound ⚡'},
  {word:'CAPTAIN',hint:'Leader of a ship 🚢'},
  {word:'JUNGLE',hint:'Dense tropical forest 🌿'},
  {word:'WIZARD',hint:'Uses magic spells 🧙'},
  {word:'PLANET',hint:'Orbits a star 🪐'},
  {word:'ROCKET',hint:'Goes to space 🚀'},
  {word:'CASTLE',hint:'Medieval fortress 🏰'},
  {word:'PIRATE',hint:'Sails the seas 🏴‍☠️'},
];
function scrambleWord(word) {
  const arr=word.split('');
  let s;
  do { for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];} s=arr.join(''); } while(s===word);
  return s;
}

// ─── Emoji Decode Helpers ─────────────────────────────────────────────────────
const EMOJI_PUZZLES = [
  {emojis:'🐟🍕',answer:'fishpizza',display:'Fish Pizza',hint:'A food combo 🍕'},
  {emojis:'🌙🌟',answer:'moonstar',display:'Moon Star',hint:'Night sky things 🌙'},
  {emojis:'🔥💧',answer:'firewater',display:'Fire Water',hint:'Opposites ⚡'},
  {emojis:'🐻🏫',answer:'bearschool',display:'Bear School',hint:'Animal education 📚'},
  {emojis:'🌊🏄',answer:'surfwave',display:'Surf Wave',hint:'Beach sport 🏄'},
  {emojis:'🦁👑',answer:'lionking',display:'Lion King',hint:'Famous movie! 🎬'},
  {emojis:'❄️⛄',answer:'snowman',display:'Snow Man',hint:'Winter figure ⛄'},
  {emojis:'🐸🎤',answer:'frogmicrophone',display:'Frog Microphone',hint:'Singing amphibian 🎤'},
  {emojis:'🌹💀',answer:'rosebone',display:'Rose Bone',hint:'Beauty and death 💀'},
  {emojis:'🎸⚡',answer:'rockelectricity',display:'Rock Electricity',hint:'Electric rock ⚡'},
  {emojis:'🐉🔥',answer:'dragonfire',display:'Dragon Fire',hint:'Fantasy creature ⚔️'},
  {emojis:'🌻☀️',answer:'sunflowersun',display:'Sunflower Sun',hint:'Bright things 🌻'},
  {emojis:'👻🏠',answer:'ghosthouse',display:'Ghost House',hint:'Haunted! 👻'},
  {emojis:'🐧❄️',answer:'penguinice',display:'Penguin Ice',hint:'Antarctic bird 🐧'},
  {emojis:'🦊🌲',answer:'foxforest',display:'Fox Forest',hint:'Wild animal habitat 🌲'},
];

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

  // Snake
  if (interaction.isButton() && interaction.customId.startsWith('snake:')) {
    const action = interaction.customId.split(':')[1];
    const game = snakeGames[interaction.user.id];
    if (!game) return interaction.reply({content:'❌ No snake game. Use `!snake` to start.',ephemeral:true});
    if (interaction.user.id !== game.userId) return interaction.reply({content:'❌ Not your game!',ephemeral:true});
    if (!game.alive) return interaction.update({embeds:[buildSnakeEmbed(game,game.userId)],components:buildSnakeRows(true)});
    if (action==='quit') { game.alive=false; delete snakeGames[interaction.user.id]; return interaction.update({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🐍 Snake — Quit').setDescription(`${renderSnake(game)}\n\n**Final Score:** ${game.score}`).setTimestamp()],components:[]}); }
    if (action==='noop'||action==='noop2') return interaction.reply({content:'⬛',ephemeral:true});
    const opposite={up:'down',down:'up',left:'right',right:'left'};
    const curDir=Object.keys({up:{x:0,y:-1},down:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}}).find(k=>{const dm={up:{x:0,y:-1},down:{x:0,y:1},left:{x:-1,y:0},right:{x:1,y:0}};return dm[k].x===game.dir.x&&dm[k].y===game.dir.y;});
    if (action===opposite[curDir]) return interaction.reply({content:"❌ Can't reverse direction!",ephemeral:true});
    moveSnake(game, action);
    if (!game.alive) { delete snakeGames[interaction.user.id]; return interaction.update({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🐍 Snake — Game Over! 💀').setDescription(`${renderSnake(game)}\n\n**Final Score:** ${game.score} | **Length:** ${game.snake.length}\n\n${game.score>=10?'🏆 Amazing!':game.score>=5?'😎 Good run!':'💪 Keep practicing!'}`).setTimestamp()],components:[]}); }
    return interaction.update({embeds:[buildSnakeEmbed(game,game.userId)],components:buildSnakeRows(false)});
  }

  // 2048
  if (interaction.isButton() && interaction.customId.startsWith('2048:')) {
    const action = interaction.customId.split(':')[1];
    const game = game2048[interaction.user.id];
    if (!game) return interaction.reply({content:'❌ No 2048 game. Use `!2048` to start.',ephemeral:true});
    if (interaction.user.id !== game.userId) return interaction.reply({content:'❌ Not your game!',ephemeral:true});
    if (action==='noop'||action==='noop2') return interaction.reply({content:'⬛',ephemeral:true});
    const {board,moved,score} = move2048(game.board, action);
    game.board=board; game.score+=score;
    const best=Math.max(...board.flat());
    const hasMove = ['up','down','left','right'].some(d=>move2048(board,d).moved);
    if (best>=2048) {
      delete game2048[interaction.user.id];
      return interaction.update({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🎯 2048 — YOU WIN! 🏆').setDescription(`${render2048(board)}\n\n**Score:** ${game.score}\n\n🌟 **You reached 2048!**`).setTimestamp()],components:[]});
    }
    if (!hasMove) {
      delete game2048[interaction.user.id];
      return interaction.update({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🎯 2048 — Game Over!').setDescription(`${render2048(board)}\n\n**Final Score:** ${game.score}\n\n${game.score>=1000?'👏 Great score!':'💪 Try again!'}`).setTimestamp()],components:[]});
    }
    if (!moved) return interaction.reply({content:'❌ Can\'t move that way!',ephemeral:true});
    return interaction.update({embeds:[build2048Embed(game)],components:build2048Rows(false)});
  }

  // RPS Multiplayer
  if (interaction.isButton() && interaction.customId.startsWith('rps:')) {
    const choice = interaction.customId.split(':')[1];
    const game = rpsGames[interaction.channel.id];
    if (!game) return interaction.reply({content:'❌ No RPS game here.',ephemeral:true});
    const uid = interaction.user.id;
    if (uid!==game.p1&&uid!==game.p2) return interaction.reply({content:'❌ You are not in this game.',ephemeral:true});
    if (uid===game.p1&&game.choice1) return interaction.reply({content:'✅ Already picked!',ephemeral:true});
    if (uid===game.p2&&game.choice2) return interaction.reply({content:'✅ Already picked!',ephemeral:true});
    if (uid===game.p1) game.choice1=choice; else game.choice2=choice;
    if (!game.choice1||!game.choice2) return interaction.update({embeds:[buildRPSLobbyEmbed(game)],components:buildRPSRows(false)});
    // Both chose — resolve
    const c1=game.choice1, c2=game.choice2;
    let roundWinner=null;
    if (c1===c2) { /* tie */ }
    else if (RPS_BEATS[c1]===c2) { game.score1++; roundWinner=game.p1; }
    else { game.score2++; roundWinner=game.p2; }
    const roundDesc=`${RPS_EMOJI[c1]} <@${game.p1}> vs <@${game.p2}> ${RPS_EMOJI[c2]}\n\n${roundWinner?`🏆 <@${roundWinner}> wins this round!`:'🤝 Tie round!'}`;
    game.choice1=null; game.choice2=null; game.round++;
    const needed=Math.ceil(game.bestOf/2);
    if (game.score1>=needed||game.score2>=needed||game.round>game.bestOf) {
      const winner=game.score1>game.score2?game.p1:game.score2>game.score1?game.p2:null;
      delete rpsGames[interaction.channel.id];
      return interaction.update({embeds:[new EmbedBuilder().setColor(winner?'#FFD700':'#5865F2').setTitle(`🎮 RPS — ${winner?'Game Over! 🏆':'Draw!'}`)
        .setDescription(`${roundDesc}\n\n**Final Score:** <@${game.p1}> **${game.score1}** — **${game.score2}** <@${game.p2}>\n\n${winner?`🥇 <@${winner}> WINS THE MATCH!`:'🤝 It\'s a draw!'}`)
        .setTimestamp()],components:[]});
    }
    await interaction.update({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(`🎮 RPS — Round ${game.round-1} Result`).setDescription(`${roundDesc}\n\n**Score:** <@${game.p1}> **${game.score1}** — **${game.score2}** <@${game.p2}>\n\nRound ${game.round} starting...`).setTimestamp()],components:[]});
    await sleep(1500);
    game.choice1=null; game.choice2=null;
    return interaction.editReply({embeds:[buildRPSLobbyEmbed(game)],components:buildRPSRows(false)});
  }

  // Trivia Battle
  if (interaction.isButton() && interaction.customId.startsWith('tb:')) {
    const idx = parseInt(interaction.customId.split(':')[1]);
    const game = triviaBattleGames[interaction.channel.id];
    if (!game) return interaction.reply({content:'❌ No trivia battle here.',ephemeral:true});
    const uid = interaction.user.id;
    if (uid!==game.p1&&uid!==game.p2) return interaction.reply({content:'❌ You are not in this game.',ephemeral:true});
    if (game.answered?.includes(uid)) return interaction.reply({content:'✅ Already answered this round!',ephemeral:true});
    if (!game.answered) game.answered=[];
    game.answered.push(uid);
    const q=game.questions[game.qNum];
    const chosen=q.choices[idx];
    const correct=chosen===q.a;
    if (correct && !game.roundWinner) {
      game.roundWinner=uid;
      if (uid===game.p1) game.score1++; else game.score2++;
    }
    await interaction.reply({content:`${correct?'✅ Correct!':'❌ Wrong!'} ${correct?'You earn a point!':'The other player might get it.'}`,ephemeral:true});
    if (game.answered.length<2) return;
    // Both answered
    const winner=game.roundWinner;
    game.qNum++; game.answered=[]; game.roundWinner=null;
    if (game.qNum>=game.questions.length) {
      const overall=game.score1>game.score2?game.p1:game.score2>game.score1?game.p2:null;
      delete triviaBattleGames[interaction.channel.id];
      return interaction.message.edit({embeds:[new EmbedBuilder().setColor('#E67E22').setTitle('⚡ Trivia Battle — Finished!')
        .setDescription(`**Final Scores:**\n<@${game.p1}> — **${game.score1}** pts\n<@${game.p2}> — **${game.score2}** pts\n\n${overall?`🏆 <@${overall}> WINS!`:'🤝 It\'s a tie!'}`)
        .setTimestamp()],components:[]});
    }
    await sleep(800);
    return interaction.message.edit({embeds:[buildTriviaBattleEmbed(game)],components:buildTriviaBattleRows(false)});
  }

  // Memory Match
  if (interaction.isButton() && interaction.customId.startsWith('mem:')) {
    const idx = parseInt(interaction.customId.split(':')[1]);
    const game = memoryGames[interaction.user.id];
    if (!game) return interaction.reply({content:'❌ No Memory game. Use `!memory` to start.',ephemeral:true});
    if (interaction.user.id !== game.userId) return interaction.reply({content:'❌ Not your game!',ephemeral:true});
    if (game.matched[idx]||game.flipped[idx]) return interaction.reply({content:'❌ Already revealed.',ephemeral:true});
    game.flipped[idx]=true;
    const flippedIdxs=game.flipped.map((f,i)=>f&&!game.matched[i]?i:-1).filter(i=>i>=0);
    if (flippedIdxs.length<2) return interaction.update({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🃏 Memory Match').setDescription(`${renderMemory(game)}\n\n**Moves:** ${game.moves} | **Pairs:** ${game.score}/6\n\nFlipped **${game.cards[idx]}** — pick another card!`).setTimestamp()],components:buildMemoryRows(game,false)});
    game.moves++;
    const [a,b]=flippedIdxs;
    if (game.cards[a]===game.cards[b]) {
      game.matched[a]=true; game.matched[b]=true; game.flipped[a]=false; game.flipped[b]=false; game.score++;
      if (game.score>=6) {
        delete memoryGames[interaction.user.id];
        return interaction.update({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🃏 Memory Match — Complete! 🏆').setDescription(`${renderMemory(game)}\n\n✅ All pairs matched!\n**Moves:** ${game.moves} | **Rating:** ${game.moves<=10?'🌟🌟🌟 Perfect!':game.moves<=15?'⭐⭐ Great!':'⭐ Good!'}`).setTimestamp()],components:[]});
      }
      return interaction.update({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🃏 Memory Match — Match! ✅').setDescription(`${renderMemory(game)}\n\n✅ **Match!** +1 pair\n**Moves:** ${game.moves} | **Pairs:** ${game.score}/6`).setTimestamp()],components:buildMemoryRows(game,false)});
    }
    // No match — show both then hide
    game.flipped[a]=true; game.flipped[b]=true;
    await interaction.update({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🃏 Memory Match — No Match ❌').setDescription(`${renderMemory(game)}\n\n❌ **No match!** ${game.cards[a]} ≠ ${game.cards[b]}\n**Moves:** ${game.moves} | **Pairs:** ${game.score}/6`).setTimestamp()],components:buildMemoryRows(game,true)});
    await sleep(1200);
    game.flipped[a]=false; game.flipped[b]=false;
    return interaction.editReply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🃏 Memory Match').setDescription(`${renderMemory(game)}\n\n**Moves:** ${game.moves} | **Pairs:** ${game.score}/6`).setTimestamp()],components:buildMemoryRows(game,false)});
  }

  // Higher or Lower
  if (interaction.isButton() && interaction.customId.startsWith('hol:')) {
    const action = interaction.customId.split(':')[1];
    const game = holGames[interaction.user.id];
    if (!game) return interaction.reply({content:'❌ No H/L game. Use `!hol` to start.',ephemeral:true});
    if (interaction.user.id !== game.userId) return interaction.reply({content:'❌ Not your game!',ephemeral:true});
    if (action==='quit') {
      delete holGames[interaction.user.id];
      return interaction.update({embeds:[new EmbedBuilder().setColor('#95A5A6').setTitle('📊 Higher or Lower — Quit').setDescription(`Streak: **${game.streak}** | Best: **${game.best}**`).setTimestamp()],components:[]});
    }
    const cur=game.items[game.idx]; const prev=game.idx>0?game.items[game.idx-1]:null;
    if (!prev) { game.idx++; return interaction.update({embeds:[buildHOLEmbed(game)],components:buildHOLRows(false)}); }
    const correct=(action==='higher'&&cur.val>prev.val)||(action==='lower'&&cur.val<prev.val)||(action==='higher'&&cur.val===prev.val);
    if (!correct) {
      delete holGames[interaction.user.id];
      return interaction.update({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('📊 Higher or Lower — Wrong! ❌')
        .setDescription(`**${cur.name}** = **${cur.val} ${cur.unit}**\n${action==='higher'?'You said Higher':'You said Lower'} — it was ${cur.val>prev.val?'Higher 📈':'Lower 📉'}!\n\n💀 **Game over!** Streak: **${game.streak}** | Best: **${game.best}**`)
        .setTimestamp()],components:[]});
    }
    game.streak++; if(game.streak>game.best) game.best=game.streak;
    game.idx++;
    if (game.idx>=game.items.length) {
      delete holGames[interaction.user.id];
      return interaction.update({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('📊 Higher or Lower — Complete! 🏆').setDescription(`You got through all questions!\n**Final Streak:** ${game.streak} | 🌟 Perfect score!`).setTimestamp()],components:[]});
    }
    return interaction.update({embeds:[new EmbedBuilder().setColor('#1ABC9C').setTitle('📊 Higher or Lower — Correct! ✅')
      .setDescription(`**${cur.name}** = **${cur.val} ${cur.unit}** — ${action==='higher'?'Higher ✅':'Lower ✅'}\n\n**Streak: ${game.streak}** 🔥\n\nNext up: **${game.items[game.idx].name}**\nIs it Higher or Lower than **${cur.val} ${cur.unit}**?`)
      .setTimestamp()],components:buildHOLRows(false)});
  }

  // Dice Poker
  if (interaction.isButton() && interaction.customId.startsWith('dp:')) {
    const parts = interaction.customId.split(':');
    const game = dicePokerGames[interaction.user.id];
    if (!game) return interaction.reply({content:'❌ No Dice Poker game. Use `!dicepoker` to start.',ephemeral:true});
    if (interaction.user.id !== game.userId) return interaction.reply({content:'❌ Not your game!',ephemeral:true});
    if (parts[1]==='hold') {
      const di=parseInt(parts[2]);
      game.held[di]=!game.held[di];
      return interaction.update({embeds:[buildDPEmbed(game,'hold')],components:buildDPHoldRows(game.dice,game.held,false)});
    }
    if (parts[1]==='roll') {
      game.dice=game.dice.map((d,i)=>game.held[i]?d:Math.floor(Math.random()*6)+1);
      game.rerolls--;
      if (game.rerolls<=0) {
        const hand=evalDiceHand(game.dice);
        const payout=hand.rank>=3?game.bet*hand.rank:hand.rank>=1?game.bet:0;
        delete dicePokerGames[interaction.user.id];
        const resultColor=hand.rank>=3?'#FFD700':hand.rank>=1?'#57F287':'#ED4245';
        return interaction.update({embeds:[new EmbedBuilder().setColor(resultColor).setTitle(`🎲 Dice Poker — ${hand.name}`)
          .setDescription(`**Your Dice:** ${game.dice.map(d=>diceFace(d)).join(' ')}\n\n${hand.rank>=3?`🏆 Win! **+${payout} coins**`:hand.rank>=1?`↩️ Push — **${payout} coins** back`:hand.rank===0?`😞 Loss — **${game.bet} coins** lost`:''}\n\nBet: ${game.bet} | Rank: ${hand.rank}/8`)
          .setTimestamp()],components:[]});
      }
      game.held=Array(5).fill(false);
      return interaction.update({embeds:[buildDPEmbed(game,'hold')],components:buildDPHoldRows(game.dice,game.held,false)});
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

// ─── Message Deduplication Guard ─────────────────────────────────────────────
// Prevents double responses when two bot instances are briefly alive at once
// (common during Render/Replit redeploys). Tracks processed message IDs for 5s.
const processedMessages = new Set();
function isDuplicate(id) {
  if (processedMessages.has(id)) return true;
  processedMessages.add(id);
  setTimeout(() => processedMessages.delete(id), 5000);
  return false;
}

// ─── Message Handler ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (isDuplicate(message.id)) return;

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

  // Math Duel answer
  const mdGame = mathDuelGames[message.channel.id];
  if (mdGame && (message.author.id===mdGame.p1||message.author.id===mdGame.p2) && !message.content.startsWith(PREFIX)) {
    const ans = parseInt(message.content.trim());
    if (!isNaN(ans) && ans===mdGame.current.a && !mdGame.answered) {
      mdGame.answered=true;
      const uid=message.author.id;
      if(uid===mdGame.p1) mdGame.score1++; else mdGame.score2++;
      mdGame.qNum++;
      const won=mdGame.score1>=3||mdGame.score2>=3||mdGame.qNum>=5;
      if(won){
        const winner=mdGame.score1>mdGame.score2?mdGame.p1:mdGame.score2>mdGame.score1?mdGame.p2:null;
        delete mathDuelGames[message.channel.id];
        return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🧮 Math Duel — Finished!')
          .setDescription(`✅ <@${uid}> got it! **${mdGame.current.q} = ${mdGame.current.a}**\n\n**Final Scores:**\n<@${mdGame.p1}> — ${mdGame.score1}pts\n<@${mdGame.p2}> — ${mdGame.score2}pts\n\n${winner?`🏆 <@${winner}> WINS!`:'🤝 Tie!'}`)
          .setTimestamp()]});
      }
      mdGame.answered=false;
      mdGame.current=genMathQ(mdGame.diff);
      return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('✅ Correct!').setDescription(`<@${uid}> got **${mdGame.current.q}** → **${mdGame.current.a}**! +1 point\n\n**Next Question — Q${mdGame.qNum+1}/5:**\n> 🔢 **${mdGame.current.q} = ?**\n\n<@${mdGame.p1}> ${mdGame.score1}pts vs ${mdGame.score2}pts <@${mdGame.p2}>`).setTimestamp()]});
    }
    return;
  }

  // Word Chain answer
  const wcGame = wordChainGames[message.channel.id];
  if (wcGame && message.author.id===wcGame.currentTurn && !message.content.startsWith(PREFIX)) {
    const word = message.content.trim().toLowerCase();
    if (!/^[a-z]+$/.test(word)) return;
    clearTimeout(wcGame.timer);
    if (word[0]!==wcGame.lastLetter) return message.reply(`❌ Word must start with **${wcGame.lastLetter.toUpperCase()}**!`);
    if (wcGame.used.has(word)) return message.reply('❌ That word was already used!');
    if (word.length<2) return message.reply('❌ Word must be at least 2 letters!');
    wcGame.used.add(word);
    wcGame.chain.push(word);
    wcGame.lastLetter=word[word.length-1];
    wcGame.currentTurn=wcGame.currentTurn===wcGame.p1?wcGame.p2:wcGame.p1;
    // Set timeout for next player
    wcGame.timer=setTimeout(async()=>{
      const loser=wcGame.currentTurn;
      if(loser===wcGame.p1) wcGame.lives1--; else wcGame.lives2--;
      if(wcGame.lives1<=0||wcGame.lives2<=0){
        const winner=wcGame.lives1>0?wcGame.p1:wcGame.p2;
        delete wordChainGames[message.channel.id];
        return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Game Over!').setDescription(`⏱️ <@${loser}> ran out of time!\n\n🏆 <@${winner}> WINS!\n\n**Chain:** ${wcGame.chain.join(' → ')}`).setTimestamp()]});
      }
      wcGame.currentTurn=wcGame.currentTurn===wcGame.p1?wcGame.p2:wcGame.p1;
      message.channel.send({embeds:[buildWordChainEmbed(wcGame)]});
    },15000);
    return message.reply({embeds:[buildWordChainEmbed(wcGame)]});
  }

  // Battleship coordinate input
  const bsGame = battleshipGames[message.channel.id];
  if (bsGame && message.author.id===bsGame.currentTurn && !message.content.startsWith(PREFIX)) {
    const coord = parseBSCoord(message.content);
    if (!coord) return;
    const [r,c]=coord;
    const isP1=message.author.id===bsGame.p1;
    const shots=isP1?bsGame.shots1:bsGame.shots2;
    const targetBoard=isP1?bsGame.board2:bsGame.board1;
    const targetShips=isP1?bsGame.ships2:bsGame.ships1;
    if (shots.some(s=>s[0]===r&&s[1]===c)) return message.reply('❌ Already shot there! Pick another coordinate.');
    shots.push([r,c]);
    const hit=targetBoard[r][c]===1;
    let sunkMsg='';
    if (hit) {
      const ship=targetShips.find(s=>s.cells.some(([sr,sc])=>sr===r&&sc===c));
      if(ship){ship.hits++;if(ship.hits>=ship.len)sunkMsg=`\n\n💥 **${ship.name} SUNK!** ☠️`;}
    }
    const allSunk=targetShips.every(s=>s.hits>=s.len);
    if (allSunk) {
      delete battleshipGames[message.channel.id];
      return message.reply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🚢 Battleship — WINNER! 🏆')
        .setDescription(`🎯 **${message.author.username}** sinks the last ship!\n\n<@${message.author.id}> **WINS THE BATTLE!** ⚓\n\n${renderBSGrid(targetBoard,shots,true)}`)
        .setTimestamp()]});
    }
    bsGame.currentTurn=bsGame.currentTurn===bsGame.p1?bsGame.p2:bsGame.p1;
    return message.reply({embeds:[new EmbedBuilder().setColor(hit?'#E74C3C':'#3498DB').setTitle(`🚢 Battleship — ${hit?'💥 HIT!':'〰️ Miss!'}`)
      .setDescription(`**${message.author.username}** fires at **${message.content.trim().toUpperCase()}** — ${hit?'💥 HIT!':'〰️ Miss!'}${sunkMsg}\n\n${renderBSGrid(targetBoard,shots)}\n\n<@${bsGame.currentTurn}>'s turn! Type a coordinate (e.g. \`A1\`)`)
      .setTimestamp()]});
  }

  // Scramble answer
  const scGame = scrambleGames[message.channel.id];
  if (scGame && !message.content.startsWith(PREFIX)) {
    const guess = message.content.trim().toUpperCase();
    if (guess===scGame.word) {
      const uid=message.author.id;
      scGame.scores[uid]=(scGame.scores[uid]||0)+1;
      scGame.round++;
      if(scGame.round>=scGame.maxRounds){
        delete scrambleGames[message.channel.id];
        const scoreboard=Object.entries(scGame.scores).sort(([,a],[,b])=>b-a).map(([id,s],i)=>`${['🥇','🥈','🥉'][i]||'🏅'} <@${id}>: **${s}** pts`).join('\n');
        return message.reply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🔀 Scramble — Game Over!')
          .setDescription(`✅ <@${uid}> got it! The word was **${scGame.word}**!\n\n**Final Scores:**\n${scoreboard||'No scores yet.'}`)
          .setTimestamp()]});
      }
      const next=SCRAMBLE_WORDS[Math.floor(Math.random()*SCRAMBLE_WORDS.length)];
      scGame.word=next.word; scGame.hint=next.hint; scGame.scrambled=scrambleWord(next.word);
      return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🔀 Scramble — Correct! ✅')
        .setDescription(`✅ <@${uid}> got it! The word was **${scGame.word.toLowerCase()}**!\n\n**Round ${scGame.round}/${scGame.maxRounds}:**\nUnscramble: \`${scGame.scrambled}\`\n💡 Hint: ${scGame.hint}\n\n*Type your answer in chat!*`)
        .setTimestamp()]});
    }
  }

  // Emoji Decode answer
  const edGame = emojiDecodeGames[message.channel.id];
  if (edGame && !message.content.startsWith(PREFIX)) {
    const guess=message.content.trim().toLowerCase().replace(/\s+/g,'');
    if(guess===edGame.puzzle.answer||guess===edGame.puzzle.display.toLowerCase().replace(/\s+/g,'')){
      const uid=message.author.id;
      edGame.scores[uid]=(edGame.scores[uid]||0)+1;
      edGame.round++;
      if(edGame.round>=edGame.maxRounds){
        delete emojiDecodeGames[message.channel.id];
        const scoreboard=Object.entries(edGame.scores).sort(([,a],[,b])=>b-a).map(([id,s],i)=>`${['🥇','🥈','🥉'][i]||'🏅'} <@${id}>: **${s}** pts`).join('\n');
        return message.reply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🤔 Emoji Decode — Finished!')
          .setDescription(`✅ <@${uid}> got it! Answer: **${edGame.puzzle.display}**\n\n**Final Scores:**\n${scoreboard||'No scores yet.'}`)
          .setTimestamp()]});
      }
      const next=EMOJI_PUZZLES[Math.floor(Math.random()*EMOJI_PUZZLES.length)];
      edGame.puzzle=next;
      return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🤔 Emoji Decode — Correct! ✅')
        .setDescription(`✅ <@${uid}> cracked it! Answer: **${edGame.puzzle.display}**\n\n**Round ${edGame.round}/${edGame.maxRounds}:**\nDecode: **${next.emojis}**\n💡 Hint: ${next.hint}\n\n*Type your answer in chat!*`)
        .setTimestamp()]});
    }
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
          {name:'🎮 Games',      value:`\`ttt\` \`hangman\` \`trivia\` \`guess\` \`rps\` \`blackjack\` \`slots\` \`mines\` \`connect4\` \`wordle\` \`snake\` \`2048\` \`mathduel\` \`wordchain\` \`triviabattle\` \`battleship\` \`memory\` \`hol\` \`dicepoker\` \`scramble\` \`emojidecode\``},
          {name:'🎫 Tickets',    value:`\`ticket\` \`ticketset\` \`ticketreset\``},
          {name:'🎉 Welcome',    value:`\`welcomeset\` \`welcometest\``},
          {name:'🛠️ Utility',   value:`\`say\` \`embed\` \`poll\``},
          {name:'🎭 Status',     value:`\`addstatus\` \`removestatus\` \`liststatus\` \`clearstatus\``},
        ).setFooter({text:`${client.user.username} • All commands use prefix ${PREFIX}`})]});
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
      message.reply({embeds:[successEmbed('Member Kicked',`**${t.user.username}** kicked.\n**Reason:** ${reason}`)]});
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
      message.reply({embeds:[successEmbed('Member Banned',`**${t.user.username}** banned.\n**Reason:** ${reason}`)]});
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
      try { await t.timeout(dur,reason); message.reply({embeds:[successEmbed('Muted',`**${t.user.username}** timed out for **${formatDuration(dur)}**.\n**Reason:** ${reason}`)]}); }
      catch(e){ message.reply({embeds:[errorEmbed(e.message)]}); }
      break;
    }

    // ── !unmute ─────────────────────────────────────────────────────────────
    case 'unmute': case 'untimeout': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      try { await t.timeout(null); message.reply({embeds:[successEmbed('Unmuted',`**${t.user.username}** timeout removed.`)]}); }
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
      client.warnings[message.guild.id][t.id].push({reason,mod:message.author.username,ts:new Date().toISOString()});
      const cnt=client.warnings[message.guild.id][t.id].length;
      try { await t.send({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(`⚠️ Warned in ${message.guild.name}`).setDescription(`**Reason:** ${reason}\n**Warning #${cnt}**`).setTimestamp()]}); } catch{}
      message.reply({embeds:[successEmbed('Warned',`**${t.user.username}** warned (#${cnt}).\n**Reason:** ${reason}`)]});
      break;
    }

    // ── !warnings ───────────────────────────────────────────────────────────
    case 'warnings': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      const t=message.mentions.members.first()||message.member;
      const w=client.warnings?.[message.guild.id]?.[t.id];
      if(!w||!w.length) return message.reply({embeds:[infoEmbed('⚠️ Warnings',`**${t.user.username}** has no warnings.`)]});
      message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(`⚠️ Warnings for ${t.user.username}`)
        .setDescription(w.map((x,i)=>`**#${i+1}** — ${x.reason}\n> by ${x.mod}`).join('\n\n'))
        .setFooter({text:`Total: ${w.length}`}).setTimestamp()]});
      break;
    }

    // ── !clearwarnings ──────────────────────────────────────────────────────
    case 'clearwarnings': {
      if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return missingPerm(message,'Administrator');
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention a member.');
      if(client.warnings?.[message.guild.id]?.[t.id]) client.warnings[message.guild.id][t.id]=[];
      message.reply({embeds:[successEmbed('Cleared',`All warnings for **${t.user.username}** cleared.`)]});
      break;
    }

    // ── !slowmode ───────────────────────────────────────────────────────────
    case 'slowmode': {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels)) return missingPerm(message,'Manage Channels');
      const s=parseInt(args[0]); if(isNaN(s)||s<0||s>21600) return message.reply('❌ Value must be 0–21600 seconds.');
      await message.channel.setRateLimitPerUser(s);
      message.reply({embeds:[successEmbed('Slowmode',s===0?'Disabled.':'Set to **'+s+'s**.')]});
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
      if(!del.length) return message.reply(`❌ No messages from **${t.username}**.`);
      try { await message.channel.bulkDelete(del,true); const r=await message.channel.send({embeds:[successEmbed('Deleted',`Deleted **${del.length}** msg(s) from **${t.username}**.`)]}); setTimeout(()=>r.delete().catch(()=>{}),4000); }
      catch(e){ message.reply({embeds:[errorEmbed(e.message)]}); }
      break;
    }

    // ── !dm ─────────────────────────────────────────────────────────────────
    case 'dm': {
      if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return missingPerm(message,'Moderate Members');
      const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention a user.');
      const txt=args.slice(1).join(' '); if(!txt) return message.reply('❌ Provide a message.');
      try { await t.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`📩 From ${message.guild.name}`).setDescription(txt).setFooter({text:`By ${message.author.username}`}).setTimestamp()]}); message.reply({embeds:[successEmbed('DM Sent',`Sent to **${t.username}**.`)]}); }
      catch { message.reply({embeds:[errorEmbed(`Cannot DM **${t.username}**. DMs closed.`)]}); }
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
      try { await ch.send({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('📢 Announcement').setDescription(txt).setFooter({text:`By ${message.author.username}`}).setTimestamp()]}); message.reply({embeds:[successEmbed('Sent',`Announcement sent to ${ch}.`)]}); }
      catch { message.reply({embeds:[errorEmbed(`Cannot send to ${ch}.`)]}); }
      break;
    }

    // ── !userinfo ────────────────────────────────────────────────────────────
    case 'userinfo': case 'whois': {
      const t=message.mentions.members.first()||message.member, u=t.user;
      const roles=t.roles.cache.filter(r=>r.id!==message.guild.id).sort((a,b)=>b.position-a.position).map(r=>r.toString()).slice(0,10).join(', ')||'None';
      message.reply({embeds:[new EmbedBuilder().setColor(t.displayHexColor||'#5865F2').setTitle(`👤 ${u.username}`)
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
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`🤖 ${client.user.username}`)
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
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`🖼️ ${t.username}'s Avatar`).setImage(t.displayAvatarURL({forceStatic:false,size:512})).setURL(t.displayAvatarURL({forceStatic:false,size:4096}))]});
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
      message.reply({embeds:[new EmbedBuilder().setColor(t.displayHexColor||'#5865F2').setTitle(`🪪 ${u.username}'s Profile`)
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
        ).setFooter({text:`Requested by ${message.author.username}`}).setTimestamp()]});
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
      message.channel.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(parts[0].trim()).setDescription(parts[1].trim()).setFooter({text:`By ${message.author.username}`}).setTimestamp()]});
      break;
    }

    // ── !poll ────────────────────────────────────────────────────────────────
    case 'poll': {
      const q=args.join(' '); if(!q) return message.reply('❌ Provide a question.');
      const poll=await message.channel.send({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('📊 Poll').setDescription(`**${q}**`).setFooter({text:`By ${message.author.username}`}).setTimestamp()]});
      await poll.react('✅'); await poll.react('❌');
      await message.delete().catch(()=>{});
      break;
    }

    // ── !roll ────────────────────────────────────────────────────────────────
    case 'roll': {
      const n=parseInt(args[0])||6; if(n<2) return message.reply('❌ At least 2 sides.');
      const result=Math.floor(Math.random()*n)+1;
      const diceMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🎲 Dice Roll').setDescription(`Rolling a **d${n}**...\n\n*🎲 tumbling...*`).setTimestamp()]});
      await sleep(600);
      await diceMsg.edit({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🎲 Dice Roll').setDescription(`Rolled a **d${n}** → **${result}** ${'⬛'.repeat(Math.min(result,10))}`).setTimestamp()]});
      break;
    }

    // ── !coinflip ────────────────────────────────────────────────────────────
    case 'coinflip': case 'coin': {
      const result=Math.random()<0.5?'Heads':'Tails';
      const coinMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🪙 Coin Flip').setDescription('*Flipping the coin...*  🔄').setTimestamp()]});
      await sleep(400);
      await coinMsg.edit({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🪙 Coin Flip').setDescription('*Still spinning...* 🌀').setTimestamp()]});
      await sleep(400);
      await coinMsg.edit({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🪙 Coin Flip').setDescription(`Result: **${result}** ${result==='Heads'?'👑':'🦅'}`).setTimestamp()]});
      break;
    }

    // ── FUN COMMANDS ─────────────────────────────────────────────────────────

    case 'meme': {
      const memes=[
        {t:'When the code works first try 😱',      i:'https://i.imgur.com/anTxoMB.gif'},
        {t:'Me explaining to rubber duck 🦆',        i:'https://i.imgur.com/mzHnYsB.gif'},
        {t:'Debugging at 3am 😵',                   i:'https://i.imgur.com/ToNKiCz.gif'},
        {t:'When someone touches my code 😤',        i:'https://i.imgur.com/X3NQPKC.gif'},
        {t:"It works. Don't touch it 🙏",           i:'https://i.imgur.com/JHq4s3D.gif'},
        {t:'Me after fixing one bug and creating 10 😈', i:'https://i.imgur.com/I8PBKDm.gif'},
        {t:'Stack Overflow saves the day 🦸',        i:'https://i.imgur.com/kBBMLfg.gif'},
        {t:'Friday deploy. What could go wrong 💀',  i:'https://i.imgur.com/zHO0jqF.gif'},
      ];
      // Fetch a random programming meme from meme API, fall back to local list
      try {
        const res=await fetch('https://meme-api.com/gimme/ProgrammerHumor');
        const data=await res.json();
        if(data.url&&!data.nsfw){
          const title=(`😂 ${data.title}`).slice(0,256);
          message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(title).setImage(data.url).setFooter({text:'!meme for another one'}).setTimestamp()]});
        } else { throw new Error('bad'); }
      } catch {
        const m=memes[Math.floor(Math.random()*memes.length)];
        message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle(`😂 ${m.t}`).setImage(m.i).setFooter({text:'!meme for another one'}).setTimestamp()]});
      }
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
      const chosen=ans[Math.floor(Math.random()*ans.length)];
      const ballMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🎱 Magic 8-Ball').addFields({name:'❓',value:q},{name:'🎱',value:'*The ball is swirling... 🌀*'}).setTimestamp()]});
      await sleep(800);
      await ballMsg.edit({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🎱 Magic 8-Ball').addFields({name:'❓',value:q},{name:'🎱',value:chosen}).setTimestamp()]});
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
        .setThumbnail(u1.displayAvatarURL({forceStatic:false}))
        .setImage(u2.displayAvatarURL({forceStatic:false,size:128}))
        .setTimestamp()]});
      break;
    }

    case 'fight': {
      const t=message.mentions.members.first(); if(!t) return message.reply('❌ Mention someone!');
      const win=Math.random()<0.5?message.member:t, lose=win.id===message.member.id?t:message.member;
      const moves=['a devastating punch','a spinning kick','a power slam','a critical hit','an atomic elbow drop','a suplex'];
      try {
        const res=await fetch('https://nekos.best/api/v2/kick');
        const gif=(await res.json()).results[0].url;
        message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('⚔️ Fight!')
          .setDescription(`**${message.author.username}** vs **${t.user.username}**\n\n🥊 **${win.user.username}** lands ${moves[Math.floor(Math.random()*moves.length)]}!\n\n🏆 **${win.user.username}** wins! **${lose.user.username}** is knocked out! 💀`)
          .setImage(gif).setTimestamp()]});
      } catch {
        message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('⚔️ Fight!')
          .setDescription(`**${message.author.username}** vs **${t.user.username}**\n\n🥊 **${win.user.username}** lands ${moves[Math.floor(Math.random()*moves.length)]}!\n\n🏆 **${win.user.username}** wins! **${lose.user.username}** is knocked out! 💀`)
          .setTimestamp()]});
      }
      break;
    }

    case 'slap': {
      const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!');
      try {
        const res=await fetch('https://nekos.best/api/v2/slap');
        const gif=(await res.json()).results[0].url;
        message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('👋 Slap!').setDescription(`**${message.author.username}** slaps **${t.username}** with a giant trout! 🐟`).setImage(gif).setTimestamp()]});
      } catch { message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('👋 Slap!').setDescription(`**${message.author.username}** slaps **${t.username}** with a giant trout! 🐟`).setTimestamp()]}); }
      break;
    }
    case 'hug': {
      const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!');
      try {
        const res=await fetch('https://nekos.best/api/v2/hug');
        const gif=(await res.json()).results[0].url;
        message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('🤗 Hug!').setDescription(`**${message.author.username}** gives **${t.username}** a warm hug! 💕`).setImage(gif).setTimestamp()]});
      } catch { message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('🤗 Hug!').setDescription(`**${message.author.username}** gives **${t.username}** a warm hug! 💕`).setTimestamp()]}); }
      break;
    }
    case 'kiss': {
      const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!');
      try {
        const res=await fetch('https://nekos.best/api/v2/kiss');
        const gif=(await res.json()).results[0].url;
        message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('😘 Kiss!').setDescription(`**${message.author.username}** gives **${t.username}** a kiss! 💋`).setImage(gif).setTimestamp()]});
      } catch { message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('😘 Kiss!').setDescription(`**${message.author.username}** gives **${t.username}** a kiss! 💋`).setTimestamp()]}); }
      break;
    }
    case 'pat': {
      const t=message.mentions.users.first(); if(!t) return message.reply('❌ Mention someone!');
      try {
        const res=await fetch('https://nekos.best/api/v2/pat');
        const gif=(await res.json()).results[0].url;
        message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🫳 Pat!').setDescription(`**${message.author.username}** pats **${t.username}** on the head! ✨`).setImage(gif).setTimestamp()]});
      } catch { message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🫳 Pat!').setDescription(`**${message.author.username}** pats **${t.username}** on the head! ✨`).setTimestamp()]}); }
      break;
    }

    case 'gay': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'gay'); message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('🏳️‍🌈 Gay Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>80?'✨ Very gay!':v>50?'🌈 Pretty gay!':v>30?'🤔 A little...':'😐 Not really.'}`) .setThumbnail(t.user.displayAvatarURL({forceStatic:false})).setTimestamp()]}); break; }
    case 'iq':   { const t=message.mentions.members.first()||message.member,v=pct(t.id,'iq')+50; message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🧠 IQ Test').setDescription(`**${t.user.username}**'s IQ: **${v}**\n\n${v>=130?'🎓 Galaxy brain!':v>=110?'😎 Above avg!':v>=90?'😐 Average.':'🥴 Uhh...'}`) .setThumbnail(t.user.displayAvatarURL({forceStatic:false})).setTimestamp()]}); break; }
    case 'rizz': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'rizz'); message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('😎 Rizz Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'🔥 God-tier rizz!':v>=60?'😏 Solid rizz!':v>=40?'😊 Decent.':'💀 No rizz.'}`) .setThumbnail(t.user.displayAvatarURL({forceStatic:false})).setTimestamp()]}); break; }
    case 'aura': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'aura')*1000; message.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('✨ Aura Points').setDescription(`**${t.user.username}**: **${v.toLocaleString()} pts**\n\n${v>=80000?'🌟 Legendary!':v>=60000?'💜 Strong!':v>=40000?'🔵 Average.':'⚫ Weak.'}`) .setThumbnail(t.user.displayAvatarURL({forceStatic:false})).setTimestamp()]}); break; }
    case 'simp': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'simp'); message.reply({embeds:[new EmbedBuilder().setColor('#FF69B4').setTitle('🥺 Simp Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'😭 Certified Simp!':v>=50?'😅 A bit simpy...':v>=30?'🤨 Borderline.':'😎 Not a simp.'}`) .setThumbnail(t.user.displayAvatarURL({forceStatic:false})).setTimestamp()]}); break; }
    case 'drip': { const t=message.mentions.members.first()||message.member,v=pct(t.id,'drip'); message.reply({embeds:[new EmbedBuilder().setColor('#00BFFF').setTitle('💧 Drip Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'🔥 Absolute drip!':v>=60?'😎 Nice drip!':v>=40?'👕 Basic.':'💀 No drip.'}`) .setThumbnail(t.user.displayAvatarURL({forceStatic:false})).setTimestamp()]}); break; }
    case 'sus':  { const t=message.mentions.members.first()||message.member,v=pct(t.id,'sus'); message.reply({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔴 Sus Meter').setDescription(`**${t.user.username}**\n\n\`${meterBar(v)}\` **${v}%**\n\n${v>=80?'📮 EJECTED!':v>=60?'🤨 Pretty sus...':v>=40?'🧐 Hmm...':'✅ Not sus.'}`) .setThumbnail(t.user.displayAvatarURL({forceStatic:false})).setTimestamp()]}); break; }

    // ── GAME COMMANDS ────────────────────────────────────────────────────────

    case 'ttt': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(tttGames[message.channel.id]) return message.reply('❌ Game already running here.');
      const g={board:Array(9).fill(null),player1:message.author.id,player2:opp.id,currentPlayer:message.author.id,symbol:'❌'};
      tttGames[message.channel.id]=g;
      const tttMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('❌ Tic Tac Toe ⭕').setDescription(`⚔️ **${message.author.username}** challenges **${opp.user.username}**!\n\n*Setting up the board...*`).setTimestamp()]});
      await sleep(700);
      await tttMsg.edit({embeds:[buildTTTEmbed(g,`<@${message.author.id}>'s turn (❌)`)],components:buildTTTRows(g.board,false)});
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
      const color=uc===bc?'#FEE75C':wins[uc]===bc?'#57F287':'#ED4245';
      const countdown = await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors').setDescription(`You threw **${map[uc]} ${uc}**\n\n**3...**`).setTimestamp()]});
      await sleep(600);
      await countdown.edit({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors').setDescription(`You threw **${map[uc]} ${uc}**\n\n**3... 2...**`).setTimestamp()]});
      await sleep(600);
      await countdown.edit({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors').setDescription(`You threw **${map[uc]} ${uc}**\n\n**3... 2... 1...**`).setTimestamp()]});
      await sleep(600);
      await countdown.edit({embeds:[new EmbedBuilder().setColor(color).setTitle('✊ Rock Paper Scissors — Result!').setDescription(`You: **${map[uc]} ${uc}**\nMe: **${map[bc]} ${bc}**\n\n${res}`).setTimestamp()]});
      break;
    }

    case 'blackjack': case 'bj': {
      if(bjGames[message.author.id]) return message.reply('❌ Finish your current game first!');
      const bet=parseInt(args[0])||50;
      const deck=makeDeck();
      const ph=[drawCard(deck),drawCard(deck)], dh=[drawCard(deck),drawCard(deck)];
      bjGames[message.author.id]={deck,playerHand:ph,dealerHand:dh,bet};
      // Dealing animation
      const dealMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🃏 Blackjack — Dealing...')
        .setDescription(`*Shuffling deck...*\n\nBet: **${bet} coins**`).setTimestamp()]});
      await sleep(500);
      await dealMsg.edit({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🃏 Blackjack — Dealing...')
        .setDescription(`**Your hand:** ${fmtHand([ph[0]])} 🂠\n**Dealer shows:** 🂠 🂠\n\nBet: **${bet} coins**`).setTimestamp()]});
      await sleep(500);
      await dealMsg.edit({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🃏 Blackjack — Dealing...')
        .setDescription(`**Your hand:** ${fmtHand([ph[0]])} 🂠\n**Dealer shows:** ${fmtHand([dh[0]])} 🂠\n\nBet: **${bet} coins**`).setTimestamp()]});
      await sleep(500);
      if(handValue(ph)===21){delete bjGames[message.author.id];return dealMsg.edit({embeds:[successEmbed('🃏 Blackjack! 🎉',`Natural Blackjack! Win **${Math.floor(bet*2.5)} coins**!\nHand: ${fmtHand(ph)}`)]});}
      await dealMsg.edit({embeds:[buildBJEmbed(bjGames[message.author.id])],components:buildBJRows()});
      break;
    }

    case 'slots': {
      const now=Date.now();
      if(slotsCD[message.author.id]&&now-slotsCD[message.author.id]<10000) return message.reply(`❌ Cooldown! Wait **${Math.ceil((10000-(now-slotsCD[message.author.id]))/1000)}s**.`);
      slotsCD[message.author.id]=now;
      const syms=['🍒','🍋','🍊','🍇','⭐','💎','7️⃣'], spin=()=>syms[Math.floor(Math.random()*syms.length)];
      const [s1,s2,s3]=[spin(),spin(),spin()];
      const won=s1===s2&&s2===s3, jp=won&&s1==='💎';
      // Spinning animation
      const spinFrames=['🔄','⏳','🔄'];
      const spinRow=(a,b,c)=>`╔══════════╗\n║  ${a} │ ${b} │ ${c}  ║\n╚══════════╝`;
      const initMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🎰 Slots — Spinning...')
        .setDescription(`${spinRow('🔄','🔄','🔄')}\n\n*The reels are spinning...*`).setTimestamp()]});
      await sleep(700);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🎰 Slots — Spinning...')
        .setDescription(`${spinRow(s1,'🔄','🔄')}\n\n*Reel 1 locked!*`).setTimestamp()]});
      await sleep(700);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🎰 Slots — Spinning...')
        .setDescription(`${spinRow(s1,s2,'🔄')}\n\n*Reel 2 locked!*`).setTimestamp()]});
      await sleep(700);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor(jp?'#FFD700':won?'#57F287':'#ED4245')
        .setTitle(`🎰 Slots${jp?' — JACKPOT! 🎊':won?' — Winner! 🎉':''}`)
        .setDescription(`${spinRow(s1,s2,s3)}\n\n${jp?'💎 **JACKPOT! 1000 coins!**':won?'🎉 **You win 100 coins!**':'😞 No luck. Try again!'}`)
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
      const c4Msg = await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🔴 Connect 4 🟡').setDescription(`⚔️ **${message.author.username}** 🔴 challenges **${opp.user.username}** 🟡!\n\n*Dropping pieces into position...*`).setTimestamp()]});
      await sleep(700);
      await c4Msg.edit({embeds:[buildC4Embed(g,`<@${message.author.id}>'s turn (🔴)`)],components:buildC4Rows(false)});
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

    case 'snake': {
      if(snakeGames[message.author.id]) return message.reply('❌ You already have a snake game! Quit it first with the 🛑 button.');
      const g=makeSnakeGame(); g.userId=message.author.id;
      snakeGames[message.author.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🐍 Snake').setDescription('*Loading game board...*').setTimestamp()]});
      await sleep(600);
      await initMsg.edit({embeds:[buildSnakeEmbed(g,message.author.id)],components:buildSnakeRows(false)});
      break;
    }

    case '2048': {
      if(game2048[message.author.id]) return message.reply('❌ You already have a 2048 game running!');
      const board=make2048Board();
      game2048[message.author.id]={board,score:0,userId:message.author.id};
      const g=game2048[message.author.id];
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🎯 2048').setDescription('*Shuffling tiles...*').setTimestamp()]});
      await sleep(500);
      await initMsg.edit({embeds:[build2048Embed(g)],components:build2048Rows(false)});
      break;
    }

    case 'rps': case 'rockpaperscissors': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(rpsGames[message.channel.id]) return message.reply('❌ RPS game already running here!');
      const bestOf=parseInt(args[1])||3;
      const allowed=[1,3,5,7];
      if(!allowed.includes(bestOf)) return message.reply('❌ Best-of must be 1, 3, 5 or 7.');
      const g={p1:message.author.id,p2:opp.id,score1:0,score2:0,round:1,bestOf,choice1:null,choice2:null};
      rpsGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🎮 Rock Paper Scissors').setDescription(`⚔️ **${message.author.username}** challenges **${opp.user.username}**!\n**Best of ${bestOf}** — May the best hand win! ✊`).setTimestamp()]});
      await sleep(800);
      await initMsg.edit({embeds:[buildRPSLobbyEmbed(g)],components:buildRPSRows(false)});
      break;
    }

    case 'mathduel': case 'md': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(mathDuelGames[message.channel.id]) return message.reply('❌ Math Duel already running here!');
      const diff=parseInt(args[1])||1;
      if(diff<1||diff>3) return message.reply('❌ Difficulty: 1 (easy) 2 (medium) 3 (hard)');
      const q=genMathQ(diff);
      const g={p1:message.author.id,p2:opp.id,score1:0,score2:0,qNum:0,diff,current:q,answered:false};
      mathDuelGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🧮 Math Duel').setDescription(`⚔️ **${message.author.username}** vs **${opp.user.username}**!\nDifficulty: ${'⭐'.repeat(diff)}\n\n*Loading questions...*`).setTimestamp()]});
      await sleep(800);
      await initMsg.edit({embeds:[buildMathEmbed(g)]});
      break;
    }

    case 'wordchain': case 'wc': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(wordChainGames[message.channel.id]) return message.reply('❌ Word Chain already running here!');
      const starters='abcdefghijklmnoprstw';
      const startLetter=starters[Math.floor(Math.random()*starters.length)];
      const g={p1:message.author.id,p2:opp.id,chain:[],lastLetter:startLetter,currentTurn:message.author.id,used:new Set(),lives1:3,lives2:3,timer:null};
      wordChainGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🔗 Word Chain').setDescription(`⚔️ **${message.author.username}** vs **${opp.user.username}**!\n\n*Setting up the chain...*`).setTimestamp()]});
      await sleep(700);
      await initMsg.edit({embeds:[buildWordChainEmbed(g)]});
      g.timer=setTimeout(async()=>{
        const loser=g.currentTurn; if(loser===g.p1) g.lives1--; else g.lives2--;
        if(g.lives1<=0||g.lives2<=0){const winner=g.lives1>0?g.p1:g.p2;delete wordChainGames[message.channel.id];return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Over!').setDescription(`⏱️ <@${loser}> timed out!\n🏆 <@${winner}> WINS!`).setTimestamp()]});}
        g.currentTurn=g.currentTurn===g.p1?g.p2:g.p1;
        message.channel.send({embeds:[buildWordChainEmbed(g)]});
      },15000);
      break;
    }

    case 'triviabattle': case 'tb': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(triviaBattleGames[message.channel.id]) return message.reply('❌ Trivia Battle already running here!');
      const shuffled=[...TRIVIA_BATTLE_Q].sort(()=>Math.random()-0.5).slice(0,5);
      const g={p1:message.author.id,p2:opp.id,questions:shuffled,qNum:0,score1:0,score2:0,answered:[],roundWinner:null};
      triviaBattleGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#E67E22').setTitle('⚡ Trivia Battle').setDescription(`⚔️ **${message.author.username}** vs **${opp.user.username}**!\n5 questions — fastest correct answer wins the point!\n\n*Loading questions...*`).setTimestamp()]});
      await sleep(800);
      await initMsg.edit({embeds:[buildTriviaBattleEmbed(g)],components:buildTriviaBattleRows(false)});
      break;
    }

    case 'battleship': case 'bs': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(battleshipGames[message.channel.id]) return message.reply('❌ Battleship already running here!');
      const b1=makeBSBoard(), b2=makeBSBoard();
      const ships1=placeBSShips(b1), ships2=placeBSShips(b2);
      const g={p1:message.author.id,p2:opp.id,board1:b1,board2:b2,ships1,ships2,shots1:[],shots2:[],currentTurn:message.author.id};
      battleshipGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#3498DB').setTitle('🚢 Battleship').setDescription(`⚓ **${message.author.username}** vs **${opp.user.username}**!\n\n*Deploying fleets on a 5×5 grid...*\n🚢 Ships placed secretly!`).setTimestamp()]});
      await sleep(900);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#3498DB').setTitle('🚢 Battleship — Battle Begins! ⚓')
        .setDescription(`<@${message.author.id}> vs <@${opp.id}>\n\n**Grid:** 5×5 (A–E columns, 1–5 rows)\n**Ships:** ${ships1.map(s=>s.name).join(', ')}\n\n<@${g.currentTurn}>'s turn! Type a coordinate like \`A1\`, \`C3\`, \`E5\`\n\n${renderBSGrid(b2,[])}`)
        .setTimestamp()]});
      break;
    }

    case 'memory': {
      if(memoryGames[message.author.id]) return message.reply('❌ You already have a Memory game! Finish it first.');
      const g=makeMemoryGame(); g.userId=message.author.id;
      memoryGames[message.author.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🃏 Memory Match').setDescription('*Shuffling cards...*').setTimestamp()]});
      await sleep(600);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🃏 Memory Match').setDescription(`${renderMemory(g)}\n\n**12 cards — 6 pairs** hidden face-down!\nClick buttons 1–12 to flip cards.\n\n**Moves:** 0 | **Pairs:** 0/6`).setTimestamp()],components:buildMemoryRows(g,false)});
      break;
    }

    case 'hol': case 'higherorlower': {
      if(holGames[message.author.id]) return message.reply('❌ You already have a Higher or Lower game!');
      const items=[...HOL_ITEMS].sort(()=>Math.random()-0.5).slice(0,8);
      const g={items,idx:0,streak:0,best:0,userId:message.author.id};
      holGames[message.author.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#1ABC9C').setTitle('📊 Higher or Lower').setDescription('*Loading questions...*').setTimestamp()]});
      await sleep(500);
      // Show first item value, then go to second
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#1ABC9C').setTitle('📊 Higher or Lower — Starting!')
        .setDescription(`**First card:** ${items[0].name}\n> **${items[0].val} ${items[0].unit}**\n\n**Next:** ${items[1].name}\nIs it **Higher** or **Lower**?\n\n⭐ Streak: 0`)
        .setFooter({text:'Click a button!'}).setTimestamp()],components:buildHOLRows(false)});
      g.idx=1; // Ready to compare
      break;
    }

    case 'dicepoker': case 'dp': {
      if(dicePokerGames[message.author.id]) return message.reply('❌ You already have a Dice Poker game running!');
      const bet=parseInt(args[0])||50;
      const dice=rollDice(5);
      const g={dice,held:Array(5).fill(false),rerolls:2,bet,userId:message.author.id};
      dicePokerGames[message.author.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#E74C3C').setTitle('🎲 Dice Poker').setDescription(`*Rolling dice...*\n\nBet: **${bet} coins**`).setTimestamp()]});
      await sleep(700);
      await initMsg.edit({embeds:[buildDPEmbed(g,'hold')],components:buildDPHoldRows(g.dice,g.held,false)});
      break;
    }

    case 'scramble': {
      if(scrambleGames[message.channel.id]) return message.reply('❌ Scramble already running here!');
      const rounds=parseInt(args[0])||5;
      if(rounds<1||rounds>10) return message.reply('❌ Rounds must be 1–10.');
      const entry=SCRAMBLE_WORDS[Math.floor(Math.random()*SCRAMBLE_WORDS.length)];
      const g={word:entry.word,hint:entry.hint,scrambled:scrambleWord(entry.word),round:1,maxRounds:rounds,scores:{}};
      scrambleGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#F39C12').setTitle('🔀 Scramble').setDescription('*Scrambling a word...*').setTimestamp()]});
      await sleep(600);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#F39C12').setTitle(`🔀 Scramble — Round 1/${rounds}`)
        .setDescription(`Unscramble this word:\n\n# \`${g.scrambled}\`\n\n💡 **Hint:** ${g.hint}\n\n*Type your answer in chat — anyone can answer!*`)
        .setFooter({text:`${rounds} rounds total • First correct answer gets the point!`}).setTimestamp()]});
      break;
    }

    case 'emojidecode': case 'ed': {
      if(emojiDecodeGames[message.channel.id]) return message.reply('❌ Emoji Decode already running here!');
      const rounds=parseInt(args[0])||5;
      if(rounds<1||rounds>10) return message.reply('❌ Rounds must be 1–10.');
      const puzzle=EMOJI_PUZZLES[Math.floor(Math.random()*EMOJI_PUZZLES.length)];
      const g={puzzle,round:1,maxRounds:rounds,scores:{}};
      emojiDecodeGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#8E44AD').setTitle('🤔 Emoji Decode').setDescription('*Loading emoji puzzle...*').setTimestamp()]});
      await sleep(600);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#8E44AD').setTitle(`🤔 Emoji Decode — Round 1/${rounds}`)
        .setDescription(`What do these emojis represent?\n\n# ${puzzle.emojis}\n\n💡 **Hint:** ${puzzle.hint}\n\n*Type your answer in chat — anyone can answer! (no spaces needed)*`)
        .setFooter({text:`${rounds} rounds total • First correct answer gets the point!`}).setTimestamp()]});
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
