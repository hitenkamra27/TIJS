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
    GatewayIntentBits.DirectMessages,
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
// New games (batch 3)
const fastTypeGames = {}, countdownGames = {}, truthDareGames = {};
// Team games
const teamTriviaGames = {};

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
// Returns true if column col is already full
function isC4ColFull(board, col) { return board[0][col] !== null; }
function buildC4Embed(g, status) {
  // Column number header + last-drop arrow indicator
  const colNums = [1,2,3,4,5,6,7].map((n,i) => g.lastCol===i ? '⬇️' : `${n}️⃣`).join('');
  const boardStr = g.board.map(r => r.map(c => c || '⚫').join('')).join('\n');
  const moveInfo = g.moves ? `\n\n🎯 **Move ${g.moves}**` : '';
  return new EmbedBuilder()
    .setColor(g.symbol==='🔴' ? '#FF4444' : '#FFD700')
    .setTitle('🔴 Connect 4 🟡')
    .setDescription(`<@${g.player1}> 🔴 vs 🟡 <@${g.player2}>\n\n${colNums}\n${boardStr}${moveInfo}\n\n${status}`)
    .setFooter({ text: 'Drop your piece — connect 4 in a row to win!' })
    .setTimestamp();
}
// ── FIX: Discord allows max 5 buttons per ActionRow — split 7 cols into 2 rows (4 + 3)
function buildC4Rows(disabled, board) {
  const colLabels = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
  const colStyles = [ButtonStyle.Primary, ButtonStyle.Primary, ButtonStyle.Primary, ButtonStyle.Primary,
                     ButtonStyle.Success, ButtonStyle.Success, ButtonStyle.Success];
  const row1 = new ActionRowBuilder().addComponents(
    ...[0,1,2,3].map(c => {
      const full = board ? isC4ColFull(board, c) : false;
      return new ButtonBuilder()
        .setCustomId(`c4:${c}`)
        .setLabel(colLabels[c])
        .setStyle(full ? ButtonStyle.Danger : colStyles[c])
        .setDisabled(disabled || full);
    })
  );
  const row2 = new ActionRowBuilder().addComponents(
    ...[4,5,6].map(c => {
      const full = board ? isC4ColFull(board, c) : false;
      return new ButtonBuilder()
        .setCustomId(`c4:${c}`)
        .setLabel(colLabels[c])
        .setStyle(full ? ButtonStyle.Danger : colStyles[c])
        .setDisabled(disabled || full);
    })
  );
  return [row1, row2];
}

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
  if(diff===1){
    const ops=['+','-','×'];
    const op=ops[Math.floor(Math.random()*ops.length)];
    const a=Math.floor(Math.random()*50)+10, b=Math.floor(Math.random()*50)+10;
    if(op==='+') return{q:`${a} + ${b}`,a:a+b};
    if(op==='-') return{q:`${Math.max(a,b)} - ${Math.min(a,b)}`,a:Math.max(a,b)-Math.min(a,b)};
    return{q:`${a%10+2} × ${b%10+2}`,a:(a%10+2)*(b%10+2)};
  }
  if(diff===2){
    const a=Math.floor(Math.random()*20)+5,b=Math.floor(Math.random()*20)+5,c=Math.floor(Math.random()*10)+2;
    return{q:`${a} × ${b} + ${c}`,a:a*b+c};
  }
  // Difficulty 3 — brutal
  const a=Math.floor(Math.random()*15)+8,b=Math.floor(Math.random()*15)+8,c=Math.floor(Math.random()*10)+3,d=Math.floor(Math.random()*5)+2;
  return{q:`(${a} + ${b}) × ${d} - ${c}`,a:(a+b)*d-c};
}
function buildMathEmbed(g) {
  const bar = (n,max) => n===0?'░░░░░░░░░░':'█'.repeat(Math.round(n/max*10))+'░'.repeat(10-Math.round(n/max*10));
  return new EmbedBuilder().setColor('#5865F2').setTitle('🧮 Math Duel — HARDCORE')
    .setDescription(`**Question ${g.qNum+1}/5** (Diff: ${'⭐'.repeat(g.diff)})\n\n> 🔢 **${g.current.q} = ?**\n\nType your answer in chat — fastest correct answer wins the point!\n\n<@${g.p1}> \`${bar(g.score1,5)}\` ${g.score1}pts\n<@${g.p2}> \`${bar(g.score2,5)}\` ${g.score2}pts`)
    .setFooter({text:`⏱️ 10 seconds per question — no mercy!`}).setTimestamp();
}

// ─── Word Chain Dictionary (2000+ common English words, no slang/non-English) ─
const WC_DICTIONARY = new Set([
  // A
  'abandon','ability','able','about','above','absent','absorb','abstract','accent','accept','access','account','accuse','ache','achieve','acid','acknowledge','acquire','across','action','active','actor','actual','acute','adapt','address','adjust','admire','admit','adopt','advance','afford','afraid','after','again','against','agent','agree','ahead','alarm','album','alert','alike','alive','alley','allow','alone','along','alter','although','always','amaze','among','ample','amuse','anger','angle','ankle','annex','answer','apple','apply','approve','arch','argue','arise','armor','around','arrest','arrow','artist','aside','atlas','attach','attack','attempt','attend','August','avoid',
  // B
  'badge','basic','basis','batch','beach','begin','below','bench','blind','block','bloom','board','bonus','boost','booth','bound','brain','brand','brave','break','brick','bride','brief','bring','broad','brook','brown','brush','build','bunch','burst','butter','buyer',
  // C
  'cabin','calmly','candy','cargo','carry','catch','cause','chain','chair','chase','cheap','check','chest','chief','child','china','claim','clash','class','clean','clear','climb','clock','cloth','cloud','coast','color','comes','court','cover','crack','craft','crash','crawl','cream','crime','crisp','cross','crowd','crush','curve',
  // D
  'daily','dairy','dance','dense','depth','devil','dirty','dodge','doubt','dough','draft','drain','drama','drank','dread','dream','dress','drift','drink','drive','drove','drown','dwarf',
  // E
  'eager','eagle','early','earth','eight','elect','elite','empty','enter','entry','equal','essay','every','exact','exist','extra',
  // F
  'faint','faith','fancy','fault','feast','fence','ferry','fever','field','fight','final','first','fixed','flame','flare','flash','flesh','float','flood','floor','flour','focus','force','forge','forth','found','frame','frank','fraud','fresh','front','frost','fruit','fully',
  // G
  'ghost','giant','given','glass','globe','gloom','glory','grace','grade','grain','grand','grasp','grass','gravel','graze','greed','green','greet','grief','grill','grind','groan','gross','group','grove','grown','guard','guess','guest','guide','guild','guilt','guise',
  // H
  'habit','handy','harsh','haste','haven','heart','heavy','hence','horse','hotel','house','human','humor','hurry','hyper',
  // I
  'ideal','image','imply','index','inner','input','intel','issue',
  // J
  'joint','judge','juice','jumbo','jumpy',
  // K
  'kneel','knife','knock','known',
  // L
  'label','lance','large','laser','later','laugh','layer','learn','legal','level','light','limit','linen','liver','lodge','logic','loose','lower','loyal',
  // M
  'magic','major','march','match','mayor','metal','might','minor','minus','model','money','month','moral','motor','mount','mouse','mouth','muddy','music','muted',
  // N
  'naive','nerve','night','noble','noise','north','noted','novel','nurse',
  // O
  'occur','offer','often','order','other','outer','owner',
  // P
  'paint','panel','panic','paper','party','pause','peace','pearl','phase','phone','piano','pilot','pitch','pixel','plain','plane','plant','plate','plaza','plead','pluck','plumb','plume','plunge','point','polar','pound','power','press','price','pride','prime','prior','prize','probe','prone','proof','prose','proud','pulse',
  // Q
  'queen','query','quest','queue','quick','quiet','quota','quote',
  // R
  'radar','radio','raise','rally','ranch','range','rapid','ratio','reach','react','ready','realm','rebel','refer','reign','relax','relish','reply','rider','right','rigid','risky','rival','river','robot','rocky','rough','round','route','royal','ruler',
  // S
  'scale','scene','scope','score','scout','sense','serve','seven','shade','shake','shall','shame','shape','share','shark','sharp','shift','shine','shirt','shock','shore','shout','sight','since','sixth','sixty','sized','skill','skull','slash','slave','sleep','slice','slide','slope','small','smart','smell','smile','smoke','solid','solve','sorry','south','space','spare','spark','spend','spice','spine','spite','split','spoke','spoon','sport','spray','sprig','squad','stack','staff','stage','stain','stale','stall','stand','stark','start','state','stays','steal','steam','steep','steer','stick','stiff','still','sting','stock','stone','storm','story','stove','study','style','suite','sunny','swarm','swear','sweep','sweet','swift','swing','sword','sworn','syrup',
  // T
  'taken','taste','teach','thick','thing','think','third','thorn','threw','throw','thumb','tight','tiger','timer','tired','toast','total','touch','tough','tower','toxic','trace','track','trade','train','trait','tramp','trash','tread','treat','trend','trial','trick','tried','troop','trust','truth','twice','twist',
  // U
  'unify','unite','unity','until','upper','upset','urban','usage','usual',
  // V
  'valid','value','vapor','vault','verse','video','vigor','viral','virus','visit','vital','vivid','vocal','voice','voter',
  // W
  'waste','watch','water','weary','weigh','weird','whale','wheat','where','which','while','whole','whose','witch','world','worry','worst','worth','would','wound','wrist','write','wrote',
  // X Y Z
  'xenon','yacht','yearn','yield','young','youth','zonal',
  // Extended — more common words
  'after','again','agent','align','angel','angry','annoy','apart','array','award','awake','baker','brawl','carry','child','clerk','cliff','cloth','clown','comet','comma','coral','crawl','dairy','dates','decay','delta','drink','dusty','dying','enact','enemy','enjoy','entry','equip','error','essay','event','every','exact','exile','exist','extra','fairy','false','fancy','fault','feast','fence','fight','final','first','fixed','flake','flank','flare','flash','flesh','float','flood','flour','focus','forte','found','frame','fully','glare','glide','gloom','glory','grace','grade','grain','grand','grasp','grass','graze','greed','greet','grief','grill','grind','groan','gross','grove','grown','guard','guess','guest','guide','guild','guilt','guise','habit','harsh','haven','heart','heavy','human','hurry','image','imply','index','inner','joint','judge','jumbo','kneel','knife','label','large','laser','learn','legal','level','light','limit','liver','lodge','lower','match','mayor','metal','might','minor','money','month','moral','motor','mount','mouse','mouth','music','nerve','night','noble','noise','north','nurse','occur','other','owner','paint','panic','party','pause','pearl','pilot','pixel','plain','plate','plead','pluck','point','power','price','prime','probe','prone','pulse','query','quest','quick','quiet','radio','rally','ranch','rapid','ratio','reach','rebel','relax','reply','rider','right','rigid','rival','river','rocky','rough','royal','ruler','scale','scene','scope','scout','serve','seven','shade','shake','shame','shape','sharp','shift','shine','shirt','shock','shore','shout','sight','since','sized','skill','skull','slash','slave','sleep','slide','slope','small','smart','smell','smoke','solid','solve','south','space','spare','spark','spend','spine','spite','split','squad','stark','start','state','steal','steam','steep','steer','stick','stiff','still','sting','stock','stone','storm','story','stove','style','sunny','swear','sweep','sweet','swift','sword','taste','teach','thick','think','thorn','throw','tiger','tired','toast','total','touch','tough','tower','trace','track','trade','train','trait','trash','treat','trend','trial','trick','troop','trust','truth','twice','twist','unify','unite','until','upper','upset','urban','usage','usual','valid','value','vapor','vault','verse','video','vivid','vocal','voice','voter','waste','water','weary','weigh','weird','whale','wheat','whole','witch','world','worry','worth','write','xenon','yacht','yearn','yield','young','youth',
]);

function isValidEnglishWord(word) {
  if (word.length < 3) return false; // Minimum 3 letters
  return /^[a-z]+$/.test(word.toLowerCase()); // Only English alphabet letters allowed
}

function buildWordChainEmbed(g) {
  const chain=g.chain.slice(-6).join(' → ');
  const timeLeft = g.timeLimit || 10;
  return new EmbedBuilder().setColor('#9B59B6').setTitle('🔗 Word Chain — HARDCORE MODE')
    .setDescription(
      `**Chain (last 6):** ${chain||'*Starting soon...*'}\n\n` +
      `**Next letter:** \`${g.lastLetter.toUpperCase()}\` — must be **3+ letters**, an **English word**, never repeated!\n\n` +
      `<@${g.currentTurn}>'s turn! You have **${timeLeft} seconds!**`
    )
    .addFields(
      {name:`<@${g.p1}> ❤️`,value:'❤️'.repeat(g.lives1||3)+'🖤'.repeat(3-(g.lives1||3))+'  `'+g.words1+'` words',inline:true},
      {name:`<@${g.p2}> ❤️`,value:'❤️'.repeat(g.lives2||3)+'🖤'.repeat(3-(g.lives2||3))+'  `'+g.words2+'` words',inline:true},
    ).setFooter({text:`⏱️ ${timeLeft}s per turn • Min 3 letters • English words only • No repeats`}).setTimestamp();
}

// ─── Trivia Battle Helpers — HARD questions ────────────────────────────────────
const TRIVIA_BATTLE_Q = [
  {q:'What is the atomic number of Carbon?', a:'12', choices:['6','10','12','14']},
  {q:'Which mathematician proved Fermat\'s Last Theorem?', a:'Wiles', choices:['Euler','Wiles','Gauss','Ramanujan']},
  {q:'What is the powerhouse of the cell?', a:'Mitochondria', choices:['Nucleus','Ribosome','Mitochondria','Golgi']},
  {q:'In which year did the Berlin Wall fall?', a:'1989', choices:['1985','1987','1989','1991']},
  {q:'What does DNA stand for?', a:'Deoxyribonucleic Acid', choices:['Deoxyribonucleic Acid','Dinitrogen Acid','Dynamic Nucleic Agent','Dual Nitrogen Array']},
  {q:'What is the hardest natural substance on Earth?', a:'Diamond', choices:['Tungsten','Titanium','Diamond','Quartz']},
  {q:'How many teeth do adult humans have?', a:'32', choices:['28','30','32','34']},
  {q:'Which organ produces insulin?', a:'Pancreas', choices:['Liver','Kidney','Pancreas','Spleen']},
  {q:'What is the capital of Australia?', a:'Canberra', choices:['Sydney','Melbourne','Canberra','Brisbane']},
  {q:'What is 17 × 19?', a:'323', choices:['303','313','323','333']},
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
const BS_SIZE = 15;
const BS_COLS = 'ABCDEFGHIJKLMNO'; // 15 columns
const BS_SHIPS = [
  {name:'Carrier',len:5},
  {name:'Battleship',len:4},
  {name:'Cruiser',len:3},
  {name:'Submarine',len:3},
  {name:'Destroyer',len:2},
  {name:'Patrol Boat',len:2},
  {name:'Scout',len:1},
  {name:'Scout 2',len:1},
]; // total 21 cells on 15x15
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
  // Split into two halves for Discord's message length limits
  const half = Math.ceil(BS_SIZE / 2);
  function renderHalf(startCol, endCol) {
    const header = '`  ' + BS_COLS.slice(startCol, endCol).split('').join(' ') + '`';
    let out = header + '\n';
    for(let r=0;r<BS_SIZE;r++){
      let row=`\`${String(r+1).padStart(2)} `;
      for(let c=startCol;c<endCol;c++){
        const hit=shots.some(s=>s[0]===r&&s[1]===c);
        if(hit){ row+=board[r][c]===1?'💥':'〰'; }
        else if(showShips&&board[r][c]===1){ row+='🚢'; }
        else { row+='🟦'; }
      }
      out+=row+'`\n';
    }
    return out;
  }
  return renderHalf(0, half) + '\n' + renderHalf(half, BS_SIZE);
}
function parseBSCoord(str) {
  const m=str.trim().toUpperCase().match(/^([A-O])(\d{1,2})$/);
  if(!m) return null;
  const row=parseInt(m[2])-1;
  const col=BS_COLS.indexOf(m[1]);
  if(row<0||row>=BS_SIZE||col<0) return null;
  return [row, col];
}
function buildBSEmbed(g, whose='your') {
  const opp=whose==='your'?g.p2:g.p1;
  const board=whose==='your'?g.board2:g.board1;
  const shots=whose==='your'?g.shots1:g.shots2;
  const ships=whose==='your'?g.ships2:g.ships1;
  const sunk=ships.filter(s=>s.hits>=s.len).length;
  return new EmbedBuilder().setColor('#3498DB').setTitle(`🚢 Battleship — <@${g.currentTurn}>'s Turn`)
    .setDescription(`**Your Attack Grid** (targeting <@${opp}>)\n${renderBSGrid(board,shots)}\n💥 Hits shown | 〰 Miss | 🟦 Unknown\n\n**Ships sunk:** ${sunk}/${ships.length} | Type a coordinate like \`A1\`, \`H8\`, \`O15\``)
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

// ─── Scramble Helpers — HARD words only ───────────────────────────────────────
const SCRAMBLE_WORDS = [
  {word:'EXQUISITE',hint:'Extremely beautiful or delicate 💎'},
  {word:'MYSTERIOUS',hint:'Difficult to understand or explain 🔮'},
  {word:'SILHOUETTE',hint:'A dark shape against a lighter background 🌅'},
  {word:'CHRYSALIS',hint:'The pupa stage of a butterfly 🦋'},
  {word:'LABYRINTH',hint:'A complicated network of paths 🌀'},
  {word:'PHENOMENON',hint:'A remarkable or exceptional thing 🌟'},
  {word:'TURBULENCE',hint:'Irregular motion of air or water ✈️'},
  {word:'KALEIDOSCOPE',hint:'A tube with colorful changing patterns 🔭'},
  {word:'PROTAGONIST',hint:'The main character in a story 📖'},
  {word:'CATASTROPHE',hint:'A sudden great disaster 💥'},
  {word:'MELANCHOLY',hint:'A feeling of deep sadness 😢'},
  {word:'ARCHAEOLOGY',hint:'Study of human history through excavation 🏺'},
  {word:'CAMOUFLAGE',hint:'Concealing appearance to blend in 🦎'},
  {word:'RENAISSANCE',hint:'Revival of European art and literature 🎨'},
  {word:'EQUILIBRIUM',hint:'A state of balance ⚖️'},
  {word:'FLAMBOYANT',hint:'Tending to attract attention 🦚'},
  {word:'PARADOX',hint:'A self-contradicting statement 🤯'},
  {word:'ZEPPELIN',hint:'A type of large rigid airship 🚁'},
  {word:'BUREAUCRACY',hint:'A system of complex rules and procedures 📋'},
  {word:'MELLIFLUOUS',hint:'Sweet or musical; pleasant to hear 🎵'},
];
function scrambleWord(word) {
  const arr=word.split('');
  let s;
  do { for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];} s=arr.join(''); } while(s===word);
  return s;
}

// ─── Emoji Decode Helpers — HARDER puzzles ────────────────────────────────────
const EMOJI_PUZZLES = [
  {emojis:'🌍🌊🔥',answer:'globalwarming',display:'Global Warming',hint:'Climate crisis 🌡️'},
  {emojis:'👁️🦷🩸',answer:'eyetooth',display:'Eye Tooth',hint:'A type of canine tooth 🦷'},
  {emojis:'🧠⚡💡',answer:'brainstorm',display:'Brainstorm',hint:'Creative thinking session 💡'},
  {emojis:'🌙🐺🌕',answer:'werewolf',display:'Werewolf',hint:'Full moon creature 🐺'},
  {emojis:'🦋🪤',answer:'butterfly trap',display:'Butterfly Trap',hint:'Catching insects 🏕️'},
  {emojis:'❄️👸',answer:'snowqueen',display:'Snow Queen',hint:'Famous fairy tale character 👑'},
  {emojis:'🐍🍎🌳',answer:'serpentgarden',display:'Serpent Garden',hint:'Biblical setting 📖'},
  {emojis:'⏳🏖️☀️',answer:'hourglass beach',display:'Hourglass Beach',hint:'Time and sand ⌛'},
  {emojis:'🎭🔪🌹',answer:'dramablade',display:'Drama Blade',hint:'Theatrical danger ⚔️'},
  {emojis:'🌊🧊🔥💨',answer:'fourelements',display:'Four Elements',hint:'Ancient philosophy 🌍'},
  {emojis:'🦅🇺🇸🌟',answer:'americaneagle',display:'American Eagle',hint:'National symbol 🦅'},
  {emojis:'🎪🤹🎠',answer:'carnival',display:'Carnival',hint:'Festive fair 🎡'},
  {emojis:'🧊🏰',answer:'iccastle',display:'Ice Castle',hint:'Frozen fortress 🥶'},
  {emojis:'🦁❤️',answer:'braveheart',display:'Brave Heart',hint:'Famous film 🎬'},
  {emojis:'🌪️🏠🌈',answer:'wizard of oz',display:'Wizard of Oz',hint:'Dorothy\'s adventure 🐕'},
];

// ─── Fast Type Data — HARD sentences ─────────────────────────────────────────
const FASTTYPE_SENTENCES = [
  'The quick brown fox jumps over the lazy dog near the river bank',
  'Pack my box with five dozen liquor jugs and bring them here immediately',
  'How vexingly quick daft zebras jump over the perplexing silver fence',
  'The five boxing wizards jump quickly past the extraordinary golden gate',
  'Programming is the art of turning caffeine and frustration into functional code',
  'Extraordinary claims require extraordinary evidence and meticulous scientific analysis',
  'The phenomenon of bioluminescence continues to baffle and astonish marine biologists',
  'Simultaneously balancing multiple complex equations requires remarkable concentration and patience',
  'Cryptography protects sensitive information through mathematical algorithms and computational complexity',
  'The labyrinthine bureaucracy of modern governments frustrates citizens and officials simultaneously',
];

// ─── Truth or Dare Data ────────────────────────────────────────────────────────
const TRUTHS = [
  'What is your most embarrassing moment?',
  'What is your biggest fear in life?',
  'Have you ever lied to your best friend? What was it about?',
  'What is your biggest regret so far?',
  'What is the most childish thing you still secretly do?',
  'What was the worst first impression you ever made on someone?',
  'Have you ever cheated in a game or exam?',
  'What is your weirdest habit that you rarely tell people about?',
  'What is the most embarrassing thing currently in your room?',
  'What is the biggest lie you have ever told?',
  'What is something you are secretly really bad at?',
  'What is the most embarrassing thing that happened to you in public?',
  'Have you ever accidentally sent a message to the wrong person? What did it say?',
  'What is the strangest dream you have ever had?',
  'If you could erase one memory, what would it be?',
  'Have you ever walked into a wrong room and pretended you meant to go there?',
  'What is the pettiest reason you have ever stopped talking to someone?',
  'What is something you pretend to like just to fit in?',
  'Have you ever laughed at the absolute worst time? What happened?',
  'What is a secret talent you have that nobody knows about?',
  'What is the most ridiculous thing you have ever cried about?',
  'What app on your phone would be most embarrassing if everyone saw?',
  'What is the most awkward conversation you have ever had?',
  'If your parents saw your entire search history, how bad would it be (1-10)?',
  'What is a lie you told that the other person still believes today?',
  'Who in this server do you find the funniest, and why?',
  'Have you ever muted or ignored someone in this server without telling them?',
  'Who would you trust the most here in a real-life emergency?',
  'What is the most unhinged message you have ever sent in any Discord server?',
  'What is a food combination you secretly enjoy that others would find disgusting?',
];
const DARES = [
  'Send a random GIF in this channel right now!',
  'Type your next 3 messages with your eyes completely closed!',
  'Change your nickname to "🥔 Potato 🥔" for the next 10 minutes!',
  'Send your next message completely in CAPS LOCK!',
  'Write a 2-line poem about this server and post it here!',
  'Describe the most recent meme from your camera roll (description only, no spoilers)!',
  'Speak only in rhymes for your next 5 messages!',
  'Tell a fun or embarrassing fact about yourself right now!',
  'Use only emojis to describe how your day has been!',
  'Write a dramatic villain speech (minimum 3 lines) and post it in chat!',
  'Say something genuinely nice about every person currently online in this server!',
  'Describe the weirdest dream you remember in the most dramatic way possible!',
  'In exactly 10 words, describe what you are doing right now!',
  'In 3 sentences, write a fake news story about this server!',
  'Come up with a creative nickname for everyone mentioned in this game!',
  'Roast yourself in 3 sentences and post it here!',
  'Tell a joke — if nobody reacts with 😂, tell another one!',
  'React to the last 5 messages with random emojis — no explanations allowed!',
  'Do 10 jumping jacks and come back to report you actually did them!',
  'Drink a full glass of water as fast as you can and report your time!',
  'Compliment every person in this channel with a unique one-liner!',
  'Send a voice message (or describe out loud) doing your best impression of someone!',
  'For the next 3 messages, add "...but that is just my opinion 🤷" to everything you say!',
  'Write a dramatic 3-sentence movie plot where the main character is you!',
  'Ask a genuine question to every person currently mentioned in this game!',
];
const HM_WORDS = [
  // Longer, harder words
  'javascript','programming','keyboard','elephant','butterfly','telescope','algorithm','database','adventure','developer',
  'parliament','chameleon','circumstances','equivalent','magnificent','crystallize','philosophical','communicate','constellation','phenomenon',
  'knowledgeable','mischievous','conscientious','uncomfortable','sophisticated','revolutionary','catastrophic','perpendicular','exaggerating','disappearance',
  'reconnaissance','extraordinary','overwhelming','disqualified','acquaintance','simultaneously','Mediterranean','unquestionable','fundamentalist','unconstitutional'
];
const HM_STAGES = [
  '```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```',
];

// ─── Trivia Data — HARD ───────────────────────────────────────────────────────
const TRIVIA = [
  {q:'What is the only country that borders both the Atlantic and Indian Oceans?', a:'south africa', c:['Brazil','South Africa','Nigeria','Argentina']},
  {q:'How many bones are in the human wrist?', a:'8', c:['6','8','10','12']},
  {q:'Which element has the highest melting point?', a:'tungsten', c:['Titanium','Tungsten','Platinum','Carbon']},
  {q:'What is the speed of light in km/s (approx)?', a:'300000', c:['150000','300000','450000','600000']},
  {q:'Who developed the theory of general relativity?', a:'einstein', c:['Newton','Einstein','Hawking','Bohr']},
  {q:'What is the chemical formula for table salt?', a:'nacl', c:['NaOH','NaCl','KCl','MgCl2']},
  {q:'Which planet has the most moons?', a:'saturn', c:['Jupiter','Saturn','Uranus','Neptune']},
  {q:'In what year did World War I begin?', a:'1914', c:['1912','1914','1916','1918']},
  {q:'What is the largest organ in the human body?', a:'skin', c:['Liver','Heart','Skin','Brain']},
  {q:'Which programming language was created by Guido van Rossum?', a:'python', c:['Ruby','Python','Perl','Java']},
  {q:'What is the square root of 169?', a:'13', c:['11','12','13','14']},
  {q:'Which country has the most UNESCO World Heritage Sites?', a:'italy', c:['China','France','Italy','Spain']},
];

// ─── Wordle Words — HARD (uncommon but valid 5-letter English words) ──────────
// ─── Wordle answer pool (common, well-known 5-letter English words) ───────────
const WORDLE_WORDS = [
  'about','above','abuse','acute','admit','adopt','adult','after','again','agent',
  'agree','ahead','alarm','album','alert','alike','align','alive','alley','allow',
  'alone','along','alter','angel','anger','angle','angry','anime','ankle','annex',
  'antic','anvil','aorta','apple','apply','apron','arena','argue','arise','armor',
  'aroma','arose','array','arrow','arson','artsy','aside','asked','asset','atlas',
  'attic','audio','audit','aunts','avail','avocado','avoid','awake','award','aware',
  'awful','basic','basis','batch','beach','beard','beast','began','begin','being',
  'below','bench','berry','black','blade','blame','bland','blank','blast','blaze',
  'bleed','blend','bless','blind','blink','block','blood','bloom','blown','board',
  'bonus','boost','booth','bound','boxer','brace','braid','brain','brand','brave',
  'bread','break','breed','brick','bride','brief','bring','broad','broke','brook',
  'brown','build','built','burst','buyer','cabin','candy','canon','cargo','carry',
  'catch','cause','chain','chair','chalk','chaos','chart','chase','cheap','check',
  'cheek','cheer','chess','chest','chief','child','china','chips','claim','clash',
  'class','clean','clear','clerk','click','cliff','clock','close','cloud','coast',
  'color','comet','comic','comma','coral','couch','could','count','court','cover',
  'crack','craft','crane','crash','crawl','cream','creek','crime','crisp','cross',
  'crowd','crown','crush','curve','cycle','daily','dairy','dance','death','debut',
  'decay','delay','dense','depot','depth','devil','dirty','disco','dodge','doing',
  'doubt','dough','draft','drain','drama','drank','dread','dream','dress','drift',
  'drink','drive','drove','drown','dunno','dusty','dwarf','early','earth','eight',
  'elect','elite','empty','ended','enjoy','enter','entry','equal','essay','ethic',
  'evoke','exact','exist','extra','faint','faith','fancy','fault','feast','fence',
  'ferry','fever','field','fight','final','first','fixed','fjord','flame','flare',
  'flash','fleet','flesh','flint','float','flood','floor','flour','fluid','focus',
  'force','forge','forum','found','frame','frank','fraud','fresh','front','frost',
  'fruit','fully','funny','genre','ghost','given','gland','glass','gloom','gloss',
  'glove','glued','gnash','going','grace','grade','grain','grand','grant','graph',
  'grasp','grass','grave','greed','green','greet','grief','grill','grind','groan',
  'groin','groom','group','grove','grown','guess','guest','guide','guild','guile',
  'guilt','gusto','happy','harsh','haven','heart','heavy','hedge','hence','hinge',
  'hippo','hobby','honor','horse','hotel','hotel','hours','house','human','humor',
  'hurry','ideal','image','imply','inbox','index','indie','infer','inner','input',
  'inter','intro','issue','ivory','joust','judge','juice','juicy','karma','kneel',
  'known','kudos','label','large','laser','laugh','layer','learn','lease','leave',
  'legal','lemon','level','light','limit','liver','liver','llama','local','lodge',
  'logic','login','loose','lover','lower','lowly','lucky','lunar','lyric','magic',
  'major','maker','manor','maple','march','match','maxim','mayor','media','mercy',
  'merge','merit','metal','might','minor','minus','model','money','month','moral',
  'mould','mound','mount','mouse','mouth','moved','movie','muddy','music','naive',
  'nerve','never','nexus','night','ninja','noble','noise','north','noted','novel',
  'nurse','nymph','occur','offer','often','oiled','olive','onion','opera','optic',
  'orbit','order','organ','other','outer','owned','owner','oxide','ozone','paint',
  'panel','panic','paper','party','pasta','patch','pause','peace','pearl','pedal',
  'penny','perch','perky','phase','phone','photo','piano','piece','pilot','pinch',
  'pitch','pixel','pizza','place','plain','plane','plant','plaza','plead','plumb',
  'plume','plump','plunge','point','polar','power','press','price','pride','prime',
  'print','prior','probe','prone','proof','prose','proud','prowl','psalm','pulse',
  'punch','pupil','puppy','purse','quaff','quest','quick','quiet','quirk','quota',
  'quote','rabbi','radar','radio','raise','rally','ranch','range','rapid','ratio',
  'reach','react','realm','rebel','refer','reign','relax','remix','repay','repel',
  'reply','rerun','reset','ridge','right','rigid','risky','rivet','robot','rocky',
  'rouge','rough','round','route','royal','rugby','ruler','runny','rural','rusty',
  'sadly','saint','salad','salon','sandy','sauce','scale','scare','scene','score',
  'scout','screw','seize','sense','setup','seven','shard','share','shark','sharp',
  'sheen','sheep','sheer','shelf','shell','shift','shine','shirt','shock','shoot',
  'shore','shout','shrug','siege','siren','sixth','skill','slack','slant','slate',
  'sleek','sleep','slice','slide','slime','slope','smack','small','smart','smell',
  'smile','smirk','smoke','snake','solar','solid','solve','sorry','south','space',
  'spark','spawn','speak','spend','spice','spill','spine','spite','split','spoon',
  'spore','sport','spray','squad','squid','stack','staff','stage','stain','stair',
  'stake','stamp','stand','stark','stash','state','stays','steam','steel','steep',
  'steer','stern','stick','stiff','still','stock','stoic','stole','stone','stood',
  'store','storm','story','strap','straw','stray','strip','strum','study','style',
  'suave','sugar','suite','sunny','super','surge','swamp','swear','sweep','sweet',
  'swept','swift','swipe','sword','synth','taboo','taste','tense','terms','thief',
  'thick','thing','think','third','thorn','those','three','threw','throw','thrum',
  'thyme','tidal','tiger','tight','timer','title','toast','today','token','total',
  'touch','tough','tower','toxic','track','trade','trail','train','trait','trash',
  'trawl','tread','treat','trend','trial','tribe','trick','tried','troop','trove',
  'truck','truly','tryst','tuned','twice','twist','twixt','ultra','uncle','under',
  'unify','union','unite','unity','until','upper','upset','urban','usage','usual',
  'utter','valid','value','valve','vapor','vault','video','vigil','vigor','viral',
  'virus','visit','vital','vivid','voice','voter','vouch','vowel','waste','water',
  'weary','weave','wedge','weird','wheat','wheel','where','which','while','white',
  'whole','whose','wield','winch','witch','woman','women','world','worry','worse',
  'worst','worth','would','wound','wrath','wrist','wrote','xenon','yacht','young',
  'yours','youth','zebra','zesty','zippy','zonal',
];

// ─── Wordle valid-guess dictionary (all common 5-letter English words) ─────────
// Includes the answer pool above + thousands more real English words for validation
const WORDLE_VALID_WORDS = new Set([
  ...WORDLE_WORDS,
  // Additional valid guesses (real English words, not used as answers)
  'aahed','aalii','abaci','abaft','abase','abash','abate','abbey','abbot','abeam',
  'abhor','abide','abler','abode','aboon','abbot','abuzz','acock','acorn','acrid',
  'acted','acmes','acned','acnes','acres','acock','addax','adder','adieu','adman',
  'adobe','aegis','afoul','agape','agave','agaze','aglow','agone','agony','agora',
  'agued','ahull','aided','aimer','aired','aitch','alack','algae','algal','allay',
  'aloft','aloud','alpha','alula','alums','amass','amaze','ambry','amice','amide',
  'amiss','amour','ample','amuse','ancon','anear','anele','anent','anime','ankh',
  'annul','anode','apace','apian','apish','aport','arced','ardor','areal','ariel',
  'ashed','ashen','asker','assay','atilt','atoll','atone','atony','atopy','attar',
  'auger','augur','avian','avion','awash','awful','awing','awned','awoke','awry',
  'azide','azure','babel','badly','bagel','baggy','baize','balky','baulk','beady',
  'beefy','befit','belle','belly','besot','bidet','bight','bigot','bilge','bilgy',
  'binge','bison','bitsy','bitty','blare','bleat','bloke','blunt','boded','boggy',
  'bogus','boite','bolus','bossy','botch','bothy','boxed','breve','briny','brisk',
  'broil','brood','bruise','brunt','brusk','bucky','buddy','buggy','bulge','bulgy',
  'bully','bumpy','bunny','burly','burro','bushy','busty','butch','butty','cacao',
  'caddy','cadet','caiman','cairn','calve','cameo','canny','canoe','caper','capon',
  'carob','carom','catnip','catty','caulk','ceded','cello','champ','chant','chary',
  'chasm','cheep','chert','chide','chime','chimp','choir','chomp','chord','chore',
  'chump','chunk','cider','cigar','cirri','civic','civvy','clack','clamp','clang',
  'clank','claro','cleat','cleave','cleft','cliché','clink','cloak','clone','clot',
  'clout','clove','coaly','cobra','cocoa','coked','comfy','compa','condo','coney',
  'conky','copal','copse','comet','corgi','corny','cozen','cramp','crave','credo',
  'creep','crepe','crick','croup','crumb','cruse','crypts','cubby','cubic','cupid',
  'curly','curry','cutey','cutie','daddy','daffy','dally','dandy','darer','davit',
  'daffy','decal','decoy','decry','delta','demon','derma','deter','dicey','dicot',
  'disco','ditty','divvy','dodgy','dolly','donna','doozy','dopey','dorky','dotty',
  'dowdy','dowel','downy','dowse','doyen','drake','drawl','drily','droit','drone',
  'drool','droop','drupe','dryer','dully','dumpy','dunce','duped','dusky','eclat',
  'edged','edger','eerie','egads','egret','elide','elite','emcee','emend','enact',
  'ennui','epact','epode','ergot','event','every','evict','expel','extol','exude',
  'exult','eyrie','fable','facet','fairy','faker','fakir','farce','fatal','fauna',
  'feign','feral','fetid','fetal','fiber','filch','filet','filly','filmy','finch',
  'fined','fishy','fizzy','flair','flank','fleck','fleck','flier','fling','flint',
  'flirt','floss','fluky','flute','flyer','foamy','focal','folly','foray','forge',
  'forgo','forte','foyer','frail','freak','friar','frill','frond','frugal','frump',
  'fudge','fugue','fungi','funky','fussy','fuzzy','gable','galley','gamey','gamin',
  'gamut','gassy','gaudy','gauze','gavel','gawky','geeky','gecko','genie','genre',
  'getup','ghoul','giddy','gilet','gimpy','girly','glare','glint','gloat','glogg',
  'gloom','gluon','glyph','godly','going','golly','gonzo','gorge','gorse','gouty',
  'graft','grimy','gripe','grout','gruel','gruff','grume','grump','guava','gulch',
  'gummy','gunky','guppy','gutsy','hammy','handy','hardy','harpy','hasty','hazel',
  'heave','hefty','helix','hellion','hippy','hoary','hoboe','holly','homer','hoary',
  'hooky','horny','hovel','hulky','humus','hunky','hurly','husky','hyena','hyper',
  'icily','icky','icing','imago','impel','incur','indie','inept','inert','infix',
  'ingot','inlay','inlet','inset','inter','irate','irked','itchy','jingo','jingo',
  'jiffy','jimmy','juror','kebab','ketch','kinky','knack','knave','knoll','knuck',
  'lanky','lapel','lardy','larva','lasso','latke','leaky','leggy','lemur','libel',
  'lichen','lingo','liner','liner','lingo','linky','lippy','listy','livid','llano',
  'loamy','loopy','lousy','lumpy','lusty','lying','mafia','mambo','mammal','mango',
  'manor','maori','mauve','mealy','measly','medic','melee','micro','mimed','mimic',
  'minty','mirth','miser','missy','misty','mogul','moldy','moist','moose','mossy',
  'motto','mousy','muggy','mulch','mummy','murky','mushy','musky','musty','myrrh',
  'nabob','natch','natty','nerdy','nettle','nifty','nippy','nitty','noddy','noisy',
  'nonce','nooky','norma','nubby','nutty','nymph','oaken','oater','occur','offal',
  'oldie','ombre','onset','opera','opsin','ovoid','ovule','owing','ozone','paddy',
  'pansy','panty','papaw','parka','parry','patsy','patty','paunchy','penal','perky',
  'pesky','petty','pewit','phage','phony','picky','piggy','piney','pinky','pipit',
  'pique','pithy','piton','plaid','plait','pleat','plonk','pluck','podgy','pokey',
  'polka','poppy','potty','pouty','preen','privy','primp','prink','prior','privy',
  'pshaw','pubic','pudgy','pudgy','puffed','pulpy','punky','punny','puppy','purty',
  'pushy','quaff','quaky','qualm','queen','queue','quill','quip','quirky','quota',
  'rabid','rainy','rakish','rampage','rancid','randy','rangy','rangy','raspy','ratty',
  'rawly','rebut','recap','recut','redux','reedy','refit','relax','remix','renal',
  'retch','retry','retro','ribby','rifled','right','risky','roomy','ropey','ruddy',
  'rugby','ruler','rummy','runup','sacky','saggy','salsa','sappy','sassy','savor',
  'savvy','scald','scalp','scaly','scamp','scant','scone','scoop','scoot','scorn',
  'scott','scram','scrub','scrum','sedan','seedy','shack','shady','shaky','shawl',
  'sheaf','sheen','shiny','shoal','showy','shrub','shrivel','shuck','shunt','silly',
  'sinew','siren','sixth','sixty','skewy','skimp','skipper','skirt','skulk','slang',
  'sleek','sleet','slick','slosh','sloth','slump','slung','slunk','slurp','slyly',
  'smelt','smite','smolt','snobbish','snoop','snore','snort','snowy','snuck','soggy',
  'solid','sonic','soppy','sorry','spank','spasm','speck','spill','spiny','spirt',
  'spoof','spook','spool','spore','spout','sprout','spunk','spurn','spurt','squab',
  'squall','squat','squelch','stab','staid','staunch','stays','stealth','stilt',
  'stomp','stony','stove','strap','strut','stubby','stuck','study','stung','stunk',
  'stunt','suede','sulky','sumac','surly','swung','tabby','taffy','tangy','tardy',
  'tarry','tatty','tawny','tepid','terse','testy','their','theirs','thick','thong',
  'thorn','throb','throe','tiara','tight','tilde','tippy','tipsy','titan','toady',
  'tonal','topaz','toque','torso','total','totty','totem','toxic','toyon','tread',
  'treed','trees','trice','trite','troth','trump','trunk','tubby','tulip','tumor',
  'tunic','turbo','turfy','tushy','tusky','twang','tweak','twerp','twigg','twill',
  'ulcer','ultra','uncut','undue','unfit','unwed','unzip','uppity','usurp','vague',
  'vapid','vaunt','vegan','venal','venom','venue','verge','verse','vicar','villa',
  'viper','vireo','vogue','voila','vomit','vying','wacky','wader','waged','wagon',
  'waken','wanly','warty','waspy','weedy','welch','wimpy','windy','wispy','witty',
  'wobbly','womby','wonky','wormy','wrack','wraith','wrung','wryly','yucky','yummy',
  'zappy','zappy','zingy','zippy','zombi','zoned',
]);

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


// ═══════════════════════════════════════════════════════════════════════════════
// ─── TEXAS HOLD'EM POKER ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const pokerGames = {};

const POKER_SUITS = ['♠️','♥️','♦️','♣️'];
const POKER_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const POKER_RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function makePokerDeck() {
  const d = [];
  for (const s of POKER_SUITS) for (const r of POKER_RANKS) d.push({s, r, v: POKER_RANK_VAL[r]});
  for (let i = d.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [d[i],d[j]] = [d[j],d[i]]; }
  return d;
}
const pokerCardStr = (c) => `${c.r}${c.s}`;
const pokerHandStr = (h) => h.map(pokerCardStr).join(' ');

function evaluatePokerHand(cards) {
  // cards = array of 5..7 cards; returns best 5-card hand rank
  const combos = [];
  if (cards.length <= 5) { combos.push(cards); }
  else {
    // generate all C(n,5) combinations
    for (let i=0; i<cards.length; i++)
      for (let j=i+1; j<cards.length; j++)
        for (let k=j+1; k<cards.length; k++)
          for (let l=k+1; l<cards.length; l++)
            for (let m=l+1; m<cards.length; m++)
              combos.push([cards[i],cards[j],cards[k],cards[l],cards[m]]);
  }
  let best = null;
  for (const combo of combos) {
    const score = scorePoker5(combo);
    if (!best || score.rank > best.rank || (score.rank === best.rank && score.tiebreak > best.tiebreak))
      best = score;
  }
  return best;
}

function scorePoker5(cards) {
  const vals = cards.map(c=>c.v).sort((a,b)=>b-a);
  const suits = cards.map(c=>c.s);
  const flush = suits.every(s=>s===suits[0]);
  const straight = vals.every((v,i)=>i===0||vals[i-1]-v===1) ||
    JSON.stringify(vals) === JSON.stringify([14,5,4,3,2]);
  const counts = {};
  vals.forEach(v=>{counts[v]=(counts[v]||0)+1;});
  const groups = Object.entries(counts).map(([v,c])=>({v:parseInt(v),c})).sort((a,b)=>b.c-a.c||b.v-a.v);
  const tb = vals[0]*1000000+vals[1]*10000+vals[2]*100+vals[3]*10+vals[4];

  if (flush && straight && vals[0]===14 && vals[4]===10) return {rank:9,name:'👑 Royal Flush',tiebreak:tb};
  if (flush && straight) return {rank:8,name:'🌊 Straight Flush',tiebreak:vals[0]};
  if (groups[0].c===4) return {rank:7,name:'4️⃣ Four of a Kind',tiebreak:groups[0].v*100+groups[1].v};
  if (groups[0].c===3&&groups[1].c===2) return {rank:6,name:'🏠 Full House',tiebreak:groups[0].v*100+groups[1].v};
  if (flush) return {rank:5,name:'♠️ Flush',tiebreak:tb};
  if (straight) return {rank:4,name:'🔀 Straight',tiebreak:vals[0]};
  if (groups[0].c===3) return {rank:3,name:'3️⃣ Three of a Kind',tiebreak:groups[0].v*100+tb};
  if (groups[0].c===2&&groups[1].c===2) return {rank:2,name:'👥 Two Pair',tiebreak:groups[0].v*100+groups[1].v*10+groups[2].v};
  if (groups[0].c===2) return {rank:1,name:'👤 One Pair',tiebreak:groups[0].v*10000+tb};
  return {rank:0,name:'💨 High Card',tiebreak:tb};
}

function buildPokerEmbed(g) {
  const p1 = g.players[0], p2 = g.players[1];
  const stageNames = ['Pre-Flop','The Flop','The Turn','The River','Showdown'];
  const stage = stageNames[Math.min(g.communityCards.length === 0 ? 0 : g.communityCards.length <= 3 ? 1 : g.communityCards.length === 4 ? 2 : 3, 4)];
  const pot = p1.bet + p2.bet + (g.pot||0);
  const communityDisplay = g.communityCards.length ? g.communityCards.map(pokerCardStr).join(' ') : '*Not yet dealt*';

  return new EmbedBuilder()
    .setColor('#1A472A')
    .setTitle('🃏 Texas Hold\'em Poker')
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎴 **Stage:** ${stage}  |  💰 **Pot:** ${pot} chips\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🌐 **Community Cards:**\n> ${communityDisplay}\n\n` +
      `👤 <@${p1.id}>  \`${p1.chips} chips\`  bet: ${p1.bet}  ${p1.folded?'❌ Folded':p1.allIn?'💥 All-In':''}\n` +
      `👤 <@${p2.id}>  \`${p2.chips} chips\`  bet: ${p2.bet}  ${p2.folded?'❌ Folded':p2.allIn?'💥 All-In':''}\n\n` +
      `**Current Turn:** <@${g.currentTurn}>`
    )
    .setFooter({text:`Round ${g.round}/10 — Texas Hold'em • Blinds: 10/20`})
    .setTimestamp();
}

function buildPokerActionRows(disabled) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('poker:fold').setLabel('❌ Fold').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('poker:call').setLabel('📞 Call/Check').setStyle(ButtonStyle.Primary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('poker:raise').setLabel('📈 Raise 20').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId('poker:allin').setLabel('💥 All-In').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  )];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── QUIZ SHOWDOWN (Team-based, 10 rounds, 30s timer) ───────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const quizShowdownGames = {};
const QUIZ_SHOWDOWN_Q = [
  {q:'What is 15 × 15?',a:'225',c:['200','225','215','250']},
  {q:'Which country is the largest by area?',a:'Russia',c:['Canada','USA','Russia','China']},
  {q:'What gas do plants absorb?',a:'Carbon Dioxide',c:['Oxygen','Nitrogen','Carbon Dioxide','Hydrogen']},
  {q:'Who painted the Mona Lisa?',a:'Leonardo da Vinci',c:['Picasso','Michelangelo','Leonardo da Vinci','Raphael']},
  {q:'How many sides does an octagon have?',a:'8',c:['6','7','8','9']},
  {q:'What is the chemical symbol for gold?',a:'Au',c:['Go','Gd','Au','Ag']},
  {q:'Which planet is closest to the Sun?',a:'Mercury',c:['Venus','Mercury','Mars','Earth']},
  {q:'In what year did World War II end?',a:'1945',c:['1943','1944','1945','1946']},
  {q:'What is the square root of 256?',a:'16',c:['14','15','16','18']},
  {q:'Which ocean is the largest?',a:'Pacific',c:['Atlantic','Indian','Pacific','Arctic']},
  {q:'How many chromosomes do humans have?',a:'46',c:['42','44','46','48']},
  {q:'What is the fastest land animal?',a:'Cheetah',c:['Lion','Cheetah','Leopard','Horse']},
  {q:'How many strings does a standard guitar have?',a:'6',c:['4','5','6','8']},
  {q:'What is Pi (first 3 digits)?',a:'3.14',c:['3.12','3.14','3.16','3.18']},
  {q:'Which element has the symbol "O"?',a:'Oxygen',c:['Osmium','Oxygen','Oganesson','Ozone']},
];

function buildQuizShowdownEmbed(g) {
  const q = g.questions[g.qNum];
  return new EmbedBuilder()
    .setColor('#FF6B35')
    .setTitle(`🏆 Quiz Showdown — Round ${g.qNum+1}/${g.questions.length}`)
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `❓ **${q.q}**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🅰️  ${q.c[0]}\n🅱️  ${q.c[1]}\n🅲  ${q.c[2]}\n🅳  ${q.c[3]}\n\n` +
      `⏱️ **30 seconds to answer!**\n👥 **Anyone can answer!** First correct gets the point!\n\n` +
      `**Scoreboard:**\n${Object.entries(g.scores).sort(([,a],[,b])=>b-a).map(([id,s],i)=>`${['🥇','🥈','🥉'][i]||'🏅'} <@${id}>: **${s}** pts`).join('\n')||'*No scores yet*'}`
    )
    .setFooter({text:`${g.questions.length} questions • Anyone can play! • Type A/B/C/D or full answer`})
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── MURDER MYSTERY (Multiplayer, social deduction) ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const murderGames = {};
const MM_SUSPECTS = ['🔴 Scarlet','🟡 Mustard','🟢 Green','🟣 Plum','⚪ White','🔵 Peacock'];
const MM_WEAPONS  = ['🔪 Knife','🔫 Revolver','🪓 Axe','🪢 Rope','🔨 Hammer','☕ Poison'];
const MM_ROOMS    = ['🏠 Kitchen','📚 Library','🎭 Theater','🌹 Garden','🚪 Hallway','🛋️ Lounge'];
const MM_CLUES = [
  'A muddy boot print was found near the {room}.',
  'Witnesses heard a loud crash near the {room} at midnight.',
  'The {weapon} was reported missing from the {room}.',
  'Security footage shows {suspect} leaving the {room} at 11:45pm.',
  'A torn piece of cloth matching {suspect}\'s outfit was found near {room}.',
  'The victim was last seen arguing with {suspect} in the {room}.',
  'Fingerprints matching {suspect} were found on the {weapon}.',
  'A witness spotted someone matching {suspect}\'s description carrying a {weapon}.',
];

function buildMurderMysteryEmbed(g, phase) {
  const intro = `**The Victim:** ${g.victim} has been found dead!\n**Scene:** ${g.scene}\n`;
  if (phase === 'voting') {
    return new EmbedBuilder()
      .setColor('#8B0000')
      .setTitle('🔍 Murder Mystery — VOTE NOW!')
      .setDescription(
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${intro}━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Clues Revealed:**\n${g.clues.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n\n` +
        `🗳️ **Who did it?** Players, vote by typing the suspect's name!\n` +
        `**Suspects:** ${MM_SUSPECTS.join(' | ')}\n\n` +
        `⏱️ **60 seconds to vote!**`
      )
      .setFooter({text:`Voting phase • Type a suspect name!`})
      .setTimestamp();
  }
  return new EmbedBuilder()
    .setColor('#4A0000')
    .setTitle('🔪 Murder Mystery — The Investigation')
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${intro}━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🔍 **Clue ${g.cluePhase}/4:** ${g.clues[g.cluePhase-1]||'*Gathering evidence...*'}\n\n` +
      `**Players:** ${g.players.map(id=>`<@${id}>`).join(', ')}\n\n` +
      `📋 **All Clues So Far:**\n${g.clues.slice(0,g.cluePhase).map((c,i)=>`${i+1}. ${c}`).join('\n')||'*None yet*'}`
    )
    .setFooter({text:`Clue ${g.cluePhase}/4 revealed • Next clue in 20s`})
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── TEAM TRIVIA (up to 4 teams, button-based team selection) ────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const TT_TEAMS = [
  { id: 'red',    label: '🔴 Team Red',    color: '#E74C3C', emoji: '🔴' },
  { id: 'blue',   label: '🔵 Team Blue',   color: '#3498DB', emoji: '🔵' },
  { id: 'green',  label: '🟢 Team Green',  color: '#2ECC71', emoji: '🟢' },
  { id: 'yellow', label: '🟡 Team Yellow', color: '#F1C40F', emoji: '🟡' },
];

const TT_QUESTIONS = [
  // Science
  {q:'What planet is known as the Red Planet?', a:1, c:['Venus','Mars','Jupiter','Saturn'], cat:'🔬 Science'},
  {q:'How many bones are in the adult human body?', a:2, c:['186','196','206','216'], cat:'🔬 Science'},
  {q:'What gas do plants absorb from the atmosphere?', a:0, c:['Carbon Dioxide','Oxygen','Nitrogen','Helium'], cat:'🔬 Science'},
  {q:'What is the chemical symbol for Gold?', a:1, c:['Gd','Au','Ag','Go'], cat:'🔬 Science'},
  {q:'What is the speed of light (approx, km/s)?', a:2, c:['150,000','200,000','300,000','400,000'], cat:'🔬 Science'},
  {q:'What is the powerhouse of the cell?', a:0, c:['Mitochondria','Nucleus','Ribosome','Vacuole'], cat:'🔬 Science'},
  {q:'How many elements are on the periodic table?', a:3, c:['108','112','116','118'], cat:'🔬 Science'},
  {q:'What planet has the most moons?', a:1, c:['Jupiter','Saturn','Uranus','Neptune'], cat:'🔬 Science'},
  // Geography
  {q:'What is the capital of Australia?', a:2, c:['Sydney','Melbourne','Canberra','Brisbane'], cat:'🌍 Geography'},
  {q:'Which country has the most natural lakes?', a:0, c:['Canada','Russia','USA','Brazil'], cat:'🌍 Geography'},
  {q:'What is the longest river in the world?', a:1, c:['Amazon','Nile','Yangtze','Mississippi'], cat:'🌍 Geography'},
  {q:'Which continent has the most countries?', a:0, c:['Africa','Asia','Europe','South America'], cat:'🌍 Geography'},
  {q:'What is the smallest country in the world?', a:2, c:['Monaco','Nauru','Vatican City','San Marino'], cat:'🌍 Geography'},
  {q:'Which ocean is the largest?', a:0, c:['Pacific','Atlantic','Indian','Arctic'], cat:'🌍 Geography'},
  {q:'What is the capital of Japan?', a:1, c:['Osaka','Tokyo','Kyoto','Hiroshima'], cat:'🌍 Geography'},
  // History
  {q:'In what year did World War II end?', a:2, c:['1943','1944','1945','1946'], cat:'📜 History'},
  {q:'Who was the first person to walk on the Moon?', a:0, c:['Neil Armstrong','Buzz Aldrin','Yuri Gagarin','John Glenn'], cat:'📜 History'},
  {q:'Which empire was the largest in history?', a:1, c:['Roman Empire','British Empire','Mongol Empire','Ottoman Empire'], cat:'📜 History'},
  {q:'In what year did the Berlin Wall fall?', a:2, c:['1987','1988','1989','1990'], cat:'📜 History'},
  {q:'Who painted the Mona Lisa?', a:0, c:['Leonardo da Vinci','Michelangelo','Raphael','Botticelli'], cat:'📜 History'},
  // Pop Culture & Entertainment
  {q:'How many strings does a standard guitar have?', a:1, c:['4','6','7','8'], cat:'🎭 Pop Culture'},
  {q:'What movie features the quote "I\'ll be back"?', a:2, c:['RoboCop','Die Hard','The Terminator','Predator'], cat:'🎭 Pop Culture'},
  {q:'Which band wrote "Bohemian Rhapsody"?', a:0, c:['Queen','The Beatles','Led Zeppelin','Rolling Stones'], cat:'🎭 Pop Culture'},
  {q:'How many Harry Potter books are there?', a:1, c:['6','7','8','9'], cat:'🎭 Pop Culture'},
  {q:'What sport is played at Wimbledon?', a:0, c:['Tennis','Cricket','Badminton','Squash'], cat:'🎭 Pop Culture'},
  // Math & Logic
  {q:'What is 17 × 13?', a:2, c:['199','213','221','231'], cat:'🧮 Math'},
  {q:'What is the square root of 144?', a:1, c:['11','12','13','14'], cat:'🧮 Math'},
  {q:'How many sides does a heptagon have?', a:2, c:['5','6','7','8'], cat:'🧮 Math'},
  {q:'What is 15% of 200?', a:0, c:['30','25','35','20'], cat:'🧮 Math'},
  {q:'What is the next prime after 23?', a:1, c:['25','29','27','31'], cat:'🧮 Math'},
  // Technology
  {q:'What does "HTTP" stand for?', a:0, c:['HyperText Transfer Protocol','High Transfer Text Protocol','Hyper Terminal Text Processing','Host Transfer Protocol'], cat:'💻 Technology'},
  {q:'Which company created the Java programming language?', a:1, c:['Microsoft','Sun Microsystems','IBM','Apple'], cat:'💻 Technology'},
  {q:'How many bits are in a byte?', a:2, c:['4','6','8','16'], cat:'💻 Technology'},
  {q:'What does "CPU" stand for?', a:0, c:['Central Processing Unit','Core Processor Unit','Computer Power Unit','Central Power Utility'], cat:'💻 Technology'},
  {q:'Which social media platform uses a bird as its logo?', a:1, c:['Instagram','Twitter/X','Snapchat','TikTok'], cat:'💻 Technology'},
  // Food & Nature
  {q:'What is the most consumed fruit in the world?', a:0, c:['Tomato','Banana','Apple','Mango'], cat:'🍕 Food & Nature'},
  {q:'How many legs does a spider have?', a:2, c:['6','7','8','10'], cat:'🍕 Food & Nature'},
  {q:'What is the largest land animal?', a:0, c:['African Elephant','White Rhino','Giraffe','Hippopotamus'], cat:'🍕 Food & Nature'},
  {q:'Which country is the largest producer of coffee?', a:1, c:['Colombia','Brazil','Ethiopia','Vietnam'], cat:'🍕 Food & Nature'},
  {q:'How many hearts does an octopus have?', a:2, c:['1','2','3','4'], cat:'🍕 Food & Nature'},
];

function shuffleTTQuestions(numQ) {
  const q = [...TT_QUESTIONS].sort(() => Math.random() - 0.5);
  return q.slice(0, Math.min(numQ, q.length));
}

function buildTTLobbyEmbed(g) {
  const teamLines = TT_TEAMS.filter(t => g.numTeams === 4 || ['red','blue','green','yellow'].slice(0,g.numTeams).includes(t.id))
    .map(t => {
      const members = g.teams[t.id] || [];
      return `${t.emoji} **${t.label}** (${members.length} player${members.length!==1?'s':''})\n${members.length ? members.map(id=>`> <@${id}>`).join('\n') : '> *No players yet*'}`;
    });
  return new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle('🏆 Team Trivia — Lobby')
    .setDescription(
      `**Host:** <@${g.host}> | **${g.numTeams} teams** | **${g.totalQ} questions**\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      teamLines.join('\n\n') +
      `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👇 **Click your team button to join!**\nWhen everyone is ready, the host types \`!ttstart\` to begin.`
    )
    .setFooter({ text: `Min 2 players total across at least 2 teams • Host: !ttstart to begin • !ttcancel to cancel` })
    .setTimestamp();
}

function buildTTTeamRows(g) {
  const activeTeams = TT_TEAMS.filter(t => ['red','blue','green','yellow'].slice(0,g.numTeams).includes(t.id));
  const styles = { red: ButtonStyle.Danger, blue: ButtonStyle.Primary, green: ButtonStyle.Success, yellow: ButtonStyle.Secondary };
  const row = new ActionRowBuilder();
  activeTeams.forEach(t => row.addComponents(
    new ButtonBuilder().setCustomId(`tt:join:${t.id}`).setLabel(t.label).setStyle(styles[t.id])
  ));
  row.addComponents(new ButtonBuilder().setCustomId('tt:leave').setLabel('🚪 Leave').setStyle(ButtonStyle.Secondary));
  return [row];
}

function buildTTQuestionEmbed(g) {
  const q = g.questions[g.qIdx];
  const activeTeams = TT_TEAMS.filter(t => ['red','blue','green','yellow'].slice(0,g.numTeams).includes(t.id));
  const scoreLine = activeTeams.map(t => `${t.emoji} **${t.label.replace('Team ','')}:** ${g.scores[t.id] || 0} pts`).join(' | ');
  return new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle(`🏆 Team Trivia — Q${g.qIdx + 1}/${g.totalQ}`)
    .setDescription(
      `📂 **Category:** ${q.cat}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `**${q.q}**\n\n` +
      q.c.map((opt, i) => `${['🇦','🇧','🇨','🇩'][i]} ${opt}`).join('\n') +
      `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🎯 **Answering:** ${TT_TEAMS.find(t=>t.id===g.currentTeam)?.emoji} **${TT_TEAMS.find(t=>t.id===g.currentTeam)?.label}**\n\n` +
      `📊 ${scoreLine}`
    )
    .setFooter({ text: `Only the answering team can respond • +2 pts correct, -0 pts wrong • Other teams +1 pt if they steal!` })
    .setTimestamp();
}

function buildTTAnswerRows(g, disabled = false) {
  const labels = ['🇦 A', '🇧 B', '🇨 C', '🇩 D'];
  return [new ActionRowBuilder().addComponents(
    ...['0','1','2','3'].map((i) =>
      new ButtonBuilder().setCustomId(`tt:ans:${i}`).setLabel(labels[i]).setStyle(ButtonStyle.Primary).setDisabled(disabled)
    )
  )];
}

function buildTTFinalEmbed(g) {
  const activeTeams = TT_TEAMS.filter(t => ['red','blue','green','yellow'].slice(0,g.numTeams).includes(t.id));
  const sorted = [...activeTeams].sort((a,b) => (g.scores[b.id]||0) - (g.scores[a.id]||0));
  const medals = ['🥇','🥈','🥉','🏅'];
  const podium = sorted.map((t, i) => {
    const members = (g.teams[t.id]||[]).map(id=>`<@${id}>`).join(', ') || '*No players*';
    return `${medals[i]} ${t.emoji} **${t.label}** — **${g.scores[t.id]||0} pts**\n> Players: ${members}`;
  }).join('\n\n');
  const mvpEntries = Object.entries(g.playerCorrect||{}).sort(([,a],[,b])=>b-a);
  const mvp = mvpEntries[0] ? `\n\n🌟 **MVP:** <@${mvpEntries[0][0]}> (${mvpEntries[0][1]} correct)` : '';
  return new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle('🏆 Team Trivia — Final Results!')
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${podium}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━${mvp}`
    )
    .setTimestamp();
}
const wordBombGames = {};
const WB_PROMPTS = [
  'IN','AN','OR','ER','ST','OU','TR','PL','GR','FR','CH','SH','TH','BL','CR',
  'PRE','CON','OUT','ING','ENT','EST','PRO','COM','EXP','INT','UND','OVE','MIS'
];

function buildWordBombEmbed(g) {
  const turnPlayer = g.players[g.turn % g.players.length];
  return new EmbedBuilder()
    .setColor('#FF4500')
    .setTitle('💣 Word Bomb — MULTIPLAYER!')
    .setDescription(
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💣 Your word must contain: **\`${g.prompt}\`**\n` +
      `⏱️ **${g.timeLimit} seconds** or you're eliminated!\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `**It's <@${turnPlayer}>'s turn!**\n` +
      `Type a word containing **${g.prompt}** in chat!\n\n` +
      `**Players Alive:**\n${g.players.map((id,i)=>`${i===g.turn%g.players.length?'💣':'✅'} <@${id}>`).join('\n')}\n\n` +
      `**Round:** ${g.round} | **Used Words:** ${g.usedWords.size}`
    )
    .setFooter({text:`Word must contain "${g.prompt}" • No repeats! • ${g.timeLimit}s to answer`})
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── ENHANCED HANGMAN (with rounds & scoreboard) ─────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
// Already exists — we'll upgrade it via the command handler

// ═══════════════════════════════════════════════════════════════════════════════
// ─── PREMIUM EMBED BUILDERS ──────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
const luxuryEmbed = (title, desc, color='#5865F2') =>
  new EmbedBuilder().setColor(color).setTitle(title).setDescription(
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${desc}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  ).setTimestamp();

const gameStartEmbed = (title, desc, color) =>
  new EmbedBuilder().setColor(color||'#5865F2')
    .setTitle(`✨ ${title}`)
    .setDescription(`╔══════════════════════════╗\n${desc}\n╚══════════════════════════╝`)
    .setTimestamp();

function buildScoreboard(scores, title='🏆 Final Scoreboard') {
  const sorted = Object.entries(scores).sort(([,a],[,b])=>b-a);
  const medals = ['🥇','🥈','🥉'];
  const lines = sorted.map(([id,s],i) => `${medals[i]||`${i+1}.`} <@${id}> — **${s} pts**`);
  return new EmbedBuilder()
    .setColor('#FFD700')
    .setTitle(title)
    .setDescription(lines.join('\n')||'No scores yet.')
    .setTimestamp();
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

  // Truth or Dare buttons
  if (interaction.isButton() && interaction.customId.startsWith('tod:')) {
    const g = truthDareGames[interaction.channel.id];
    if (!g) return interaction.reply({ content: '❌ No Truth or Dare game running here. Use `!truthordare` to start one!', ephemeral: true });

    const action = interaction.customId.split(':')[1];

    // Stop game
    if (action === 'stop') {
      delete truthDareGames[interaction.channel.id];
      return interaction.update({ embeds: [
        new EmbedBuilder().setColor('#ED4245').setTitle('🎭 Truth or Dare — Game Ended!')
          .setDescription(`<@${interaction.user.id}> ended the game. Thanks for playing!`)
          .setTimestamp()
      ], components: [] });
    }

    // Skip turn
    if (action === 'skip') {
      const skipperId = interaction.user.id;
      // Only allow the current player to skip
      if (skipperId !== g.currentPlayer) {
        return interaction.reply({ content: `❌ It's not your turn! It's <@${g.currentPlayer}>'s turn right now.`, ephemeral: true });
      }
      g.currentIndex = (g.currentIndex + 1) % g.players.length;
      g.currentPlayer = g.players[g.currentIndex];
      g.round++;
      const playerList = g.players.map((id, i) => `${i === g.currentIndex ? '▶️' : '⬜'} <@${id}>`).join('\n');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tod:truth').setLabel('🤔 Truth').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tod:dare').setLabel('🎯 Dare').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tod:skip').setLabel('⏭️ Skip Turn').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tod:stop').setLabel('🛑 Stop Game').setStyle(ButtonStyle.Secondary),
      );
      return interaction.update({ embeds: [
        new EmbedBuilder().setColor('#95A5A6').setTitle('🎭 Truth or Dare — Turn Skipped!')
          .setDescription(
            `<@${skipperId}> skipped their turn!\n\n` +
            `**Players:**\n${playerList}\n\n` +
            `<@${g.currentPlayer}>'s turn now!\n**Choose your fate 👇**`
          )
          .setFooter({ text: `Round ${g.round} • ${g.players.length} player(s)` })
          .setTimestamp()
      ], components: [row] });
    }

    // Truth or Dare — anyone can click for the current player, but should be the current player
    const isCurrentPlayer = interaction.user.id === g.currentPlayer;
    const choice = action; // 'truth' or 'dare'
    const list = choice === 'truth' ? TRUTHS : DARES;
    const prompt = list[Math.floor(Math.random() * list.length)];

    // Advance to next player after showing the prompt
    const previousPlayer = g.currentPlayer;
    g.currentIndex = (g.currentIndex + 1) % g.players.length;
    g.currentPlayer = g.players[g.currentIndex];
    g.round++;

    const playerList = g.players.map((id, i) => `${i === g.currentIndex ? '▶️' : '⬜'} <@${id}>`).join('\n');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('tod:truth').setLabel('🤔 Truth').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('tod:dare').setLabel('🎯 Dare').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('tod:skip').setLabel('⏭️ Skip Turn').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('tod:stop').setLabel('🛑 Stop Game').setStyle(ButtonStyle.Secondary),
    );

    return interaction.update({ embeds: [
      new EmbedBuilder()
        .setColor(choice === 'truth' ? '#3498DB' : '#E74C3C')
        .setTitle(`${choice === 'truth' ? '🤔 TRUTH' : '🎯 DARE'} — <@${previousPlayer}>`)
        .setDescription(
          `**${prompt}**\n\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `⬆️ Complete the ${choice} above, then...\n\n` +
          `**Players:**\n${playerList}\n\n` +
          `<@${g.currentPlayer}> it's your turn next!\n**Pick Truth or Dare 👇**`
        )
        .setFooter({ text: `Round ${g.round} • ${g.players.length} player(s) • Use !stopgame to end` })
        .setTimestamp()
    ], components: [row] });
  }

  // Team Trivia buttons
  if (interaction.isButton() && interaction.customId.startsWith('tt:')) {
    const parts = interaction.customId.split(':');
    const action = parts[1];
    const cid = interaction.channel.id;
    const uid = interaction.user.id;

    // Join team
    if (action === 'join') {
      const teamId = parts[2];
      const g = teamTriviaGames[cid];
      if (!g || g.phase !== 'lobby') return interaction.reply({ content: '❌ No Team Trivia lobby open here.', ephemeral: true });
      // Remove from any existing team
      for (const t of Object.values(g.teams)) { const idx = t.indexOf(uid); if (idx !== -1) t.splice(idx, 1); }
      g.teams[teamId].push(uid);
      return interaction.update({ embeds: [buildTTLobbyEmbed(g)], components: buildTTTeamRows(g) });
    }

    // Leave
    if (action === 'leave') {
      const g = teamTriviaGames[cid];
      if (!g || g.phase !== 'lobby') return interaction.reply({ content: '❌ No active lobby.', ephemeral: true });
      for (const t of Object.values(g.teams)) { const idx = t.indexOf(uid); if (idx !== -1) t.splice(idx, 1); }
      return interaction.update({ embeds: [buildTTLobbyEmbed(g)], components: buildTTTeamRows(g) });
    }

    // Answer
    if (action === 'ans') {
      const g = teamTriviaGames[cid];
      if (!g || g.phase !== 'question') return interaction.reply({ content: '❌ No question active.', ephemeral: true });
      const q = g.questions[g.qIdx];
      const chosen = parseInt(parts[2]);

      // Determine which team this player is on
      const activeTeamIds = ['red','blue','green','yellow'].slice(0,g.numTeams);
      const playerTeam = activeTeamIds.find(tid => (g.teams[tid]||[]).includes(uid));
      if (!playerTeam) return interaction.reply({ content: '❌ You are not in any team!', ephemeral: true });

      const isAnsweringTeam = playerTeam === g.currentTeam;
      const alreadyAnswered = g.answered.has(uid);
      if (alreadyAnswered) return interaction.reply({ content: '❌ You already answered this question!', ephemeral: true });

      // If a member of the answering team already locked in an answer, block others on same team
      if (isAnsweringTeam && g.teamAnswered.has(playerTeam)) return interaction.reply({ content: '❌ Your team already answered!', ephemeral: true });
      // Other teams can steal only after the main team answered wrong
      if (!isAnsweringTeam && !g.mainTeamAnsweredWrong) return interaction.reply({ content: `❌ Wait! It's ${TT_TEAMS.find(t=>t.id===g.currentTeam)?.emoji} **${TT_TEAMS.find(t=>t.id===g.currentTeam)?.label}**'s turn to answer first!`, ephemeral: true });
      if (!isAnsweringTeam && g.teamAnswered.has(playerTeam)) return interaction.reply({ content: '❌ Your team already tried to steal!', ephemeral: true });

      g.answered.add(uid);
      g.teamAnswered.add(playerTeam);
      const correct = chosen === q.a;

      if (correct) {
        const pts = isAnsweringTeam ? 2 : 1; // steal = 1 pt
        g.scores[playerTeam] = (g.scores[playerTeam] || 0) + pts;
        g.playerCorrect = g.playerCorrect || {};
        g.playerCorrect[uid] = (g.playerCorrect[uid] || 0) + 1;
        g.phase = 'intermission';

        const teamInfo = TT_TEAMS.find(t=>t.id===playerTeam);
        const correctOpt = q.c[q.a];
        const resultEmbed = new EmbedBuilder()
          .setColor(teamInfo.color)
          .setTitle(`🏆 Team Trivia — ${isAnsweringTeam ? '✅ Correct!' : '⚡ Steal!'}`)
          .setDescription(
            `${teamInfo.emoji} **${teamInfo.label}** answered correctly!\n` +
            (isAnsweringTeam ? '' : `🔥 **STEAL!** +1 point\n`) +
            `<@${uid}> got it right!\n\n` +
            `✅ **Answer:** ${correctOpt}\n\n` +
            `**+${pts} point${pts>1?'s':''} for ${teamInfo.label}!** ${teamInfo.emoji}\n\n` +
            `📊 Scores: ${['red','blue','green','yellow'].slice(0,g.numTeams).map(tid=>{ const ti=TT_TEAMS.find(t=>t.id===tid); return `${ti.emoji} ${g.scores[tid]||0}`; }).join(' | ')}\n\n` +
            `*Next question in 4 seconds...*`
          ).setTimestamp();

        await interaction.update({ embeds: [resultEmbed], components: buildTTAnswerRows(g, true) });

        // Advance
        setTimeout(async () => {
          if (!teamTriviaGames[cid]) return;
          g.qIdx++;
          if (g.qIdx >= g.totalQ) {
            g.phase = 'finished';
            delete teamTriviaGames[cid];
            return interaction.channel.send({ embeds: [buildTTFinalEmbed(g)] }).catch(()=>{});
          }
          // Next team's turn (rotate)
          const teamOrder = ['red','blue','green','yellow'].slice(0,g.numTeams);
          g.currentTeam = teamOrder[(teamOrder.indexOf(g.currentTeam) + 1) % teamOrder.length];
          g.answered = new Set();
          g.teamAnswered = new Set();
          g.mainTeamAnsweredWrong = false;
          g.phase = 'question';
          interaction.channel.send({ embeds: [buildTTQuestionEmbed(g)], components: buildTTAnswerRows(g, false) }).catch(()=>{});
        }, 4000);
        return;
      }

      // Wrong answer
      if (isAnsweringTeam) {
        g.mainTeamAnsweredWrong = true;
        const teamInfo = TT_TEAMS.find(t=>t.id===playerTeam);
        const wrongEmbed = new EmbedBuilder()
          .setColor('#ED4245')
          .setTitle('❌ Wrong!')
          .setDescription(
            `${teamInfo.emoji} **${teamInfo.label}** answered wrong!\n<@${uid}> chose: **${q.c[chosen]}**\n\n` +
            `⚡ **Other teams can now steal by clicking the correct answer!**\n\n` +
            `📊 Scores: ${['red','blue','green','yellow'].slice(0,g.numTeams).map(tid=>{ const ti=TT_TEAMS.find(t=>t.id===tid); return `${ti.emoji} ${g.scores[tid]||0}`; }).join(' | ')}`
          ).setTimestamp();
        return interaction.update({ embeds: [wrongEmbed], components: buildTTAnswerRows(g, false) });
      }

      // Wrong steal attempt
      const teamInfo = TT_TEAMS.find(t=>t.id===playerTeam);
      return interaction.reply({ content: `❌ ${teamInfo.emoji} **${teamInfo.label}** tried to steal — wrong answer! (**${q.c[chosen]}**)`, ephemeral: false });
    }
    return;
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
    if (!game) return interaction.reply({content:'❌ No active Connect 4 game here.',ephemeral:true});
    if (interaction.user.id !== game.currentPlayer) return interaction.reply({content:`❌ Not your turn! It's <@${game.currentPlayer}>'s turn.`,ephemeral:true});
    const col = parseInt(interaction.customId.split(':')[1]);
    if (isC4ColFull(game.board, col)) return interaction.reply({content:'❌ That column is full! Pick another.',ephemeral:true});
    dropC4(game.board, col, game.symbol);
    game.lastCol = col;
    game.moves = (game.moves || 0) + 1;
    const win  = checkC4(game.board);
    const full = game.board[0].every(c=>c!==null);
    if (win) {
      const winnerSym = game.symbol;
      delete c4Games[interaction.channel.id];
      return interaction.update({embeds:[buildC4Embed(game,`🎉 **<@${interaction.user.id}> wins!** ${winnerSym} connects 4! (${game.moves} moves)`)],components:buildC4Rows(true,game.board)});
    }
    if (full) {
      delete c4Games[interaction.channel.id];
      return interaction.update({embeds:[buildC4Embed(game,`🤝 **Draw!** The board is full after ${game.moves} moves!`)],components:buildC4Rows(true,game.board)});
    }
    game.currentPlayer = game.currentPlayer===game.player1?game.player2:game.player1;
    game.symbol = game.symbol==='🔴'?'🟡':'🔴';
    return interaction.update({embeds:[buildC4Embed(game,`<@${game.currentPlayer}>'s turn (${game.symbol})`)],components:buildC4Rows(false,game.board)});
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

  // ── TEXAS HOLD'EM POKER ────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('poker:')) {
    const act = interaction.customId.split(':')[1];
    const g = pokerGames[interaction.channel.id];
    if (!g) return interaction.reply({content:'❌ No poker game here.',ephemeral:true});
    const uid = interaction.user.id;
    const pIdx = g.players.findIndex(p=>p.id===uid);
    if (pIdx === -1) return interaction.reply({content:'❌ You are not in this game.',ephemeral:true});
    if (g.currentTurn !== uid) return interaction.reply({content:'❌ Not your turn!',ephemeral:true});

    // Defer immediately so Discord doesn't time out while we await DM sends
    await interaction.deferUpdate();

    const p = g.players[pIdx];
    const opp = g.players[1-pIdx];
    const toCall = Math.max(0, opp.bet - p.bet);

    if (act === 'fold') {
      g.pot = (g.pot||0) + p.bet + opp.bet;
      const winAmt = g.pot;
      opp.chips += winAmt;
      g.pot = 0; p.bet = 0; opp.bet = 0;
      g.round++;
      if (g.round > 10 || p.chips <= 0 || opp.chips <= 0) {
        const winner = opp.chips >= p.chips ? opp : p;
        delete pokerGames[interaction.channel.id];
        return interaction.editReply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🃏 Poker — Game Over!')
          .setDescription(`<@${p.id}> folded.\n\n🏆 **<@${winner.id}> WINS THE MATCH!**\n<@${opp.id}>: **${opp.chips}** chips\n<@${p.id}>: **${p.chips}** chips`)
          .setTimestamp()],components:[]});
      }
      // Start new round
      g.deck = makePokerDeck();
      p.hand = [g.deck.pop(), g.deck.pop()]; opp.hand = [g.deck.pop(), g.deck.pop()];
      p.folded = false; opp.folded = false; p.allIn = false; opp.allIn = false;
      p.bet = 10; opp.bet = 20; // blinds
      if (p.chips < 10) { p.bet = p.chips; p.chips = 0; p.allIn = true; }
      else p.chips -= 10;
      if (opp.chips < 20) { opp.bet = opp.chips; opp.chips = 0; opp.allIn = true; }
      else opp.chips -= 20;
      g.communityCards = []; g.currentTurn = p.id;
      const handMsg = `✅ <@${p.id}> folded! <@${opp.id}> wins **${winAmt}** chips!\n\n**New Round ${g.round}/10** | Your hole cards (check DMs!)`;
      try { await interaction.user.send(`🃏 **Your hole cards (Round ${g.round}):** ${pokerHandStr(p.hand)}`); } catch{}
      try { await interaction.guild.members.fetch(opp.id).then(m=>m.user.send(`🃏 **Your hole cards (Round ${g.round}):** ${pokerHandStr(opp.hand)}`)).catch(()=>{}); } catch{}
      return interaction.editReply({embeds:[buildPokerEmbed(g).setDescription(`${handMsg}`)],components:buildPokerActionRows(false)});
    }

    if (act === 'call') {
      if (toCall === 0) {
        // Check — advance stage
        // Deal community cards
        if (g.communityCards.length === 0) { g.communityCards = [g.deck.pop(),g.deck.pop(),g.deck.pop()]; }
        else if (g.communityCards.length === 3) { g.communityCards.push(g.deck.pop()); }
        else if (g.communityCards.length === 4) { g.communityCards.push(g.deck.pop()); }
        else {
          // Showdown
          const p1hand = evaluatePokerHand([...g.players[0].hand, ...g.communityCards]);
          const p2hand = evaluatePokerHand([...g.players[1].hand, ...g.communityCards]);
          const pot = (g.pot||0) + g.players[0].bet + g.players[1].bet;
          let resultDesc = '';
          let winnerP;
          if (p1hand.rank > p2hand.rank || (p1hand.rank===p2hand.rank && p1hand.tiebreak > p2hand.tiebreak)) {
            g.players[0].chips += pot; winnerP = g.players[0];
            resultDesc = `🏆 **<@${g.players[0].id}> wins ${pot} chips!**\n${p1hand.name} beats ${p2hand.name}`;
          } else if (p2hand.rank > p1hand.rank || p2hand.tiebreak > p1hand.tiebreak) {
            g.players[1].chips += pot; winnerP = g.players[1];
            resultDesc = `🏆 **<@${g.players[1].id}> wins ${pot} chips!**\n${p2hand.name} beats ${p1hand.name}`;
          } else {
            g.players[0].chips += Math.floor(pot/2); g.players[1].chips += Math.floor(pot/2);
            resultDesc = `🤝 **Split pot! ${Math.floor(pot/2)} chips each.**`;
          }
          g.round++; g.pot = 0; g.players[0].bet = 0; g.players[1].bet = 0;
          if (g.round > 10 || g.players[0].chips <= 0 || g.players[1].chips <= 0) {
            const finalW = g.players[0].chips >= g.players[1].chips ? g.players[0] : g.players[1];
            delete pokerGames[interaction.channel.id];
            return interaction.editReply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🃏 Poker — Showdown!')
              .setDescription(`**Community:** ${pokerHandStr(g.communityCards)}\n**<@${g.players[0].id}>:** ${pokerHandStr(g.players[0].hand)} → ${p1hand.name}\n**<@${g.players[1].id}>:** ${pokerHandStr(g.players[1].hand)} → ${p2hand.name}\n\n${resultDesc}\n\n🏆 **<@${finalW.id}> WINS THE MATCH!**`)
              .setTimestamp()],components:[]});
          }
          // New round
          g.deck = makePokerDeck();
          g.players[0].hand=[g.deck.pop(),g.deck.pop()]; g.players[1].hand=[g.deck.pop(),g.deck.pop()];
          g.players[0].folded=false; g.players[1].folded=false;
          g.players[0].allIn=false; g.players[1].allIn=false;
          g.communityCards=[]; g.currentTurn=g.players[0].id;
          g.players[0].bet=10; g.players[1].bet=20;
          g.players[0].chips=Math.max(0,g.players[0].chips-10); g.players[1].chips=Math.max(0,g.players[1].chips-20);
          if(g.players[0].chips===0) g.players[0].allIn=true;
          if(g.players[1].chips===0) g.players[1].allIn=true;
          try{await interaction.user.send(`🃏 **Hole cards R${g.round}:** ${pokerHandStr(g.players[0].hand)}`);}catch{}
          try{await interaction.guild.members.fetch(g.players[1].id).then(m=>m.user.send(`🃏 **Hole cards R${g.round}:** ${pokerHandStr(g.players[1].hand)}`)).catch(()=>{});}catch{}
          return interaction.editReply({embeds:[new EmbedBuilder().setColor('#1A472A').setTitle(`🃏 Poker — Round ${g.round}/10`)
            .setDescription(`**Showdown Results:**\n${resultDesc}\n\n**New Round — Community cards:** *Pre-flop*\n<@${g.players[0].id}>: **${g.players[0].chips}** chips | <@${g.players[1].id}>: **${g.players[1].chips}** chips`)
            .setTimestamp()],components:buildPokerActionRows(false)});
        }
        g.currentTurn = opp.id;
        return interaction.editReply({embeds:[buildPokerEmbed(g)],components:buildPokerActionRows(false)});
      }
      // Call
      const callAmt = Math.min(toCall, p.chips);
      p.chips -= callAmt; p.bet += callAmt;
      if (p.chips === 0) p.allIn = true;
      // After call, advance to next street
      if (g.communityCards.length === 0) g.communityCards = [g.deck.pop(),g.deck.pop(),g.deck.pop()];
      else if (g.communityCards.length < 5) g.communityCards.push(g.deck.pop());
      // If all 5 community cards are now out, go straight to showdown
      if (g.communityCards.length === 5) {
        const p1hand = evaluatePokerHand([...g.players[0].hand, ...g.communityCards]);
        const p2hand = evaluatePokerHand([...g.players[1].hand, ...g.communityCards]);
        const pot = (g.pot||0) + g.players[0].bet + g.players[1].bet;
        let resultDesc = '';
        if (p1hand.rank > p2hand.rank || (p1hand.rank===p2hand.rank && p1hand.tiebreak > p2hand.tiebreak)) {
          g.players[0].chips += pot;
          resultDesc = `🏆 **<@${g.players[0].id}> wins ${pot} chips!**\n${p1hand.name} beats ${p2hand.name}`;
        } else if (p2hand.rank > p1hand.rank || (p2hand.rank===p1hand.rank && p2hand.tiebreak > p1hand.tiebreak)) {
          g.players[1].chips += pot;
          resultDesc = `🏆 **<@${g.players[1].id}> wins ${pot} chips!**\n${p2hand.name} beats ${p1hand.name}`;
        } else {
          g.players[0].chips += Math.floor(pot/2); g.players[1].chips += Math.floor(pot/2);
          resultDesc = `🤝 **Split pot! ${Math.floor(pot/2)} chips each.**`;
        }
        g.round++; g.pot = 0; g.players[0].bet = 0; g.players[1].bet = 0;
        if (g.round > 10 || g.players[0].chips <= 0 || g.players[1].chips <= 0) {
          const finalW = g.players[0].chips >= g.players[1].chips ? g.players[0] : g.players[1];
          delete pokerGames[interaction.channel.id];
          return interaction.editReply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('🃏 Poker — Showdown!')
            .setDescription(`**Community:** ${pokerHandStr(g.communityCards)}\n**<@${g.players[0].id}>:** ${pokerHandStr(g.players[0].hand)} → ${p1hand.name}\n**<@${g.players[1].id}>:** ${pokerHandStr(g.players[1].hand)} → ${p2hand.name}\n\n${resultDesc}\n\n🏆 **<@${finalW.id}> WINS THE MATCH!**`)
            .setTimestamp()],components:[]});
        }
        g.deck = makePokerDeck();
        g.players[0].hand=[g.deck.pop(),g.deck.pop()]; g.players[1].hand=[g.deck.pop(),g.deck.pop()];
        g.players[0].folded=false; g.players[1].folded=false;
        g.players[0].allIn=false; g.players[1].allIn=false;
        g.communityCards=[]; g.currentTurn=g.players[0].id;
        g.players[0].bet=10; g.players[1].bet=20;
        g.players[0].chips=Math.max(0,g.players[0].chips-10); g.players[1].chips=Math.max(0,g.players[1].chips-20);
        if(g.players[0].chips===0) g.players[0].allIn=true;
        if(g.players[1].chips===0) g.players[1].allIn=true;
        try{await interaction.user.send(`🃏 **Hole cards R${g.round}:** ${pokerHandStr(g.players[0].hand)}`);}catch{}
        try{await interaction.guild.members.fetch(g.players[1].id).then(m=>m.user.send(`🃏 **Hole cards R${g.round}:** ${pokerHandStr(g.players[1].hand)}`)).catch(()=>{});}catch{}
        return interaction.editReply({embeds:[new EmbedBuilder().setColor('#1A472A').setTitle(`🃏 Poker — Round ${g.round}/10`)
          .setDescription(`**Showdown Results:**\n${resultDesc}\n\n**New Round — Community cards:** *Pre-flop*\n<@${g.players[0].id}>: **${g.players[0].chips}** chips | <@${g.players[1].id}>: **${g.players[1].chips}** chips`)
          .setTimestamp()],components:buildPokerActionRows(false)});
      }
      g.currentTurn = opp.id;
      return interaction.editReply({embeds:[buildPokerEmbed(g)],components:buildPokerActionRows(false)});
    }

    if (act === 'raise') {
      const raiseAmt = Math.min(20 + toCall, p.chips);
      p.chips -= raiseAmt; p.bet += raiseAmt;
      if (p.chips === 0) p.allIn = true;
      g.currentTurn = opp.id;
      return interaction.editReply({embeds:[buildPokerEmbed(g)],components:buildPokerActionRows(false)});
    }

    if (act === 'allin') {
      p.bet += p.chips; p.chips = 0; p.allIn = true;
      g.currentTurn = opp.id;
      return interaction.editReply({embeds:[buildPokerEmbed(g)],components:buildPokerActionRows(false)});
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

// ─── Bot Mention / DM Handler — show invite & info ───────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // ── Handle DMs: show invite + bot info ──────────────────────────────────────
  if (!message.guild) {
    const inviteURL = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
    const up = process.uptime(), h = Math.floor(up/3600), m = Math.floor((up%3600)/60), s = Math.floor(up%60);
    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🤖 Hey! I'm ${client.user.username}`)
        .setThumbnail(client.user.displayAvatarURL({ forceStatic: false, size: 256 }))
        .setDescription(
          `Thanks for messaging me!\n\nI'm a **multipurpose Discord bot** with moderation, fun games, welcome system, tickets, and much more!\n\n` +
          `**[🔗 Invite Me to Your Server](${inviteURL})**`
        )
        .addFields(
          { name: '🏠 Servers',     value: `${client.guilds.cache.size}`,                     inline: true },
          { name: '👥 Users',       value: `${client.users.cache.size}`,                      inline: true },
          { name: '🏓 Ping',        value: `${client.ws.ping}ms`,                             inline: true },
          { name: '⏱️ Uptime',      value: `${h}h ${m}m ${s}s`,                              inline: true },
          { name: '📦 discord.js',  value: require('discord.js').version,                     inline: true },
          { name: '🟢 Node.js',     value: process.version,                                   inline: true },
          { name: '🛡️ Moderation',  value: 'kick, ban, mute, warn, purge & more',             inline: false },
          { name: '🎮 Games',       value: 'TTT, Poker, Hangman, Wordle, Truth or Dare & more', inline: false },
          { name: '🎉 Welcome',     value: 'Customizable welcome messages & embeds',           inline: false },
          { name: '🎫 Tickets',     value: 'Full ticket system with wizard setup',             inline: false },
          { name: '😂 Fun',         value: 'meme, joke, 8ball, ship, fight & more',           inline: false },
          { name: '🔧 Prefix',      value: `\`${PREFIX}help\` in any server`,                 inline: false },
        )
        .setFooter({ text: `${client.user.username} • Use ${PREFIX}help in a server to see all commands!` })
        .setTimestamp()
    ] });
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (isDuplicate(message.id)) return;

  // ── Handle @mention of the bot (in server) — show invite + info ─────────────
  const isMention = message.mentions.has(client.user) &&
    (message.content.trim() === `<@${client.user.id}>` ||
     message.content.trim() === `<@!${client.user.id}>` ||
     message.content.trim().startsWith(`<@${client.user.id}>`) ||
     message.content.trim().startsWith(`<@!${client.user.id}>`)) &&
    !message.content.includes(PREFIX);

  if (isMention) {
    const inviteURL = `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`;
    const up = process.uptime(), h = Math.floor(up/3600), m = Math.floor((up%3600)/60), s = Math.floor(up%60);
    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`🤖 ${client.user.username} — Bot Info`)
        .setThumbnail(client.user.displayAvatarURL({ forceStatic: false, size: 256 }))
        .setDescription(
          `Hey ${message.author}! 👋\n\nI'm a **multipurpose Discord bot** packed with moderation, games, welcome system, tickets, and much more!\n\n` +
          `**[🔗 Invite Me to Another Server](${inviteURL})**`
        )
        .addFields(
          { name: '🏠 Servers',      value: `${client.guilds.cache.size}`,      inline: true },
          { name: '👥 Users',        value: `${client.users.cache.size}`,       inline: true },
          { name: '🏓 Ping',         value: `${client.ws.ping}ms`,              inline: true },
          { name: '⏱️ Uptime',       value: `${h}h ${m}m ${s}s`,               inline: true },
          { name: '📦 discord.js',   value: require('discord.js').version,      inline: true },
          { name: '🟢 Node.js',      value: process.version,                    inline: true },
          { name: '🛡️ Moderation',   value: 'kick, ban, mute, warn, purge & more',              inline: false },
          { name: '🎮 Games',        value: 'TTT, Poker, Hangman, Wordle, Truth or Dare & more', inline: false },
          { name: '🎉 Welcome',      value: 'Customizable welcome messages & embeds',            inline: false },
          { name: '🎫 Tickets',      value: 'Full ticket system with wizard setup',              inline: false },
          { name: '😂 Fun',          value: 'meme, joke, 8ball, ship, fight & more',            inline: false },
          { name: '🔧 Prefix',       value: `\`${PREFIX}help\` — see all commands`,             inline: false },
        )
        .setFooter({ text: `${client.user.username} • Type ${PREFIX}help to see all commands!` })
        .setTimestamp()
    ] });
  }

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

  // Hangman guess — any player in channel can guess
  const hmGame = hangmanGames[message.channel.id];
  if (hmGame && !message.content.startsWith(PREFIX)) {
    const g = message.content.trim().toLowerCase();
    if (g.length===1 && /[a-z]/.test(g)) {
      if (hmGame.guessed.includes(g)) return message.reply(`❌ **${g.toUpperCase()}** was already guessed!`);
      hmGame.guessed.push(g);
      const correct = hmGame.word.includes(g);
      if (!correct) hmGame.wrong++;
      if (!hmGame.scores) hmGame.scores = {};
      if (correct) hmGame.scores[message.author.id] = (hmGame.scores[message.author.id]||0) + 1;
      const disp = hmGame.word.split('').map(l=>hmGame.guessed.includes(l)?l:'_').join(' ');
      const won=!disp.includes('_'), lost=hmGame.wrong>=5;
      if (won||lost) {
        const scoreboard = Object.entries(hmGame.scores||{}).sort(([,a],[,b])=>b-a).map(([id,s],i)=>`${['🥇','🥈','🥉'][i]||'🏅'} <@${id}>: **${s}** correct letter(s)`).join('\n');
        delete hangmanGames[message.channel.id];
        return message.reply({embeds:[new EmbedBuilder().setColor(won?'#57F287':'#ED4245')
          .setTitle(`🪓 Hangman${won?' — Solved! 🎉':' — Game Over! 💀'}`)
          .setDescription(`${HM_STAGES[hmGame.wrong]}\n**Word:** \`${hmGame.word.split('').join(' ')}\`\n\n${won?`✅ <@${message.author.id}> solved it!`:`💀 Nobody solved it in time!`}\n\n**Scoreboard:**\n${scoreboard||'No correct guesses.'}`)
          .setTimestamp()]});
      }
      return message.reply({embeds:[new EmbedBuilder().setColor(correct?'#57F287':'#ED4245')
        .setTitle(`🪓 Hangman — ${correct?`✅ ${g.toUpperCase()} is in the word!`:`❌ ${g.toUpperCase()} is wrong!`}`)
        .setDescription(`${HM_STAGES[hmGame.wrong]}\n**Word:** \`${disp}\`\nGuessed: ${hmGame.guessed.map(x=>hmGame.word.includes(x)?`✅${x}`:`❌${x}`).join(' ')} (${hmGame.wrong}/5 wrong)\n\n*Anyone can guess! Type a letter.*`)
        .setFooter({text:`Started by the channel • ${hmGame.word.length} letters`}).setTimestamp()]});
    }
  }

  // Trivia answer — any player can answer
  const tvGame = triviaGames[message.channel.id];
  if (tvGame && !message.content.startsWith(PREFIX)) {
    const g=message.content.trim().toLowerCase(), correct=tvGame.q.a;
    const ok=g===correct||g===tvGame.q.c.find(c=>c.toLowerCase()===correct)?.toLowerCase();
    if (!ok) return; // Ignore wrong guesses silently to allow more guesses
    delete triviaGames[message.channel.id];
    return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('✅ Correct!')
      .setDescription(`🎉 <@${message.author.id}> got it!\n\n**Answer:** ${tvGame.q.c.find(c=>c.toLowerCase()===correct)}`).setTimestamp()]});
  }

  // Number guess — any player can guess
  const ngGame = guessGames[message.channel.id];
  if (ngGame && !message.content.startsWith(PREFIX)) {
    const n=parseInt(message.content.trim()); if(isNaN(n)) return;
    ngGame.attempts++;
    if (n===ngGame.number) { 
      delete guessGames[message.channel.id]; 
      return message.reply({embeds:[successEmbed('🎯 Correct!',`<@${message.author.id}> found it! The number was **${ngGame.number}**! Got it in **${ngGame.attempts}** attempt(s)!`)]}); 
    }
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

  // Word Chain answer — English letters only, 3+ letters, 15s timer
  const wcGame = wordChainGames[message.channel.id];
  if (wcGame && message.author.id===wcGame.currentTurn && !message.content.startsWith(PREFIX)) {
    const word = message.content.trim().toLowerCase();
    if (!/^[a-z]+$/.test(word)) return;
    clearTimeout(wcGame.timer);

    // Validation — strict English dictionary required
    if (word.length < 3) {
      const warningMsg = await message.reply(`❌ **"${word}"** is too short! Min **3 letters** required.\n⏱️ You still have time — try again!`);
      // Restart timer for same player
      wcGame.timer = setTimeout(async () => {
        const loser = wcGame.currentTurn;
        if (loser === wcGame.p1) wcGame.lives1--; else wcGame.lives2--;
        warningMsg.delete().catch(() => {});
        if (wcGame.lives1 <= 0 || wcGame.lives2 <= 0) {
          const winner = wcGame.lives1 > 0 ? wcGame.p1 : wcGame.p2;
          delete wordChainGames[message.channel.id];
          return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Game Over!').setDescription(`💀 <@${loser}> ran out of time!\n🏆 <@${winner}> **WINS!**\n\n**Chain:** ${wcGame.chain.join(' → ')}\n**Total words:** ${wcGame.chain.length}`).setTimestamp()]});
        }
        wcGame.currentTurn = wcGame.currentTurn === wcGame.p1 ? wcGame.p2 : wcGame.p1;
        message.channel.send({embeds:[buildWordChainEmbed(wcGame)]});
      }, wcGame.timeLimit * 1000);
      return;
    }
    if (word[0] !== wcGame.lastLetter) {
      const warningMsg = await message.reply(`❌ **"${word}"** must start with **${wcGame.lastLetter.toUpperCase()}**! Try again!`);
      wcGame.timer = setTimeout(async () => {
        const loser = wcGame.currentTurn;
        if (loser === wcGame.p1) wcGame.lives1--; else wcGame.lives2--;
        warningMsg.delete().catch(() => {});
        if (wcGame.lives1 <= 0 || wcGame.lives2 <= 0) {
          const winner = wcGame.lives1 > 0 ? wcGame.p1 : wcGame.p2;
          delete wordChainGames[message.channel.id];
          return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Game Over!').setDescription(`💀 <@${loser}> timed out!\n🏆 <@${winner}> **WINS!**\n\n**Chain:** ${wcGame.chain.join(' → ')}`).setTimestamp()]});
        }
        wcGame.currentTurn = wcGame.currentTurn === wcGame.p1 ? wcGame.p2 : wcGame.p1;
        message.channel.send({embeds:[buildWordChainEmbed(wcGame)]});
      }, wcGame.timeLimit * 1000);
      return;
    }
    if (wcGame.used.has(word)) {
      const warningMsg = await message.reply(`❌ **"${word}"** was already used! Think of a new word!`);
      wcGame.timer = setTimeout(async () => {
        const loser = wcGame.currentTurn;
        if (loser === wcGame.p1) wcGame.lives1--; else wcGame.lives2--;
        warningMsg.delete().catch(() => {});
        if (wcGame.lives1 <= 0 || wcGame.lives2 <= 0) {
          const winner = wcGame.lives1 > 0 ? wcGame.p1 : wcGame.p2;
          delete wordChainGames[message.channel.id];
          return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Game Over!').setDescription(`💀 <@${loser}> timed out!\n🏆 <@${winner}> **WINS!**`).setTimestamp()]});
        }
        wcGame.currentTurn = wcGame.currentTurn === wcGame.p1 ? wcGame.p2 : wcGame.p1;
        message.channel.send({embeds:[buildWordChainEmbed(wcGame)]});
      }, wcGame.timeLimit * 1000);
      return;
    }
    if (!isValidEnglishWord(word)) {
      const warningMsg = await message.reply(`❌ **"${word}"** contains non-English characters! Only English alphabet letters (a-z) are allowed.\n⏱️ You still have time — try again!`);
      wcGame.timer = setTimeout(async () => {
        const loser = wcGame.currentTurn;
        if (loser === wcGame.p1) wcGame.lives1--; else wcGame.lives2--;
        warningMsg.delete().catch(() => {});
        if (wcGame.lives1 <= 0 || wcGame.lives2 <= 0) {
          const winner = wcGame.lives1 > 0 ? wcGame.p1 : wcGame.p2;
          delete wordChainGames[message.channel.id];
          return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Game Over!').setDescription(`💀 <@${loser}> timed out!\n🏆 <@${winner}> **WINS!**`).setTimestamp()]});
        }
        wcGame.currentTurn = wcGame.currentTurn === wcGame.p1 ? wcGame.p2 : wcGame.p1;
        message.channel.send({embeds:[buildWordChainEmbed(wcGame)]});
      }, wcGame.timeLimit * 1000);
      return;
    }

    // ✅ Valid word accepted!
    wcGame.used.add(word);
    wcGame.chain.push(word);
    wcGame.lastLetter = word[word.length - 1];
    if (wcGame.currentTurn === wcGame.p1) wcGame.words1++; else wcGame.words2++;
    wcGame.currentTurn = wcGame.currentTurn === wcGame.p1 ? wcGame.p2 : wcGame.p1;
    // Reduce time limit as chain grows (gets harder!)
    wcGame.timeLimit = Math.max(8, 15 - Math.floor(wcGame.chain.length / 4));

    // Set timeout for next player
    wcGame.timer = setTimeout(async () => {
      const loser = wcGame.currentTurn;
      if (loser === wcGame.p1) wcGame.lives1--; else wcGame.lives2--;
      if (wcGame.lives1 <= 0 || wcGame.lives2 <= 0) {
        const winner = wcGame.lives1 > 0 ? wcGame.p1 : wcGame.p2;
        delete wordChainGames[message.channel.id];
        return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Game Over!').setDescription(`⏱️ <@${loser}> ran out of time!\n\n🏆 <@${winner}> **WINS!**\n\n**Chain (${wcGame.chain.length} words):** ${wcGame.chain.join(' → ')}`).setTimestamp()]});
      }
      wcGame.currentTurn = wcGame.currentTurn === wcGame.p1 ? wcGame.p2 : wcGame.p1;
      message.channel.send({embeds:[buildWordChainEmbed(wcGame)]});
    }, wcGame.timeLimit * 1000);

    return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🔗 Word Chain — ✅ Accepted!')
      .setDescription(`✅ **"${word}"** accepted! _(ends in **${wcGame.lastLetter.toUpperCase()}**)_\n\n${buildWordChainEmbed(wcGame).data.description}`)
      .setFooter({text:`Chain length: ${wcGame.chain.length} • Time: ${wcGame.timeLimit}s (gets shorter!)`}).setTimestamp()]});
  }

  // Battleship coordinate input
  const bsGame = battleshipGames[message.channel.id];
  if (bsGame && message.author.id===bsGame.currentTurn && !message.content.startsWith(PREFIX)) {
    const coord = parseBSCoord(message.content);
    if (coord) {
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
        .setDescription(`**${message.author.username}** fires at **${message.content.trim().toUpperCase()}** — ${hit?'💥 HIT!':'〰️ Miss!'}${sunkMsg}\n\n${renderBSGrid(targetBoard,shots)}\n\n<@${bsGame.currentTurn}>'s turn! Type a coordinate (e.g. \`A1\`, \`H8\`, \`O15\`)`)
        .setTimestamp()]});
    }
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
      const prevWord = scGame.word;
      const next=SCRAMBLE_WORDS[Math.floor(Math.random()*SCRAMBLE_WORDS.length)];
      scGame.word=next.word; scGame.hint=next.hint; scGame.scrambled=scrambleWord(next.word);
      return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('🔀 Scramble — Correct! ✅')
        .setDescription(`✅ <@${uid}> got it! The word was **${prevWord.toLowerCase()}**!\n\n**Round ${scGame.round}/${scGame.maxRounds}:**\nUnscramble: \`${scGame.scrambled}\`\n💡 Hint: ${scGame.hint}\n\n*Type your answer in chat!*`)
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

  // Wordle guess — any player can guess
  const wlGame = wordleGames[message.channel.id];
  if (wlGame && !message.content.startsWith(PREFIX)) {
    const g=message.content.trim().toLowerCase();
    if (g.length!==5||!/^[a-z]+$/.test(g)) return;
    if (!WORDLE_VALID_WORDS.has(g)) return message.reply(`❌ **"${g.toUpperCase()}"** is not a valid English word! Try another word.`);
    const result=evaluateWordle(g,wlGame.word);
    wlGame.guesses.push({g,result,uid:message.author.id});
    const won=g===wlGame.word, lost=wlGame.guesses.length>=6&&!won;
    if (won||lost) delete wordleGames[message.channel.id];
    const board=wlGame.guesses.map(x=>`${x.result.map(r=>r.e).join('')} \`${x.g}\` — <@${x.uid}>`).join('\n');
    return message.reply({embeds:[new EmbedBuilder().setColor(won?'#538D4E':lost?'#ED4245':'#5865F2')
      .setTitle(`🟩 Wordle${won?` — <@${message.author.id}> Won! 🎉`:lost?` — Over! Word: **${wlGame.word}**`:` — Guess ${wlGame.guesses.length}/6`}`)
      .setDescription(board).setFooter({text:won||lost?'Game over! Use !wordle to start a new one':'Anyone can guess! Type a 5-letter word!'}).setTimestamp()]});
  }

  // Fast Type answer
  const ftGame = fastTypeGames[message.channel.id];
  if (ftGame && !message.content.startsWith(PREFIX) && !ftGame.winner) {
    const typed = message.content.trim();
    if (typed.toLowerCase() === ftGame.sentence.toLowerCase()) {
      ftGame.winner = message.author.id;
      const elapsed = ((Date.now() - ftGame.startTime) / 1000).toFixed(2);
      const wpm = Math.round((ftGame.sentence.split(' ').length / (elapsed / 60)));
      delete fastTypeGames[message.channel.id];
      return message.reply({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('⌨️ Fast Type — Winner! 🏆')
        .setDescription(`🎉 <@${message.author.id}> finished first!\n\n⏱️ **Time:** ${elapsed}s\n💨 **WPM:** ~${wpm} words/min\n\n**Sentence:** \`${ftGame.sentence}\``)
        .setTimestamp()]});
    }
  }

  // Quiz Showdown answer
  const qsGame = quizShowdownGames[message.channel.id];
  if (qsGame && !message.content.startsWith(PREFIX)) {
    const g = message.content.trim().toLowerCase();
    const q = qsGame.questions[qsGame.qNum];
    const letterMap = {a:0,b:1,c:2,d:3};
    const letterIdx = letterMap[g];
    const answerByLetter = letterIdx !== undefined ? q.c[letterIdx]?.toLowerCase() : null;
    const correct = q.a.toLowerCase();
    const isCorrect = g === correct || answerByLetter === correct;
    if (isCorrect) {
      qsGame.scores[message.author.id] = (qsGame.scores[message.author.id]||0) + 1;
      qsGame.qNum++;
      if (qsGame.timer) { clearTimeout(qsGame.timer); qsGame.timer = null; }
      if (qsGame.qNum >= qsGame.questions.length) {
        delete quizShowdownGames[message.channel.id];
        const sorted = Object.entries(qsGame.scores).sort(([,a],[,b])=>b-a);
        const winner = sorted[0];
        return message.reply({embeds:[buildScoreboard(qsGame.scores,'🏆 Quiz Showdown — Game Over!')
          .setDescription(`✅ <@${message.author.id}> got the last answer!\n\n${Object.entries(qsGame.scores).sort(([,a],[,b])=>b-a).map(([id,s],i)=>`${['🥇','🥈','🥉'][i]||'🏅'} <@${id}>: **${s}** pts`).join('\n')}\n\n🏆 **<@${winner[0]}> WINS!**`)]});
      }
      const next = qsGame.questions[qsGame.qNum];
      qsGame.timer = setTimeout(() => {
        if (!quizShowdownGames[message.channel.id]) return;
        qsGame.qNum++;
        if (qsGame.qNum >= qsGame.questions.length) {
          delete quizShowdownGames[message.channel.id];
          message.channel.send({embeds:[buildScoreboard(qsGame.scores,'🏆 Quiz Showdown — Finished!')]}).catch(()=>{});
          return;
        }
        message.channel.send({embeds:[buildQuizShowdownEmbed(qsGame)]}).catch(()=>{});
      }, 30000);
      return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('✅ Correct!')
        .setDescription(`🎉 <@${message.author.id}> got it! Answer: **${q.a}**\n\n**Round ${qsGame.qNum}/${qsGame.questions.length}:**\n${buildQuizShowdownEmbed(qsGame).data.description}`)
        .setTimestamp()]});
    }
  }

  // Word Bomb answer
  const wbGame = wordBombGames[message.channel.id];
  if (wbGame && !message.content.startsWith(PREFIX)) {
    const turnPlayer = wbGame.players[wbGame.turn % wbGame.players.length];
    if (message.author.id !== turnPlayer) return;
    const word = message.content.trim().toLowerCase();
    if (!/^[a-z]+$/.test(word)) return;
    clearTimeout(wbGame.timer);
    if (!word.includes(wbGame.prompt.toLowerCase())) {
      return message.reply(`❌ **"${word}"** doesn't contain **${wbGame.prompt}**! 💣 Try again!`);
    }
    if (wbGame.usedWords.has(word)) {
      return message.reply(`❌ **"${word}"** was already used! 💣 Try again!`);
    }
    wbGame.usedWords.add(word);
    wbGame.turn++;
    wbGame.round++;
    wbGame.prompt = WB_PROMPTS[Math.floor(Math.random()*WB_PROMPTS.length)];
    wbGame.timeLimit = Math.max(5, wbGame.timeLimit - (wbGame.round % 5 === 0 ? 1 : 0));
    const nextPlayer = wbGame.players[wbGame.turn % wbGame.players.length];
    wbGame.timer = setTimeout(async () => {
      const eliminated = wbGame.players[wbGame.turn % wbGame.players.length];
      wbGame.players = wbGame.players.filter(id => id !== eliminated);
      if (wbGame.players.length <= 1) {
        const winner = wbGame.players[0];
        delete wordBombGames[message.channel.id];
        return message.channel.send({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('💣 Word Bomb — WINNER! 🏆')
          .setDescription(`⏱️ <@${eliminated}> ran out of time!\n\n🏆 **<@${winner}> WINS! 💣**\n**Words played:** ${wbGame.round}`)
          .setTimestamp()]}).catch(()=>{});
      }
      wbGame.turn = wbGame.turn % wbGame.players.length;
      message.channel.send({embeds:[new EmbedBuilder().setColor('#FF4500').setTitle('💣 Word Bomb — ELIMINATED!')
        .setDescription(`⏱️ <@${eliminated}> timed out and is ELIMINATED! 💥\n\n${buildWordBombEmbed(wbGame).data.description}`)
        .setTimestamp()]}).catch(()=>{});
    }, wbGame.timeLimit * 1000);
    return message.reply({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('💣 Word Bomb — ✅ Valid!')
      .setDescription(`✅ **"${word}"** accepted!\n\n${buildWordBombEmbed(wbGame).data.description}`)
      .setTimestamp()]});
  }

  // Murder Mystery vote
  const mmGame = murderGames[message.channel.id];
  if (mmGame && mmGame.phase === 'voting' && !message.content.startsWith(PREFIX)) {
    const vote = message.content.trim().toLowerCase();
    const suspect = MM_SUSPECTS.find(s => vote.includes(s.toLowerCase().split(' ')[1]?.toLowerCase()||''));
    if (!suspect) return;
    if (!mmGame.votes) mmGame.votes = {};
    mmGame.votes[message.author.id] = suspect;
    return message.reply({embeds:[new EmbedBuilder().setColor('#8B0000').setTitle('🗳️ Vote Registered!')
      .setDescription(`<@${message.author.id}> voted for **${suspect}**!\n\nKeep voting! 60 seconds total.`)
      .setTimestamp()]});
  }

  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd  = args.shift().toLowerCase();

  switch (cmd) {

    // ── !help ───────────────────────────────────────────────────────────────
    case 'help': case 'h': {
      const helpEmbed1 = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('✦ Command Center')
        .setDescription(
          `> Prefix: \`${PREFIX}\` — All commands start with \`${PREFIX}\`\n` +
          `> Use \`${PREFIX}help\` anytime to see this menu.\n` +
          `\u200b`
        )
        .addFields(
          {
            name: '━━━━━━━━━━  🎮  GAMES  ━━━━━━━━━━',
            value: '\u200b',
          },
          {
            name: '🕹️  Solo Games',
            value:
              '`blackjack` `slots` `mines` `snake` `2048`\n' +
              '`memory` `hol` `dicepoker` `wordle` `hangman`\n' +
              '`trivia` `guess` `scramble` `emojidecode`',
            inline: false,
          },
          {
            name: '⚔️  Multiplayer Games',
            value:
              '`ttt @user` `connect4 @user` `rps @user` `battleship @user`\n' +
              '`mathduel @user` `wordchain @user` `triviabattle @user`\n' +
              '`poker @user` `wordbomb @u1 @u2…` `murdermystery @u1 @u2…`\n' +
              '`fasttype` `truthordare` `quizshowdown` `triviamarathon`\n' +
              '`teamtrivia [teams] [rounds]` `rps rock/paper/scissors` *(vs bot)*',
            inline: false,
          },
          {
            name: '🛑  Game Control',
            value: '`stopgame` — End all active games in this channel *(Mod only)*',
            inline: false,
          },
        )
        .setFooter({ text: `${client.user.username}  •  Page 1 of 2 — Server & Utility` });

      const helpEmbed2 = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('✦ Command Center')
        .setDescription(
          `> Prefix: \`${PREFIX}\` — All commands start with \`${PREFIX}\`\n` +
          `\u200b`
        )
        .addFields(
          {
            name: '━━━━━━  🛡️  SERVER & UTILITY  ━━━━━━',
            value: '\u200b',
          },
          {
            name: '🔨  Moderation',
            value:
              '`kick` `ban` `unban` `mute` `unmute`\n' +
              '`warn` `warnings` `clearwarnings`\n' +
              '`slowmode` `lock` `unlock` `purge` `purgeuser`',
            inline: true,
          },
          {
            name: '📊  Info & Stats',
            value:
              '`userinfo` `serverinfo` `botinfo`\n' +
              '`ping` `avatar` `roleinfo` `profile`',
            inline: true,
          },
          {
            name: '\u200b',
            value: '\u200b',
            inline: false,
          },
          {
            name: '😂  Fun',
            value:
              '`meme` `joke` `8ball` `ship` `fight`\n' +
              '`slap` `hug` `kiss` `pat` `coinflip`\n' +
              '`roll` `gay` `iq` `rizz` `aura` `simp` `drip` `sus`',
            inline: true,
          },
          {
            name: '🛠️  Utility & Server',
            value:
              '`say` `embed` `poll`\n' +
              '`dm` `dmall` `announce`\n' +
              '`ticket` `ticketset` `ticketreset`\n' +
              '`welcomeset` `welcometest`',
            inline: true,
          },
          {
            name: '\u200b',
            value: '\u200b',
            inline: false,
          },
          {
            name: '🎭  Status *(Owner only)*',
            value: '`addstatus` `removestatus` `liststatus` `clearstatus`',
            inline: false,
          },
        )
        .setFooter({ text: `${client.user.username}  •  Page 2 of 2 — Games` });

      message.reply({ embeds: [helpEmbed1, helpEmbed2] });
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
      const targets = [...message.mentions.users.values()];
      if(!targets.length) return message.reply('❌ Mention at least one user. Usage: `!dm @user1 @user2 ... message`');
      // Remove all mentioned users from args to get the message text
      const txt = message.content.replace(/^!\S+\s*/,'').replace(/<@!?(\d+)>/g,'').trim();
      if(!txt) return message.reply('❌ Provide a message after the mentions.');
      if (targets.length === 1) {
        // Single user — instant DM
        try {
          await targets[0].send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`📩 From ${message.guild.name}`).setDescription(txt).setFooter({text:`By ${message.author.username}`}).setTimestamp()]});
          message.reply({embeds:[successEmbed('DM Sent',`Sent to **${targets[0].username}**.`)]});
        } catch { message.reply({embeds:[errorEmbed(`Cannot DM **${targets[0].username}**. Their DMs are closed.`)]}); }
      } else {
        // Multiple users — rate-limited (1.5s gap to avoid ban)
        const prog = await message.reply(`📤 Sending DMs to **${targets.length}** users... (rate-limited for safety)`);
        let sent=0, failed=0;
        for (const t of targets) {
          try {
            await t.send({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle(`📩 From ${message.guild.name}`).setDescription(txt).setFooter({text:`By ${message.author.username}`}).setTimestamp()]});
            sent++;
          } catch { failed++; }
          await sleep(1500); // 1.5s gap between DMs to avoid rate-limit ban
        }
        prog.edit({embeds:[infoEmbed('📩 Multi-DM Complete',`✅ Sent: **${sent}**\n❌ Failed (DMs closed): **${failed}**\n\n*Rate limiting was applied to protect the bot.*`)],content:''});
      }
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
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent! Usage: `!ttt @user`');
      if(tttGames[message.channel.id]) return message.reply('❌ Game already running here.');
      const g={board:Array(9).fill(null),player1:message.author.id,player2:opp.id,currentPlayer:message.author.id,symbol:'❌'};
      tttGames[message.channel.id]=g;
      const tttMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('❌ Tic Tac Toe ⭕')
        .setDescription(`⚔️ **${message.author.username}** challenges **${opp.user.username}**!\n\n📖 **How to play:**\n• **2 players** take turns placing their symbol\n• <@${message.author.id}> is ❌ | <@${opp.id}> is ⭕\n• Get **3 in a row** (horizontal, vertical, or diagonal) to win!\n• Click the buttons to place your symbol\n\n*Setting up the board...*`).setTimestamp()]});
      await sleep(700);
      await tttMsg.edit({embeds:[buildTTTEmbed(g,`<@${message.author.id}>'s turn (❌)`)],components:buildTTTRows(g.board,false)});
      break;
    }

    case 'hangman': {
      if(hangmanGames[message.channel.id]) return message.reply('❌ Hangman already running here! Type a letter to join in.');
      const word=HM_WORDS[Math.floor(Math.random()*HM_WORDS.length)];
      hangmanGames[message.channel.id]={word,guessed:[],wrong:0,scores:{}};
      message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🪓 Hangman — Game Started!')
        .setDescription(`${HM_STAGES[0]}\n**Word:** \`${'_ '.repeat(word.length).trim()}\`\n\n📖 **How to play:**\n• **Anyone** in this channel can guess!\n• Type a **single letter** in chat to guess\n• You have only **5 wrong guesses** — one less than usual!\n• Correct letters earn you points on the scoreboard\n\n👥 **Players:** Everyone — no limits!\n📏 **Word length:** ${word.length} letters`)
        .setFooter({text:`Type a single letter to guess! • Only 5 wrong guesses!`}).setTimestamp()]});
      break;
    }

    case 'trivia': {
      if(triviaGames[message.channel.id]) return message.reply('❌ Trivia already running! Type your answer to participate.');
      const q=TRIVIA[Math.floor(Math.random()*TRIVIA.length)];
      triviaGames[message.channel.id]={q,userId:message.author.id};
      const choices=q.c.map((c,i)=>`${['🇦','🇧','🇨','🇩'][i]} **${c}**`).join('\n');
      message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🧠 Trivia — HARD MODE!')
        .setDescription(`**${q.q}**\n\n${choices}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📖 Type the **letter** (A/B/C/D) or the **full answer**!\n👥 **Anyone** can answer — first correct wins the point!\n⏱️ **30 seconds!**`)
        .setFooter({text:'Anyone can answer! • 30 seconds'}).setTimestamp()]});
      setTimeout(()=>{if(triviaGames[message.channel.id]){delete triviaGames[message.channel.id];message.channel.send({embeds:[errorEmbed(`⏱️ Time's up! The answer was: **${q.c.find(c=>c.toLowerCase()===q.a)||q.a}**`)]}).catch(()=>{});}},30000);
      break;
    }

    case 'guess': {
      if(guessGames[message.channel.id]) return message.reply('❌ Already running! Type a number to guess.');
      const n=Math.floor(Math.random()*1000)+1;
      guessGames[message.channel.id]={number:n,attempts:0,userId:message.author.id};
      message.reply({embeds:[infoEmbed('🔢 Guess the Number — HARD MODE',`I picked a number **1–1000**!\n\n📖 **How to play:**\n• Type a number in chat to guess\n• I'll tell you if it's too high or too low\n• You have **7 attempts** total — use them wisely!\n\n👥 **Players:** Anyone in this channel!\n⏱️ **Time:** 60 seconds\n\n*Type your first guess now! (Range: 1–1000)*`)]});
      setTimeout(()=>{if(guessGames[message.channel.id]){delete guessGames[message.channel.id];message.channel.send({embeds:[errorEmbed(`⏱️ Time's up! The number was **${n}**.`)]}).catch(()=>{});}},60000);
      break;
    }

    case 'rps': case 'rockpaperscissors': {
      const opp=message.mentions.members.first();
      // If no opponent mentioned → play vs bot
      if (!opp) {
        const map={rock:'🪨',paper:'📄',scissors:'✂️'};
        const uc=args[0]?.toLowerCase(); if(!map[uc]) return message.reply('❌ Choose `rock`, `paper`, or `scissors`! Or mention a player: `!rps @user`');
        const bc=Object.keys(map)[Math.floor(Math.random()*3)];
        const wins={rock:'scissors',paper:'rock',scissors:'paper'};
        const res=uc===bc?'🤝 Tie!':wins[uc]===bc?'🎉 You win!':'🤖 I win!';
        const color=uc===bc?'#FEE75C':wins[uc]===bc?'#57F287':'#ED4245';
        const countdown = await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors vs Bot').setDescription(`You threw **${map[uc]} ${uc}**\n\n**3...**`).setTimestamp()]});
        await sleep(600);
        await countdown.edit({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors vs Bot').setDescription(`You threw **${map[uc]} ${uc}**\n\n**3... 2...**`).setTimestamp()]});
        await sleep(600);
        await countdown.edit({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('✊ Rock Paper Scissors vs Bot').setDescription(`You threw **${map[uc]} ${uc}**\n\n**3... 2... 1...**`).setTimestamp()]});
        await sleep(600);
        await countdown.edit({embeds:[new EmbedBuilder().setColor(color).setTitle('✊ Rock Paper Scissors — Result!').setDescription(`You: **${map[uc]} ${uc}**\nBot: **${map[bc]} ${bc}**\n\n${res}\n\n💡 *Tip: Use \`!rps @user\` to play against a friend!*`).setTimestamp()]});
        break;
      }
      // Multiplayer RPS
      if(opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent!');
      if(rpsGames[message.channel.id]) return message.reply('❌ RPS game already running here!');
      const bestOf=parseInt(args[1])||3;
      const allowed=[1,3,5,7];
      if(!allowed.includes(bestOf)) return message.reply('❌ Best-of must be 1, 3, 5 or 7.');
      const g={p1:message.author.id,p2:opp.id,score1:0,score2:0,round:1,bestOf,choice1:null,choice2:null};
      rpsGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🎮 Rock Paper Scissors — Multiplayer')
        .setDescription(`⚔️ **${message.author.username}** challenges **${opp.user.username}**!\n**Best of ${bestOf}** — May the best hand win! ✊\n\n📖 **How to play:**\n• Both players secretly pick 🪨 Rock, 📄 Paper, or ✂️ Scissors using the buttons\n• Choices are hidden until both pick!\n• **First to ${Math.ceil(bestOf/2)} wins** takes the match\n\n*Loading...*`).setTimestamp()]});
      await sleep(800);
      await initMsg.edit({embeds:[buildRPSLobbyEmbed(g)],components:buildRPSRows(false)});
      break;
    }

    case 'blackjack': case 'bj': {
      if(bjGames[message.author.id]) return message.reply('❌ Finish your current game first!');
      const bet=parseInt(args[0])||50;
      const deck=makeDeck();
      const ph=[drawCard(deck),drawCard(deck)], dh=[drawCard(deck),drawCard(deck)];
      bjGames[message.author.id]={deck,playerHand:ph,dealerHand:dh,bet};
      // Dealing animation with game info
      const dealMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#FEE75C').setTitle('🃏 Blackjack')
        .setDescription(`📖 **How to play:**\n• **1 player** vs the Dealer (bot)\n• Get closer to **21** than the dealer without going over\n• **Hit** = draw another card | **Stand** = keep your hand\n• Dealer hits until 17+\n• **Blackjack (21 instantly) = 2.5× payout!**\n\nBet: **${bet} coins**\n*Shuffling deck...*`).setTimestamp()]});
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
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent! Usage: `!c4 @user`');
      if(c4Games[message.channel.id]) return message.reply('❌ Game already running here!');
      const g={board:makeC4Board(),player1:message.author.id,player2:opp.id,currentPlayer:message.author.id,symbol:'🔴',moves:0,lastCol:null};
      c4Games[message.channel.id]=g;
      const c4Msg = await message.reply({embeds:[new EmbedBuilder().setColor('#FF4444').setTitle('🔴 Connect 4 🟡')
        .setDescription(`⚔️ **${message.author.username}** 🔴 challenges **${opp.user.username}** 🟡!\n\n📖 **How to play:**\n• **2 players** take turns dropping pieces\n• <@${message.author.id}> is 🔴 | <@${opp.id}> is 🟡\n• Click a **column button** to drop your piece (columns 1–4 on top row, 5–7 on bottom row)\n• Connect **4 in a row** (horizontally, vertically, or diagonally) to win!\n• ⚫ = empty | Full columns are disabled automatically!\n\n*Setting up the board...*`).setTimestamp()]});
      await sleep(700);
      await c4Msg.edit({embeds:[buildC4Embed(g,`<@${message.author.id}>'s turn (🔴)`)],components:buildC4Rows(false,g.board)});
      break;
    }

    case 'wordle': {
      if(wordleGames[message.channel.id]) return message.reply('❌ Wordle already running here! Type a 5-letter word to join.');
      const word=WORDLE_WORDS[Math.floor(Math.random()*WORDLE_WORDS.length)];
      wordleGames[message.channel.id]={word,guesses:[],userId:message.author.id};
      message.reply({embeds:[new EmbedBuilder().setColor('#538D4E').setTitle('🟩 Wordle — Channel Game!')
        .setDescription('Guess the **5-letter word** in 6 tries!\n\n🟩 Right letter + right spot\n🟨 Right letter, wrong spot\n⬛ Letter not in word\n\n📖 **How to play:** Type any **5-letter word** in chat to guess!\n👥 **Players:** Anyone in this channel!\n🎯 **Goal:** Solve the word in 6 tries\n\n*Type your first 5-letter word to start guessing!*')
        .setFooter({text:'Anyone can guess • 6 attempts'}).setTimestamp()]});
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



    case 'mathduel': case 'md': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent! Usage: `!mathduel @user [difficulty 1-3]`');
      if(mathDuelGames[message.channel.id]) return message.reply('❌ Math Duel already running here!');
      const diff=parseInt(args[1])||2; // Default difficulty 2 now!
      if(diff<1||diff>3) return message.reply('❌ Difficulty: 1 (medium) 2 (hard) 3 (brutal)');
      const q=genMathQ(diff);
      const g={p1:message.author.id,p2:opp.id,score1:0,score2:0,qNum:0,diff,current:q,answered:false};
      mathDuelGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#5865F2').setTitle('🧮 Math Duel — HARDCORE')
        .setDescription(`⚔️ **${message.author.username}** vs **${opp.user.username}**!\nDifficulty: ${'⭐'.repeat(diff)}\n\n📖 **How to play:**\n• **2 players** race to solve math problems\n• Type the correct answer in chat — **first to answer** wins the point!\n• **First to 3 points** (or most after 5 Qs) wins!\n• ⏱️ Only **10 seconds** per question!\n• Difficulty ${diff}: ${diff===1?'Mixed arithmetic (medium)':diff===2?'Multi-step math (hard)':'Bracket math (brutal 💀)'}\n\n*Loading questions...*`).setTimestamp()]});
      await sleep(800);
      await initMsg.edit({embeds:[buildMathEmbed(g)]});
      break;
    }

    case 'wordchain': case 'wc': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent! Usage: `!wordchain @user`');
      if(wordChainGames[message.channel.id]) return message.reply('❌ Word Chain already running here!');
      const starters='bcdfghlmnprst'; // Only consonants — harder starting letters
      const startLetter=starters[Math.floor(Math.random()*starters.length)];
      const g={p1:message.author.id,p2:opp.id,chain:[],lastLetter:startLetter,currentTurn:message.author.id,used:new Set(),lives1:3,lives2:3,words1:0,words2:0,timeLimit:15,timer:null};
      wordChainGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🔗 Word Chain — HARDCORE MODE 💀')
        .setDescription(`⚔️ **${message.author.username}** vs **${opp.user.username}**!\n\n📖 **Rules (STRICT):**\n• Each word must **start with the last letter** of the previous word\n• Words must be **3+ letters** (no very short words!)\n• Words must be **English only** (only English alphabet letters — no numbers, symbols, or other languages!)\n• Wrong/invalid/repeated words **don't extend your timer** — you get penalized!\n• You start with **15 seconds** — timer shrinks as chain grows!\n• Lose all 3 ❤️ = eliminated\n\n⚠️ **Starting letter: ${startLetter.toUpperCase()}**\n\n*Prepare yourself...*`).setTimestamp()]});
      await sleep(700);
      await initMsg.edit({embeds:[buildWordChainEmbed(g)]});
      g.timer=setTimeout(async()=>{
        const loser=g.currentTurn; if(loser===g.p1) g.lives1--; else g.lives2--;
        if(g.lives1<=0||g.lives2<=0){const winner=g.lives1>0?g.p1:g.p2;delete wordChainGames[message.channel.id];return message.channel.send({embeds:[new EmbedBuilder().setColor('#ED4245').setTitle('🔗 Word Chain — Over!').setDescription(`⏱️ <@${loser}> timed out on the very first word!\n🏆 <@${winner}> **WINS!**`).setTimestamp()]});}
        g.currentTurn=g.currentTurn===g.p1?g.p2:g.p1;
        message.channel.send({embeds:[buildWordChainEmbed(g)]});
      },10000);
      break;
    }

    case 'triviabattle': case 'tb': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent! Usage: `!triviabattle @user`');
      if(triviaBattleGames[message.channel.id]) return message.reply('❌ Trivia Battle already running here!');
      const shuffled=[...TRIVIA_BATTLE_Q, ...TRIVIA.map(t=>({q:t.q,a:t.a,choices:t.c}))].sort(()=>Math.random()-0.5).slice(0,10);
      const g={p1:message.author.id,p2:opp.id,questions:shuffled,qNum:0,score1:0,score2:0,answered:[],roundWinner:null};
      triviaBattleGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#E67E22').setTitle('⚡ Trivia Battle — 10 ROUNDS!')
        .setDescription(`╔══════════════════════════════╗\n║  ⚡  TRIVIA  BATTLE  ⚡        ║\n╚══════════════════════════════╝\n\n⚔️ **<@${message.author.id}>** challenges **<@${opp.id}>**!\n\n📖 **Rules:**\n• **10 questions** — simultaneous answering!\n• Both players click A/B/C/D — first correct answer wins the point!\n• Highest score after 10 rounds wins! 🏆\n\n*Loading questions...*`).setTimestamp()]});
      await sleep(800);
      await initMsg.edit({embeds:[buildTriviaBattleEmbed(g)],components:buildTriviaBattleRows(false)});
      break;
    }

    case 'battleship': case 'bs': {
      const opp=message.mentions.members.first();
      if(!opp||opp.user.bot||opp.id===message.member.id) return message.reply('❌ Mention a valid opponent! Usage: `!battleship @user`');
      if(battleshipGames[message.channel.id]) return message.reply('❌ Battleship already running here!');
      const b1=makeBSBoard(), b2=makeBSBoard();
      const ships1=placeBSShips(b1), ships2=placeBSShips(b2);
      const g={p1:message.author.id,p2:opp.id,board1:b1,board2:b2,ships1,ships2,shots1:[],shots2:[],currentTurn:message.author.id};
      battleshipGames[message.channel.id]=g;
      const battleEmbed = new EmbedBuilder().setColor('#3498DB').setTitle('🚢 Battleship — Battle Begins! ⚓')
        .setDescription(`<@${message.author.id}> vs <@${opp.id}>\n\n**Grid:** 15×15 (A–O columns, 1–15 rows)\n**Ships:** ${ships1.map(s=>s.name).join(', ')}\n\n<@${g.currentTurn}>'s turn! Type a coordinate like \`A1\`, \`H8\`, \`O15\`\n\n${renderBSGrid(b2,[])}`)
        .setTimestamp();
      try {
        const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#3498DB').setTitle('🚢 Battleship')
          .setDescription(`⚓ **${message.author.username}** vs **${opp.user.username}**!\n\n• 15×15 grid (A–O columns, 1–15 rows)\n• Ships placed secretly — sink them all to win!\n• Type coordinates like \`A1\`, \`H8\`, \`O15\`\n• 💥 = Hit | 〰️ = Miss | 🟦 = Unknown\n• Ships: ${ships1.map(s=>s.name).join(', ')}\n\n*Deploying fleets...*`).setTimestamp()]});
        await sleep(900);
        await initMsg.edit({embeds:[battleEmbed]});
      } catch {
        await message.channel.send({embeds:[battleEmbed]});
      }
      break;
    }

    case 'memory': {
      if(memoryGames[message.author.id]) return message.reply('❌ You already have a Memory game! Finish it first.');
      const g=makeMemoryGame(); g.userId=message.author.id;
      memoryGames[message.author.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🃏 Memory Match').setDescription('*Shuffling cards...*').setTimestamp()]});
      await sleep(600);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#9B59B6').setTitle('🃏 Memory Match')
        .setDescription(`${renderMemory(g)}\n\n📖 **How to play:**\n• **1 player** game (solo challenge)\n• Click **numbered buttons** to flip cards\n• Find all **6 matching pairs** to win!\n• Try to do it in as few moves as possible!\n• 🌟🌟🌟 = ≤10 moves | ⭐⭐ = ≤15 | ⭐ = more\n\n**Moves:** 0 | **Pairs:** 0/6`)
        .setTimestamp()],components:buildMemoryRows(g,false)});
      break;
    }

    case 'hol': case 'higherorlower': {
      if(holGames[message.author.id]) return message.reply('❌ You already have a Higher or Lower game!');
      const items=[...HOL_ITEMS].sort(()=>Math.random()-0.5).slice(0,8);
      const g={items,idx:0,streak:0,best:0,userId:message.author.id};
      holGames[message.author.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#1ABC9C').setTitle('📊 Higher or Lower').setDescription('*Loading questions...*').setTimestamp()]});
      await sleep(500);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#1ABC9C').setTitle('📊 Higher or Lower — Starting!')
        .setDescription(`📖 **How to play:**\n• **1 player** game — solo or challenge friends!\n• You'll see a number fact, then guess if the next one is **Higher** or **Lower**\n• Build a streak — don't break it!\n\n**First card:** ${items[0].name}\n> **${items[0].val} ${items[0].unit}**\n\n**Next:** ${items[1].name}\nIs it **Higher** or **Lower**?\n\n⭐ Streak: 0`)
        .setFooter({text:'Click a button to guess!'}).setTimestamp()],components:buildHOLRows(false)});
      g.idx=1;
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
      const rounds=parseInt(args[0])||8;
      if(rounds<1||rounds>20) return message.reply('❌ Rounds must be 1–20.');
      const entry=SCRAMBLE_WORDS[Math.floor(Math.random()*SCRAMBLE_WORDS.length)];
      const g={word:entry.word,hint:entry.hint,scrambled:scrambleWord(entry.word),round:1,maxRounds:rounds,scores:{}};
      scrambleGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#F39C12').setTitle('🔀 Scramble — WORD CHALLENGE!')
        .setDescription(`╔══════════════════════════════╗\n║  🔀  SCRAMBLE  CHALLENGE  🔀  ║\n╚══════════════════════════════╝\n\n📖 **Rules:**\n• **${rounds} rounds** — anyone can answer!\n• Unscramble the word — first correct answer wins the point!\n• Words get harder as you progress!\n\n*Scrambling your first word...*`).setTimestamp()]});
      await sleep(600);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#F39C12').setTitle(`🔀 Scramble — Round 1/${rounds}`)
        .setDescription(`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**Unscramble this word:**\n\n# \`${g.scrambled}\`\n\n💡 **Hint:** ${g.hint}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n*Type your answer in chat — anyone can answer!*`)
        .setFooter({text:`${rounds} rounds total • First correct answer gets the point!`}).setTimestamp()]});
      break;
    }

    case 'emojidecode': case 'ed': {
      if(emojiDecodeGames[message.channel.id]) return message.reply('❌ Emoji Decode already running here!');
      const rounds=parseInt(args[0])||8;
      if(rounds<1||rounds>20) return message.reply('❌ Rounds must be 1–20.');
      const puzzle=EMOJI_PUZZLES[Math.floor(Math.random()*EMOJI_PUZZLES.length)];
      const g={puzzle,round:1,maxRounds:rounds,scores:{}};
      emojiDecodeGames[message.channel.id]=g;
      const initMsg=await message.reply({embeds:[new EmbedBuilder().setColor('#8E44AD').setTitle('🤔 Emoji Decode — CHALLENGE!')
        .setDescription(`╔══════════════════════════════╗\n║  🤔  EMOJI  DECODE  🤔        ║\n╚══════════════════════════════╝\n\n📖 **Rules:**\n• **${rounds} rounds** — anyone can answer!\n• Emojis represent a word/phrase — decode it!\n• First correct answer wins the point!\n\n*Loading emoji puzzle...*`).setTimestamp()]});
      await sleep(600);
      await initMsg.edit({embeds:[new EmbedBuilder().setColor('#8E44AD').setTitle(`🤔 Emoji Decode — Round 1/${rounds}`)
        .setDescription(`━━━━━━━━━━━━━━━━━━━━━━━━━━━\n**What do these emojis represent?**\n\n# ${puzzle.emojis}\n\n💡 **Hint:** ${puzzle.hint}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n*Type your answer in chat — no spaces needed!*`)
        .setFooter({text:`${rounds} rounds total • First correct answer gets the point!`}).setTimestamp()]});
      break;
    }

    case 'fasttype': case 'ft': {
      if(fastTypeGames[message.channel.id]) return message.reply('❌ Fast Type already running here!');
      const sentence = FASTTYPE_SENTENCES[Math.floor(Math.random()*FASTTYPE_SENTENCES.length)];
      const g = {sentence, winner:null, startTime:null};
      fastTypeGames[message.channel.id] = g;
      const readyMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#00BFFF').setTitle('⌨️ Fast Type — Get Ready!')
        .setDescription(`📖 **How to play:**\n• **Anyone** can participate — no player limit!\n• Type the sentence below **exactly** (case-insensitive)\n• **First to finish** wins!\n• Watch your spelling!\n\n**Get ready... Starting in 3 seconds!**`).setTimestamp()]});
      await sleep(3000);
      g.startTime = Date.now();
      await readyMsg.edit({embeds:[new EmbedBuilder().setColor('#57F287').setTitle('⌨️ Fast Type — GO! 🚀')
        .setDescription(`**Type this sentence exactly:**\n\n>>> ${sentence}\n\n*First to type it correctly wins! ⏱️*`)
        .setFooter({text:'Case-insensitive • First correct answer wins!'}).setTimestamp()]});
      // Auto-cancel after 45s — harder time limit
      setTimeout(()=>{ if(fastTypeGames[message.channel.id]){delete fastTypeGames[message.channel.id];message.channel.send({embeds:[errorEmbed(`⏱️ 45 seconds up! Nobody finished in time.\n\n**Sentence was:** \`${sentence}\``)]}).catch(()=>{});}},45000);
      break;
    }

    case 'truthordare': case 'tod': {
      if (truthDareGames[message.channel.id]) return message.reply('❌ A Truth or Dare game is already running here! Use `!stopgame` to end it first.');
      // Collect players from mentions, or default to just the author
      const mentionedUsers = [...message.mentions.users.values()].filter(u => !u.bot);
      const players = mentionedUsers.length
        ? [message.author, ...mentionedUsers]
        : [message.author];
      // Remove duplicates
      const uniquePlayers = [...new Map(players.map(u => [u.id, u])).values()];
      if (uniquePlayers.length < 1) return message.reply('❌ Could not find valid players!');

      // Pick the first person to go
      const firstPlayer = uniquePlayers[0];
      truthDareGames[message.channel.id] = {
        players: uniquePlayers.map(u => u.id),
        currentIndex: 0,
        currentPlayer: firstPlayer.id,
        round: 1,
      };

      const playerList = uniquePlayers.map((u, i) => `${i === 0 ? '▶️' : '⬜'} <@${u.id}>`).join('\n');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tod:truth').setLabel('🤔 Truth').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tod:dare').setLabel('🎯 Dare').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('tod:skip').setLabel('⏭️ Skip Turn').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('tod:stop').setLabel('🛑 Stop Game').setStyle(ButtonStyle.Secondary),
      );

      await message.reply({ embeds: [
        new EmbedBuilder()
          .setColor('#9B59B6')
          .setTitle('🎭 Truth or Dare — Game Started!')
          .setDescription(
            `A Truth or Dare game has begun!\n\n` +
            `**Players (${uniquePlayers.length}):**\n${playerList}\n\n` +
            `<@${firstPlayer.id}> goes first!\n` +
            `**Choose your fate below 👇**\n\n` +
            `> 🤔 **Truth** — Answer an honest question\n` +
            `> 🎯 **Dare** — Complete a challenge\n` +
            `> ⏭️ **Skip** — Pass your turn (no shame!)\n\n` +
            `*Only the current player should click!*`
          )
          .setFooter({ text: `Round 1 • ${uniquePlayers.length} player(s) • Anyone can use !stopgame to end` })
          .setTimestamp()
      ], components: [row] });
      break;
    }

    // ── TEXAS HOLD'EM POKER ────────────────────────────────────────────────────
    case 'poker': case 'holdem': {
      const opp = message.mentions.members.first();
      if (!opp || opp.user.bot || opp.id === message.member.id) return message.reply('❌ Mention a valid opponent! Usage: `!poker @user`');
      if (pokerGames[message.channel.id]) return message.reply('❌ Poker game already running here!');
      const startChips = parseInt(args[1]) || 500;
      if (startChips < 100 || startChips > 10000) return message.reply('❌ Chips must be 100–10,000.');
      const deck = makePokerDeck();
      const p1 = {id: message.author.id, hand: [deck.pop(), deck.pop()], chips: startChips-10, bet: 10, folded: false, allIn: false};
      const p2 = {id: opp.id,            hand: [deck.pop(), deck.pop()], chips: startChips-20, bet: 20, folded: false, allIn: false};
      const g = {players:[p1,p2], deck, communityCards:[], currentTurn: message.author.id, pot:0, round:1};
      pokerGames[message.channel.id] = g;

      const initMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#1A472A').setTitle('🃏 Texas Hold\'em Poker')
        .setDescription(
          `╔═══════════════════════════════╗\n` +
          `║  ♠️ ♥️  POKER NIGHT  ♦️ ♣️  ║\n` +
          `╚═══════════════════════════════╝\n\n` +
          `⚔️ **<@${message.author.id}>** challenges **<@${opp.id}>**!\n\n` +
          `📖 **How to Play:**\n` +
          `• Each player gets **2 hole cards** (sent via DM!)\n` +
          `• **5 community cards** are revealed over 4 rounds\n` +
          `• Best **5-card hand** wins the pot!\n` +
          `• **Blinds:** ${message.author.username} posts 10 | ${opp.user.username} posts 20\n` +
          `• Actions: ❌ Fold | 📞 Call/Check | 📈 Raise | 💥 All-In\n\n` +
          `🏆 **10 rounds** | Starting chips: **${startChips} each**\n\n` +
          `*Shuffling deck and dealing cards...*`
        ).setTimestamp()]});

      // Send hole cards via DM
      try { await message.author.send(`🃏 **Your hole cards (Round 1):** ${pokerHandStr(p1.hand)}\n_(Keep these secret!)_`); } catch { await message.channel.send(`⚠️ <@${message.author.id}> couldn't receive DM! Enable DMs to see your cards.`); }
      try { await opp.user.send(`🃏 **Your hole cards (Round 1):** ${pokerHandStr(p2.hand)}\n_(Keep these secret!)_`); } catch { await message.channel.send(`⚠️ <@${opp.id}> couldn't receive DM! Enable DMs to see your cards.`); }

      await sleep(1000);
      await initMsg.edit({embeds:[buildPokerEmbed(g)], components: buildPokerActionRows(false)});
      break;
    }

    // ── QUIZ SHOWDOWN ──────────────────────────────────────────────────────────
    case 'quizshowdown': case 'qs': {
      if (quizShowdownGames[message.channel.id]) return message.reply('❌ Quiz Showdown already running here!');
      const rounds = Math.min(parseInt(args[0]) || 10, 15);
      const questions = [...QUIZ_SHOWDOWN_Q].sort(()=>Math.random()-0.5).slice(0,rounds);
      const g = {questions, qNum:0, scores:{}, timer:null};
      quizShowdownGames[message.channel.id] = g;
      const initMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#FF6B35').setTitle('🏆 Quiz Showdown — GET READY!')
        .setDescription(
          `╔══════════════════════════════╗\n` +
          `║  🧠  QUIZ SHOWDOWN  🧠        ║\n` +
          `╚══════════════════════════════╝\n\n` +
          `📖 **Rules:**\n• **Anyone** in this channel can play!\n• **${rounds} questions** — 30 seconds each\n• First to type the correct answer wins the point!\n• Type the **letter (A/B/C/D)** or the **full answer**\n\n` +
          `🚀 **Starting in 5 seconds...**`
        ).setTimestamp()]});
      await sleep(5000);
      g.timer = setTimeout(() => {
        if (!quizShowdownGames[message.channel.id]) return;
        g.qNum++;
        if (g.qNum >= g.questions.length) { delete quizShowdownGames[message.channel.id]; message.channel.send({embeds:[buildScoreboard(g.scores,'🏆 Quiz Showdown — Time Up!')]}).catch(()=>{}); return; }
        message.channel.send({embeds:[buildQuizShowdownEmbed(g)]}).catch(()=>{});
      }, 30000);
      await initMsg.edit({embeds:[buildQuizShowdownEmbed(g)]});
      break;
    }

    // ── WORD BOMB ──────────────────────────────────────────────────────────────
    case 'wordbomb': case 'wb': {
      if (wordBombGames[message.channel.id]) return message.reply('❌ Word Bomb already running here!');
      const mentions = [...message.mentions.users.values()].filter(u=>!u.bot);
      if (mentions.length < 1) return message.reply('❌ Mention at least 1 opponent! Usage: `!wordbomb @user1 @user2 ...`');
      const players = [message.author.id, ...mentions.map(u=>u.id)];
      const prompt = WB_PROMPTS[Math.floor(Math.random()*WB_PROMPTS.length)];
      const g = {players, turn:0, prompt, usedWords: new Set(), round:0, timeLimit:15, timer:null};
      wordBombGames[message.channel.id] = g;
      const initMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#FF4500').setTitle('💣 Word Bomb — MULTIPLAYER!')
        .setDescription(
          `╔══════════════════════════════╗\n` +
          `║  💣  WORD  BOMB  💣           ║\n` +
          `╚══════════════════════════════╝\n\n` +
          `📖 **Rules:**\n• You must type a word **containing the given letters**!\n• **15 seconds** per turn — timer gets shorter as game goes on!\n• No repeating words!\n• Miss your turn? You're **ELIMINATED!** 💥\n\n` +
          `👥 **Players (${players.length}):** ${players.map(id=>`<@${id}>`).join(', ')}\n\n` +
          `🚀 **Starting in 3 seconds...**`
        ).setTimestamp()]});
      await sleep(3000);
      const nextPlayer = g.players[0];
      g.timer = setTimeout(async () => {
        const elim = g.players[g.turn % g.players.length];
        g.players = g.players.filter(id=>id!==elim);
        if (g.players.length <= 1) {
          delete wordBombGames[message.channel.id];
          return message.channel.send({embeds:[new EmbedBuilder().setColor('#FFD700').setTitle('💣 Word Bomb — WINNER!')
            .setDescription(`⏱️ <@${elim}> timed out! 💥\n\n🏆 **<@${g.players[0]}> WINS!**`).setTimestamp()]}).catch(()=>{});
        }
        message.channel.send({embeds:[buildWordBombEmbed(g)]}).catch(()=>{});
      }, g.timeLimit * 1000);
      await initMsg.edit({embeds:[buildWordBombEmbed(g)]});
      break;
    }

    // ── MURDER MYSTERY ─────────────────────────────────────────────────────────
    case 'murdermystery': case 'mm': {
      if (murderGames[message.channel.id]) return message.reply('❌ Murder Mystery already running here!');
      const mentions = [...message.mentions.users.values()].filter(u=>!u.bot);
      const players = [message.author.id, ...mentions.map(u=>u.id)];
      if (players.length < 2) return message.reply('❌ Mention at least 1 other player! Usage: `!mm @player2 @player3 ...`');
      const killer = MM_SUSPECTS[Math.floor(Math.random()*MM_SUSPECTS.length)];
      const weapon = MM_WEAPONS[Math.floor(Math.random()*MM_WEAPONS.length)];
      const room   = MM_ROOMS[Math.floor(Math.random()*MM_ROOMS.length)];
      const victim = `Member #${Math.floor(Math.random()*999)+100}`;
      const generateClue = (isReal) => {
        const template = MM_CLUES[Math.floor(Math.random()*MM_CLUES.length)];
        const fakeSuspect = MM_SUSPECTS.filter(s=>s!==killer)[Math.floor(Math.random()*(MM_SUSPECTS.length-1))];
        const fakeRoom    = MM_ROOMS.filter(r=>r!==room)[Math.floor(Math.random()*(MM_ROOMS.length-1))];
        return template.replace('{suspect}', isReal?killer:fakeSuspect)
                       .replace('{weapon}', weapon)
                       .replace('{room}', isReal?room:fakeRoom);
      };
      // 2 real clues + 2 fake clues, shuffled
      const clues = [generateClue(true), generateClue(true), generateClue(false), generateClue(false)].sort(()=>Math.random()-0.5);
      const g = {players, killer, weapon, room, victim, clues, cluePhase:0, phase:'clues', votes:{}};
      murderGames[message.channel.id] = g;
      const scene = `${victim} was found dead in the ${room.split(' ')[1]} with a ${weapon.split(' ')[1]} nearby.`;
      g.scene = scene;
      const initMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#4A0000').setTitle('🔪 Murder Mystery — A Crime Has Been Committed!')
        .setDescription(
          `╔══════════════════════════════╗\n` +
          `║  🔪  MURDER MYSTERY  🔪       ║\n` +
          `╚══════════════════════════════╝\n\n` +
          `💀 **The Victim:** ${victim}\n🔍 **Scene:** ${scene}\n\n` +
          `📖 **How to Play:**\n• 4 clues will be revealed over 80 seconds\n• Analyze them carefully — some may be RED HERRINGS!\n• After all clues, **60 seconds** to vote on the killer\n• Most votes on the correct suspect wins!\n\n` +
          `👥 **Investigators (${players.length}):** ${players.map(id=>`<@${id}>`).join(', ')}\n\n` +
          `🕵️ *First clue in 5 seconds...*`
        ).setTimestamp()]});

      // Reveal clues every 20s
      for (let i = 1; i <= 4; i++) {
        await sleep(i === 1 ? 5000 : 20000);
        if (!murderGames[message.channel.id]) return;
        g.cluePhase = i;
        await message.channel.send({embeds:[buildMurderMysteryEmbed(g, 'clues')]}).catch(()=>{});
      }
      await sleep(5000);
      if (!murderGames[message.channel.id]) return;
      g.phase = 'voting';
      const voteMsg = await message.channel.send({embeds:[buildMurderMysteryEmbed(g, 'voting')]}).catch(()=>{});

      // Tally votes after 60s
      setTimeout(async () => {
        if (!murderGames[message.channel.id]) return;
        const voteCounts = {};
        for (const [uid, suspect] of Object.entries(g.votes||{})) {
          voteCounts[suspect] = (voteCounts[suspect]||0) + 1;
        }
        const topVote = Object.entries(voteCounts).sort(([,a],[,b])=>b-a)[0];
        const correct = topVote && topVote[0] === g.killer;
        const correctVoters = Object.entries(g.votes||{}).filter(([,s])=>s===g.killer).map(([id])=>`<@${id}>`);
        delete murderGames[message.channel.id];
        await message.channel.send({embeds:[new EmbedBuilder().setColor(correct?'#57F287':'#ED4245').setTitle(`🔪 Murder Mystery — ${correct?'SOLVED! 🎉':'UNSOLVED! 😱'}`)
          .setDescription(
            `**The Killer was: ${g.killer}**\n**Weapon: ${g.weapon}** | **Room: ${g.room}**\n\n` +
            (correct ? `✅ **${correctVoters.join(', ')} guessed correctly!** 🏆` : `❌ **No one solved the case...**\n${topVote?`Most votes went to: ${topVote[0]}`:'*No votes cast*'}`) +
            `\n\n**Vote Tally:**\n${Object.entries(voteCounts).map(([s,c])=>`${s}: **${c}** vote(s)`).join('\n')||'*No votes*'}`
          ).setTimestamp()]}).catch(()=>{});
      }, 60000);
      break;
    }

    // ── ENHANCED TRIVIA (15 rounds) ────────────────────────────────────────────
    case 'triviamarathon': case 'tm': {
      if (quizShowdownGames[message.channel.id]) return message.reply('❌ Already running!');
      const q = [...QUIZ_SHOWDOWN_Q, ...TRIVIA.map(t=>({q:t.q, a:t.a, c:t.c}))].sort(()=>Math.random()-0.5).slice(0,15);
      const g = {questions:q, qNum:0, scores:{}, timer:null};
      quizShowdownGames[message.channel.id] = g;
      const initMsg = await message.reply({embeds:[new EmbedBuilder().setColor('#E91E8C').setTitle('🧠 Trivia Marathon — 15 ROUNDS!')
        .setDescription(`╔══════════════════════════════╗\n║  🧠 TRIVIA MARATHON 🧠       ║\n╚══════════════════════════════╝\n\n📖 **15 questions** • **30s each** • Anyone can answer!\nFirst correct answer gets the point! Starting in 5s...`)
        .setTimestamp()]});
      await sleep(5000);
      g.timer = setTimeout(()=>{ if (!quizShowdownGames[message.channel.id]) return; g.qNum++; if(g.qNum>=g.questions.length){delete quizShowdownGames[message.channel.id];message.channel.send({embeds:[buildScoreboard(g.scores,'🧠 Trivia Marathon — Finished!')]}).catch(()=>{});return;} message.channel.send({embeds:[buildQuizShowdownEmbed(g)]}).catch(()=>{}); },30000);
      await initMsg.edit({embeds:[buildQuizShowdownEmbed(g)]});
      break;
    }

    // ── TEAM TRIVIA ──────────────────────────────────────────────────────────
    case 'teamtrivia': case 'tt': {
      if (teamTriviaGames[message.channel.id]) return message.reply('❌ A Team Trivia game is already running here! Use `!ttcancel` to cancel it.');
      const numTeams = Math.min(4, Math.max(2, parseInt(args[0]) || 2));
      const totalQ   = Math.min(20, Math.max(3,  parseInt(args[1]) || 10));
      const activeTeamIds = ['red','blue','green','yellow'].slice(0, numTeams);
      const teams = {};
      activeTeamIds.forEach(id => { teams[id] = []; });
      const scores = {};
      activeTeamIds.forEach(id => { scores[id] = 0; });
      const g = {
        host: message.author.id,
        phase: 'lobby',
        numTeams, totalQ,
        teams, scores,
        questions: shuffleTTQuestions(totalQ),
        qIdx: 0,
        currentTeam: activeTeamIds[0],
        answered: new Set(),
        teamAnswered: new Set(),
        mainTeamAnsweredWrong: false,
        playerCorrect: {},
      };
      teamTriviaGames[message.channel.id] = g;
      await message.reply({
        embeds: [buildTTLobbyEmbed(g)],
        components: buildTTTeamRows(g),
      });
      break;
    }

    case 'ttstart': {
      const g = teamTriviaGames[message.channel.id];
      if (!g) return message.reply('❌ No Team Trivia lobby here. Start one with `!teamtrivia [2-4 teams] [3-20 questions]`');
      if (g.phase !== 'lobby') return message.reply('❌ Game already started!');
      if (message.author.id !== g.host) return message.reply('❌ Only the host can start the game!');
      const activeTeamIds = ['red','blue','green','yellow'].slice(0, g.numTeams);
      const teamsWithPlayers = activeTeamIds.filter(id => g.teams[id].length > 0);
      if (teamsWithPlayers.length < 2) return message.reply('❌ At least **2 teams** must have players before starting!');
      const totalPlayers = activeTeamIds.reduce((sum, id) => sum + g.teams[id].length, 0);
      if (totalPlayers < 2) return message.reply('❌ Need at least **2 players** to start!');
      g.phase = 'question';
      // Remove empty teams from rotation
      g.numTeams = teamsWithPlayers.length;
      g.currentTeam = teamsWithPlayers[0];
      await message.reply({
        embeds: [new EmbedBuilder().setColor('#9B59B6').setTitle('🏆 Team Trivia — Starting!')
          .setDescription(
            `Game begins now! **${g.totalQ} questions**, **${teamsWithPlayers.length} teams**!\n\n` +
            teamsWithPlayers.map(tid => { const t = TT_TEAMS.find(x=>x.id===tid); return `${t.emoji} **${t.label}:** ${g.teams[tid].map(id=>`<@${id}>`).join(', ')}`; }).join('\n') +
            `\n\n📋 **Rules:**\n• Answering team gets **+2 pts** for correct answer\n• Wrong answer → other teams can **steal for +1 pt**!\n• First player on the answering team to click locks in the team's answer\n• Questions rotate between teams\n\n*First question in 3 seconds...*`
          ).setTimestamp()],
        components: [],
      });
      await sleep(3000);
      if (!teamTriviaGames[message.channel.id]) return;
      g.answered = new Set();
      g.teamAnswered = new Set();
      g.mainTeamAnsweredWrong = false;
      message.channel.send({ embeds: [buildTTQuestionEmbed(g)], components: buildTTAnswerRows(g, false) }).catch(()=>{});
      break;
    }

    case 'ttcancel': {
      const g = teamTriviaGames[message.channel.id];
      if (!g) return message.reply('❌ No Team Trivia game running here.');
      if (message.author.id !== g.host && !message.member.permissions.has(PermissionFlagsBits.ManageMessages))
        return message.reply('❌ Only the host or a moderator can cancel the game.');
      delete teamTriviaGames[message.channel.id];
      message.reply({ embeds: [successEmbed('🏆 Team Trivia Cancelled', `Game cancelled by <@${message.author.id}>.`)] });
      break;
    }

    case 'stopgame': case 'endgame': {
      if(!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return missingPerm(message,'Manage Messages');
      const cid = message.channel.id;
      const uid = message.author.id;
      let stopped = false;
      if(tttGames[cid]){delete tttGames[cid];stopped=true;}
      if(hangmanGames[cid]){delete hangmanGames[cid];stopped=true;}
      if(triviaGames[cid]){delete triviaGames[cid];stopped=true;}
      if(guessGames[cid]){delete guessGames[cid];stopped=true;}
      if(c4Games[cid]){delete c4Games[cid];stopped=true;}
      if(wordleGames[cid]){delete wordleGames[cid];stopped=true;}
      if(mathDuelGames[cid]){delete mathDuelGames[cid];stopped=true;}
      if(wordChainGames[cid]){delete wordChainGames[cid];stopped=true;}
      if(triviaBattleGames[cid]){delete triviaBattleGames[cid];stopped=true;}
      if(battleshipGames[cid]){delete battleshipGames[cid];stopped=true;}
      if(scrambleGames[cid]){delete scrambleGames[cid];stopped=true;}
      if(emojiDecodeGames[cid]){delete emojiDecodeGames[cid];stopped=true;}
      if(fastTypeGames[cid]){delete fastTypeGames[cid];stopped=true;}
      if(rpsGames[cid]){delete rpsGames[cid];stopped=true;}
      if(pokerGames[cid]){delete pokerGames[cid];stopped=true;}
      if(quizShowdownGames[cid]){delete quizShowdownGames[cid];stopped=true;}
      if(wordBombGames[cid]){delete wordBombGames[cid];stopped=true;}
      if(murderGames[cid]){delete murderGames[cid];stopped=true;}
      if(teamTriviaGames[cid]){delete teamTriviaGames[cid];stopped=true;}
      if(bjGames[uid]){delete bjGames[uid];stopped=true;}
      if(minesGames[uid]){delete minesGames[uid];stopped=true;}
      if(snakeGames[uid]){delete snakeGames[uid];stopped=true;}
      if(game2048[uid]){delete game2048[uid];stopped=true;}
      if(memoryGames[uid]){delete memoryGames[uid];stopped=true;}
      if(holGames[uid]){delete holGames[uid];stopped=true;}
      if(dicePokerGames[uid]){delete dicePokerGames[uid];stopped=true;}
      message.reply({embeds:[stopped?successEmbed('🛑 Game Stopped','All active games in this channel/for this user have been ended.'):errorEmbed('No active games found in this channel.')]});
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
