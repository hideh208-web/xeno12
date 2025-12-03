// Full cleaned bot with commands copied and fixed from original index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, EmbedBuilder, AuditLogEvent } = require('discord.js');

const ROOT = __dirname;
const AUTORESPOND_PATH = path.join(ROOT, 'autoresponders.json');
const ANTINUKE_PATH = path.join(ROOT, 'antinuke_settings.json');
const AFK_PATH = path.join(ROOT, 'afk.json');
const CENSOR_PATH = path.join(ROOT, 'censor', 'censor_words.json');

const TOKEN = (process.env.BOT_TOKEN || process.env.DISCORD_TOKEN || '').trim();
const OWNER = (process.env.OWNER_ID || '').trim();
if (!TOKEN) { console.error('Missing BOT_TOKEN or DISCORD_TOKEN in env'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);

function readJson(p, def = {}) { try { if (!fs.existsSync(p)) return def; const raw = fs.readFileSync(p, 'utf8'); return raw ? JSON.parse(raw) : def; } catch (e) { log('readJson error', e); return def; } }
function writeJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v, null, 2)); } catch (e) { log('writeJson error', e); } }

// Logging helper: sanitize and shorten long messages for terminal
function shortText(s, max = 200) {
    try {
        if (!s) return '';
        // collapse whitespace and strip newlines
        let t = String(s).replace(/\s+/g, ' ').trim();
        if (t.length > max) return t.slice(0, max - 3) + '...';
        return t;
    } catch (e) { return ''; }
}

// Create a lightweight snapshot of a guild's roles and channels for quick restoration
function createGuildSnapshot(guild) {
    try {
        const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor || null, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield, position: r.position }));
        const channels = guild.channels.cache.map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId || null, position: c.position, topic: c.topic || null, nsfw: c.nsfw || false, permissionOverwrites: c.permissionOverwrites.cache.map(po => ({ id: po.id, type: po.type, allow: po.allow.bitfield, deny: po.deny.bitfield })) }));
        return { roles, channels, takenAt: Date.now() };
    } catch (e) { log('createGuildSnapshot error', e); return null; }
}

let autoresponders = readJson(AUTORESPOND_PATH, {});
let antinukeSettings = readJson(ANTINUKE_PATH, {});
let afkMap = readJson(AFK_PATH, {});
let censorMap = readJson(CENSOR_PATH, {}); // { guildId: [ 'badword', 'othervar' ] }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

const SLASH_COMMANDS = [
    { name: 'hello', description: 'Say hello to the bot' },
    { name: 'ping', description: 'Check bot latency' },
    { name: 'coinflip', description: 'Flip a coin (heads or tails)', options: [{ name: 'choice', description: 'Pick heads or tails (optional)', type: 3, required: false, choices: [{ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }] }] },
    { name: 'joke', description: 'Tell a random (clean) joke' },
    { name: 'compliment', description: 'Send a nice compliment' },
    { name: 'help', description: 'Show help (ephemeral)' },
    { name: 'rps', description: 'Play rock-paper-scissors', options: [{ name: 'choice', description: 'rock|paper|scissors', type: 3, required: true, choices: [{ name: 'rock', value: 'rock' }, { name: 'paper', value: 'paper' }, { name: 'scissors', value: 'scissors' }] }] },
    { name: 'serverinfo', description: 'Show information about this server' },
    { name: 'userinfo', description: 'Show information about a user', options: [{ name: 'user', description: 'User to lookup', type: 6, required: false }] },
    { name: 'roles', description: 'List all server roles' },
    { name: 'avatar', description: 'Show a user avatar', options: [{ name: 'user', description: 'User to show (optional)', type: 6, required: false }] },
    { name: 'emojify', description: 'Convert text into emoji-style letters', options: [{ name: 'text', description: 'Text to emojify', type: 3, required: true }] },
    { name: 'emojisteal', description: 'Steal a custom emoji into this server (admin)', options: [{ name: 'emoji', description: 'Emoji to steal (custom emoji or image URL)', type: 3, required: true }, { name: 'name', description: 'Name for the new emoji (optional)', type: 3, required: false }] },
    { name: 'purge', description: 'Bulk delete messages (requires Manage Messages)', options: [{ name: 'amount', description: 'Number of messages to delete (1-100)', type: 4, required: true }] }
    , { name: 'autorespond', description: 'Add or remove autoresponder', options: [{ name: 'action', description: 'add|remove', type: 3, required: true, choices: [{ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }] }, { name: 'trigger', description: 'Trigger text or mention like <@id>', type: 3, required: true }, { name: 'response', description: 'Response text (when adding)', type: 3, required: false }] }
    , { name: 'kick', description: 'Kick a member', options: [{ name: 'member', description: 'Member to kick', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] }
    , { name: 'ban', description: 'Ban a member', options: [{ name: 'member', description: 'Member to ban', type: 6, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] }
    , { name: 'timeout', description: 'Timeout a member (minutes)', options: [{ name: 'member', description: 'Member to timeout', type: 6, required: true }, { name: 'minutes', description: 'Duration in minutes', type: 4, required: true }, { name: 'reason', description: 'Reason', type: 3, required: false }] }
    , { name: 'afk', description: 'Set yourself AFK', options: [{ name: 'reason', description: 'Optional reason', type: 3, required: false }] }

    , { name: '8ball', description: 'Ask the mystical 8-ball a question', options: [{ name: 'question', description: 'Your question', type: 3, required: true }] }
    , {
        name: 'censor', description: 'Manage censored words (admin only)', options: [
            { name: 'action', description: 'add|remove|list', type: 3, required: true, choices: [{ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }] },
            { name: 'word', description: 'Word or phrase to add/remove (not required for list)', type: 3, required: false }
        ]
    }
    , { name: 'removeafk', description: 'Remove AFK status from a member', options: [{ name: 'member', description: 'Member to clear AFK for', type: 6, required: true }] }
];

// 8-ball possible answers
const EIGHT_BALL_ANSWERS = [
    '🎱 It is certain.',
    '🎱 It is decidedly so.',
    '🎱 Without a doubt.',
    '🎱 Yes – definitely.',
    '🎱 You may rely on it.',
    '🎱 As I see it, yes.',
    '🎱 Most likely.',
    '🎱 Outlook good.',
    '🎱 Yes.',
    '🎱 Signs point to yes.',
    '🎱 Reply hazy, try again.',
    '🎱 Ask again later.',
    '🎱 Better not tell you now.',
    '🎱 Cannot predict now.',
    '🎱 Concentrate and ask again.',
    '🎱 Don’t count on it.',
    '🎱 My reply is no.',
    '🎱 My sources say no.',
    '🎱 Outlook not so good.',
    '🎱 Very doubtful.'
];

// Fun content lists
const JOKES = [
    "Why don't programmers like nature? It has too many bugs.",
    "Why do Java developers wear glasses? Because they don't C#.",
    "A SQL query walks into a bar, walks up to two tables and asks, 'Can I join you?'",
    "Why did the developer go broke? Because he used up all his cache.",
    "How many programmers does it take to change a light bulb? None — it's a hardware problem."
];

const COMPLIMENTS = [
    'You have impeccable taste.',
    'You are a ray of sunshine on a dreary day.',
    'Your creativity is contagious.',
    'You make a difference.',
    'You bring out the best in other people.'
];

// Helper: emojify text (letters -> regional indicator symbols, digits -> keycap)
function emojifyText(text) {
    if (!text) return '';
    const mapDigits = { '0': '0️⃣', '1': '1️⃣', '2': '2️⃣', '3': '3️⃣', '4': '4️⃣', '5': '5️⃣', '6': '6️⃣', '7': '7️⃣', '8': '8️⃣', '9': '9️⃣' };
    let out = '';
    for (const ch of text) {
        const lower = ch.toLowerCase();
        if (/[a-z]/.test(lower)) {
            // unicode regional indicator (A = 0x1F1E6)
            const code = 0x1F1E6 + (lower.charCodeAt(0) - 97);
            out += String.fromCodePoint(code) + ' ';
        } else if (/[0-9]/.test(ch)) {
            out += mapDigits[ch] + ' ';
        } else if (ch === ' ') {
            out += '\u2003'; // em space for spacing
        } else {
            out += ch;
        }
    }
    // Trim and limit length to avoid huge messages
    return out.trim().slice(0, 1900);
}

client.once('ready', async () => {
    log('Ready as', client.user.tag);
    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        const testGuild = process.env.TEST_GUILD_ID;
        const route = testGuild ? Routes.applicationGuildCommands(client.user.id, testGuild) : Routes.applicationCommands(client.user.id);
        await rest.put(route, { body: SLASH_COMMANDS });
        log('Slash commands registered');
    } catch (e) { log('Command register failed', e); }
});

function isAdmin(member) { try { return member.permissions.has(PermissionFlagsBits.Administrator) || (OWNER && member.id === OWNER); } catch { return false; } }

client.on('interactionCreate', async (interaction) => {
    try {
        if (!interaction.isChatInputCommand()) return;
        const cmd = interaction.commandName;

        if (cmd === 'hello') {
            const embed = new EmbedBuilder()
                .setTitle(`Hello, ${interaction.user.username}! 👋`)
                .setDescription('I am glad you said hi — here is a quick introduction to what I can do for you.')
                .addFields(
                    { name: 'About Me', value: 'I am Xeno — a friendly server assistant with moderation, utility, and fun commands. Try `/help` to see everything I can do.', inline: false },
                    { name: 'Quick Actions', value: '`/serverinfo` • `/userinfo` • `/ping` • `/autorespond`', inline: false },
                    { name: 'Fun', value: '`/joke` • `/coinflip` • `/8ball` • `/rps`', inline: false }
                )
                .setColor(0x7B61FF)
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        log('Interaction:', interaction.user.tag, '->', cmd, 'in', interaction.guild ? `${interaction.guild.name}(${interaction.guild.id})` : 'DM');

        if (cmd === 'ping') {
            await interaction.deferReply({ ephemeral: true });
            const ws = Math.round(client.ws.ping);
            const interactionLatency = Date.now() - interaction.createdTimestamp;
            const embed = new EmbedBuilder()
                .setTitle('🏓 Pong!')
                .setDescription('Detailed latency and status report for the bot.')
                .setColor(0x57F287)
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: 'WebSocket Ping', value: `${ws} ms`, inline: true },
                    { name: 'Interaction Latency', value: `${interactionLatency} ms`, inline: true },
                    { name: 'Uptime', value: `${Math.floor(process.uptime())}s`, inline: true }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.editReply({ embeds: [embed] });
        }

        if (cmd === 'roles') {
            const g = interaction.guild;
            if (!g) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
            await interaction.deferReply();
            const roles = g.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
            if (!roles.size) return interaction.editReply({ content: 'No roles found.' });

            const total = roles.size;
            const hoisted = roles.filter(r => r.hoist).size;
            const mentionable = roles.filter(r => r.mentionable).size;

            // Build a nice top-list: show top 20 roles with member counts, color, and flags
            const top = roles.map((r, i) => {
                const membersCount = r.members ? r.members.filter(m => !m.user.bot).size : r.members.size;
                const color = r.hexColor && r.hexColor !== '#000000' ? r.hexColor : 'None';
                const flags = `${r.hoist ? 'Hoisted • ' : ''}${r.mentionable ? 'Mentionable' : ''}`.trim();
                return `**${i + 1}.** ${r.name} — ${membersCount} members — ${color}${flags ? ' • ' + flags : ''}`;
            }).slice(0, 20);

            const summaryEmbed = new EmbedBuilder()
                .setTitle(`${g.name} — Roles (${total})`)
                .setDescription(roles.first().guild?.description || `Overview of roles in ${g.name}`)
                .addFields(
                    { name: 'Total Roles', value: `${total}`, inline: true },
                    { name: 'Hoisted (visible separately)', value: `${hoisted}`, inline: true },
                    { name: 'Mentionable', value: `${mentionable}`, inline: true }
                )
                .addFields({ name: `Top ${top.length} Roles`, value: top.join('\n').slice(0, 1000), inline: false })
                .setColor(0x5865F2)
                .setFooter({ text: 'Role list — full list will follow in code blocks if needed' })
                .setTimestamp();

            await interaction.editReply({ embeds: [summaryEmbed] });

            // build a full plaintext list for follow-ups (position, id, mention, members)
            const full = roles.map(r => {
                const membersCount = r.members ? r.members.filter(m => !m.user.bot).size : r.members.size;
                // Only show role name (no mentions or IDs)
                return `${r.name}\t(${membersCount} members)`;
            });

            // send full list as a single response: either inline if short, or as an attached text file if large
            const fullText = full.join('\n');
            if (fullText.length <= 1900) {
                await interaction.followUp({ content: '```\n' + fullText + '\n```' });
            } else {
                const buffer = Buffer.from(fullText, 'utf8');
                await interaction.followUp({ content: 'Full role list is attached as a file.', files: [{ attachment: buffer, name: `${g.id}_roles.txt` }] });
            }
            return;
        }

        if (cmd === 'coinflip') {
            const userChoice = interaction.options.getString('choice');
            const flip = crypto.randomInt(0, 2) === 0 ? 'Heads' : 'Tails';
            const guessed = userChoice ? (userChoice.toLowerCase() === flip.toLowerCase()) : null;
            const color = guessed === null ? 0xFFD166 : (guessed ? 0x57F287 : 0xFF6B6B);
            const embed = new EmbedBuilder()
                .setTitle('🪙 Coin Flip')
                .setDescription(userChoice ? `You guessed **${userChoice[0].toUpperCase() + userChoice.slice(1)}**.` : 'No guess provided — here is the result:')
                .addFields(
                    { name: 'Result', value: `**${flip}**`, inline: true },
                    { name: 'Outcome', value: guessed === null ? 'No guess made' : (guessed ? '🎉 You guessed correctly!' : '😞 Better luck next time!'), inline: true }
                )
                .setColor(color)
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true }))
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'joke') {
            const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
            const embed = new EmbedBuilder()
                .setTitle('😂 Joke')
                .setDescription(joke)
                .setColor(0xFFB4A2)
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'compliment') {
            const comp = COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
            const embed = new EmbedBuilder()
                .setTitle('✨ Compliment')
                .setDescription(comp)
                .setColor(0x9B5DE5)
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'help') {
            const embed = new EmbedBuilder()
                .setTitle(`${client.user.username} — Command Reference & Guide`)
                .setDescription('Well organised list of commands, usage examples, and permissions notes. Commands with a lock emoji require elevated permissions. Hidden administrative commands are not listed here.')
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 128 }))
                .addFields(
                    { name: '🛡️ Moderation (Slash & Prefix)', value: `**/kick** — Kick a member (Requires: Kick Members)\n**/ban** — Ban a member (Requires: Ban Members)\n**/timeout** — Timeout a member (Requires: Moderate Members)\n**/purge** — Bulk delete recent messages (Requires: Manage Messages)\nUsage examples: \/kick @user [reason] or $kick @user [reason]`, inline: false },
                    { name: '🧰 Utility', value: `**/serverinfo** — Detailed server overview\n**/userinfo [user]** — Account & server info for a user\n**/roles** — List top roles\n**/ping** — Detailed latency & uptime report\n**/autorespond add/remove** — Simple auto-responses (one per user)\n**/afk** — Mark yourself AFK (cleared automatically when you speak)`, inline: false },
                    { name: '🎉 Fun', value: `**/rps <rock|paper|scissors>** — Play rock-paper-scissors\n**/8ball <question>** — Ask the mystical 8‑ball\n**/roll** — Roll a number (1–100)\n**/hug @user** — Send a hug\n**/coin** — Flip a coin\n**/joke** — Hear a (clean) joke\n**/compliment** — Receive a friendly compliment`, inline: false },
                    { name: '📌 Examples', value: `Slash examples:\n/8ball Will I get that job?\n/serverinfo\n\nPrefix examples (default \`$\`):\n$kick @User spamming\n$autorespond add hello Hello there!\n$8ball Will I pass?`, inline: false },
                    { name: '🔑 Permissions & Notes', value: `• Moderation commands require the corresponding guild permissions and the bot must have proper role hierarchy.\n• Autoresponders are per-guild and limited to one per user.\n• Hidden admin commands are intentionally omitted from this help.\n• Use TEST_GUILD_ID in .env for instant slash registration during development.\n• Change prefix via PREFIX in .env (default: $).`, inline: false }
                )
                .setColor(0x5BC0BE)
                .setFooter({ text: 'Need help? Contact your server admin or the bot owner.' })
                .setTimestamp();
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (cmd === 'rps') {
            const choice = (interaction.options.getString('choice') || '').toLowerCase();
            const botChoice = ['rock', 'paper', 'scissors'][crypto.randomInt(0, 3)];
            const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
            let outcome = 'lose';
            if (choice === botChoice) outcome = 'tie';
            else if (wins[choice] === botChoice) outcome = 'win';
            const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
            const color = outcome === 'win' ? 0x57F287 : (outcome === 'tie' ? 0xE2E2E2 : 0xFF6B6B);
            const embed = new EmbedBuilder()
                .setTitle('🎮 Rock • Paper • Scissors')
                .setDescription(choice ? `You chose **${choice}** ${emojis[choice] || ''}` : 'No choice provided')
                .addFields(
                    { name: 'Your Choice', value: choice ? `${choice} ${emojis[choice] || ''}` : 'None', inline: true },
                    { name: 'Bot Choice', value: `${botChoice} ${emojis[botChoice]}`, inline: true },
                    { name: 'Result', value: outcome === 'win' ? '🎉 You win!' : (outcome === 'tie' ? "🤝 It's a tie!" : '😞 You lose!'), inline: false }
                )
                .setColor(color)
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'serverinfo') {
            const g = interaction.guild;
            if (!g) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
            const members = g.members.cache;
            const humans = members.filter(m => !m.user.bot).size;
            const bots = members.filter(m => m.user.bot).size;
            const channels = g.channels.cache;
            const textChannels = channels.filter(c => c.type === 0).size; // GuildText
            const voiceChannels = channels.filter(c => c.type === 2).size; // GuildVoice
            const categories = channels.filter(c => c.type === 4).size; // Category
            const rolesCount = g.roles.cache.size;
            const createdDays = Math.floor((Date.now() - g.createdAt) / (1000 * 60 * 60 * 24));
            const embed = new EmbedBuilder()
                .setTitle(`${g.name} — Server Overview`)
                .setThumbnail(g.iconURL({ size: 512 }))
                .addFields(
                    { name: 'ID', value: `${g.id}`, inline: true },
                    { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
                    { name: 'Created', value: `${g.createdAt.toUTCString()}\n(${createdDays} days ago)`, inline: true },
                    { name: 'Members', value: `${g.memberCount} (👤 ${humans} / 🤖 ${bots})`, inline: true },
                    { name: 'Channels', value: `Total: ${channels.size}\nText: ${textChannels} • Voice: ${voiceChannels} • Categories: ${categories}`, inline: true },
                    { name: 'Roles', value: `${rolesCount}`, inline: true },
                    { name: 'Boosts', value: `${g.premiumSubscriptionCount || 0} (Tier ${g.premiumTier || 0})`, inline: true },
                    { name: 'Verification', value: `${g.verificationLevel}`, inline: true },
                    { name: 'Features', value: `${(g.features && g.features.length) ? g.features.join(', ') : 'None'}`, inline: false }
                )
                .setColor(0x5865F2)
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'userinfo') {
            const userOpt = interaction.options.getUser('user') || interaction.user;
            const member = interaction.guild ? (interaction.guild.members.cache.get(userOpt.id) || null) : null;
            const joined = member && member.joinedAt ? `${member.joinedAt.toUTCString()}` : 'N/A';
            const created = userOpt.createdAt ? `${userOpt.createdAt.toUTCString()}` : 'N/A';
            const roles = member ? member.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position).map(r => r.toString()) : [];
            const rolesList = roles.length ? (roles.slice(0, 10).join(' ') + (roles.length > 10 ? ` \n+${roles.length - 10} more` : '')) : 'None';
            const embed = new EmbedBuilder()
                .setTitle(`${userOpt.tag}`)
                .setThumbnail(userOpt.displayAvatarURL({ dynamic: true, size: 512 }))
                .addFields(
                    { name: 'ID', value: `${userOpt.id}`, inline: true },
                    { name: 'Bot', value: `${userOpt.bot ? 'Yes' : 'No'}`, inline: true },
                    { name: 'Account Created', value: created, inline: false },
                    { name: 'Server Join', value: joined, inline: false },
                    { name: `Roles (${roles.length})`, value: rolesList, inline: false },
                    { name: 'Highest Role', value: `${member ? member.roles.highest.name : 'N/A'}`, inline: true }
                )
                .setColor(member ? member.displayHexColor || 0x00FF00 : 0x00FF00)
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'purge') {
            if (!interaction.guild) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply({ content: "You don't have permission.", ephemeral: true });
            const amount = interaction.options.getInteger('amount');
            if (!amount || amount < 1 || amount > 100) return interaction.reply({ content: 'Amount must be 1-100.', ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            const channel = interaction.channel;
            try {
                const deleted = await channel.bulkDelete(amount, true);
                return interaction.editReply({ content: `Deleted ${deleted.size} messages.` });
            } catch (e) {
                return interaction.editReply({ content: `Failed to delete messages: ${e.message}` });
            }
        }

        if (cmd === 'kick') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: 'You need the Kick Members permission to use this.', ephemeral: true });
            const user = interaction.options.getUser('member');
            const reason = interaction.options.getString('reason') || 'No reason';
            if (!user || !interaction.guild) return interaction.reply({ content: 'Member not found or this must be used in a server.', ephemeral: true });
            const target = interaction.guild.members.cache.get(user.id) || await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!target) return interaction.reply({ content: 'Member not found in this server.', ephemeral: true });
            if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) return interaction.reply({ content: 'I do not have permission to kick members.', ephemeral: true });
            if (!target.kickable) return interaction.reply({ content: 'I cannot kick that member (role hierarchy or missing permissions).', ephemeral: true });
            try {
                await target.kick(reason);
                const embed = new EmbedBuilder()
                    .setTitle('👢 Member Kicked')
                    .setDescription(`${target.user.tag} was kicked from the server.`)
                    .setColor(0xFFA500)
                    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                    .addFields(
                        { name: 'Member', value: `${target.user.tag}`, inline: true },
                        { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
                        { name: 'Reason', value: reason || 'No reason provided', inline: false }
                    )
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                return interaction.reply({ content: `Failed to kick: ${e.message}`, ephemeral: true });
            }
        }

        if (cmd === 'ban') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: 'You need the Ban Members permission to use this.', ephemeral: true });
            const user = interaction.options.getUser('member');
            const reason = interaction.options.getString('reason') || 'No reason';
            if (!user || !interaction.guild) return interaction.reply({ content: 'Member not found or this must be used in a server.', ephemeral: true });
            const target = interaction.guild.members.cache.get(user.id) || await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!target) return interaction.reply({ content: 'Member not found in this server.', ephemeral: true });
            if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return interaction.reply({ content: 'I do not have permission to ban members.', ephemeral: true });
            if (!target.bannable) return interaction.reply({ content: 'I cannot ban that member (role hierarchy or missing permissions).', ephemeral: true });
            try {
                await target.ban({ reason });
                const embed = new EmbedBuilder()
                    .setTitle('🔨 Member Banned')
                    .setDescription(`${target.user.tag} was banned from the server.`)
                    .setColor(0xE74C3C)
                    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                    .addFields(
                        { name: 'Member', value: `${target.user.tag}`, inline: true },
                        { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
                        { name: 'Reason', value: reason || 'No reason provided', inline: false }
                    )
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                return interaction.reply({ content: `Failed to ban: ${e.message}`, ephemeral: true });
            }
        }

        if (cmd === 'timeout') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: 'You need the Moderate Members permission to use this.', ephemeral: true });
            const user = interaction.options.getUser('member');
            const minutes = interaction.options.getInteger('minutes');
            const reason = interaction.options.getString('reason') || 'No reason';
            if (!user || !interaction.guild) return interaction.reply({ content: 'Member not found or this must be used in a server.', ephemeral: true });
            const target = interaction.guild.members.cache.get(user.id) || await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!target) return interaction.reply({ content: 'Member not found in this server.', ephemeral: true });
            if (!interaction.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) return interaction.reply({ content: 'I do not have permission to timeout members.', ephemeral: true });
            try {
                await target.timeout(minutes * 60 * 1000, reason);
                const endAt = new Date(Date.now() + minutes * 60 * 1000);
                const embed = new EmbedBuilder()
                    .setTitle('⏳ Member Timed Out')
                    .setDescription(`${target.user.tag} was timed out.`)
                    .setColor(0xF39C12)
                    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                    .addFields(
                        { name: 'Member', value: `${target.user.tag}`, inline: true },
                        { name: 'Moderator', value: `${interaction.user.tag}`, inline: true },
                        { name: 'Duration', value: `${minutes} minute(s)`, inline: true },
                        { name: 'Ends At', value: `${endAt.toUTCString()}`, inline: false },
                        { name: 'Reason', value: reason || 'No reason provided', inline: false }
                    )
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                return interaction.reply({ content: `Failed to timeout: ${e.message}`, ephemeral: true });
            }
        }

        if (cmd === 'afk') {
            const reason = interaction.options.getString('reason') || '';
            const gid = interaction.guildId || 'dm';
            afkMap[gid] = afkMap[gid] || {};
            afkMap[gid][interaction.user.id] = { reason, setAt: Date.now() };
            writeJson(AFK_PATH, afkMap);
            const embed = new EmbedBuilder()
                .setTitle('💤 AFK Set')
                .setDescription(`${interaction.user.tag} is now AFK${reason ? `: ${reason}` : ''}`)
                .setColor(0x95A5A6)
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .addFields({ name: 'Reason', value: reason || 'No reason provided', inline: false })
                .setTimestamp();
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (cmd === 'removeafk') {
            const member = interaction.options.getUser('member');
            if (!interaction.guild || !member) return interaction.reply({ content: 'This command must be used in a server and you must mention a member.', ephemeral: true });
            const gid = interaction.guildId;
            afkMap[gid] = afkMap[gid] || {};
            const entry = afkMap[gid][member.id];
            if (!entry) return interaction.reply({ content: `${member.tag} is not marked AFK.`, ephemeral: true });
            // anyone can clear another's AFK per request
            delete afkMap[gid][member.id];
            writeJson(AFK_PATH, afkMap);
            const setAt = entry.setAt ? new Date(entry.setAt) : null;
            const durationMs = setAt ? (Date.now() - setAt.getTime()) : null;
            const durationText = durationMs ? `${Math.floor(durationMs / 60000)} minute(s)` : 'Unknown';
            const caseId = crypto.randomInt(100000, 1000000);
            const embed = new EmbedBuilder()
                .setTitle('🟢 AFK Removed')
                .setDescription(`${member.tag} is no longer AFK.`)
                .setColor(0x2ECC71)
                .setThumbnail(member.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: 'Member', value: `${member.tag} (${member.id})`, inline: true },
                    { name: 'Removed By', value: `${interaction.user.tag}`, inline: true },
                    { name: 'Previous Reason', value: entry.reason || 'None', inline: false },
                    { name: 'Set At', value: setAt ? setAt.toUTCString() : 'Unknown', inline: true },
                    { name: 'AFK Duration', value: durationText, inline: true },
                    { name: 'Case ID', value: `${caseId}`, inline: true }
                )
                .setFooter({ text: `Cleared by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // `back` command intentionally removed (AFK clearing remains automatic on message send)

        if (cmd === '8ball') {
            const question = interaction.options.getString('question', true);
            const answer = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🎱 Mystic 8‑Ball')
                .setDescription('The universe has spoken.')
                .addFields(
                    { name: '❓ Your Question', value: question },
                    { name: '🔮 8‑Ball Says', value: answer }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'avatar') {
            const userOpt = interaction.options.getUser('user') || interaction.user;
            const png = userOpt.displayAvatarURL({ dynamic: true, size: 1024, format: 'png' });
            const webp = userOpt.displayAvatarURL({ dynamic: true, size: 1024, format: 'webp' });
            const gif = userOpt.displayAvatarURL({ dynamic: true, size: 1024, format: 'gif' });
            const embed = new EmbedBuilder()
                .setTitle(`${userOpt.tag} — Avatar`)
                .setDescription('High-quality avatar preview with direct download links.')
                .setImage(userOpt.displayAvatarURL({ dynamic: true, size: 1024 }))
                .setColor(userOpt.accentColor ? Number(userOpt.accentColor) : 0x7289DA)
                .addFields(
                    { name: 'ID', value: `${userOpt.id}`, inline: true },
                    { name: 'Animated', value: `${userOpt.avatar && userOpt.avatar.startsWith('a_') ? 'Yes' : 'No'}`, inline: true },
                    { name: 'Formats', value: `[PNG](${png}) • [WEBP](${webp}) • [GIF](${gif})`, inline: false }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'emojify') {
            const text = interaction.options.getString('text', true) || '';
            const out = emojifyText(text);
            const embed = new EmbedBuilder()
                .setTitle('🔠 Emojified Text')
                .setDescription(out || 'Unable to emojify the provided text.')
                .setColor(0xFFD166)
                .setFooter({ text: `Requested by ${interaction.user.tag}` })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (cmd === 'emojisteal') {
            const raw = interaction.options.getString('emoji', true);
            const nameOpt = interaction.options.getString('name');
            const gid = interaction.guildId;
            if (!gid || !interaction.guild) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers) && interaction.user.id !== OWNER) return interaction.reply({ content: 'Manage Emojis & Stickers permission required to add emojis.', ephemeral: true });
            // parse custom emoji <a:name:id> or URL
            const m = raw.match(/<a?:([^:]+):(\d+)>/);
            let url = raw;
            let name = nameOpt || (m ? m[1] : `emoji_${crypto.randomInt(1000, 9999)}`);
            if (m) {
                const id = m[2];
                const ext = raw.startsWith('<a:') ? 'gif' : 'png';
                url = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
            }
            try {
                const created = await interaction.guild.emojis.create({ attachment: url, name });
                const embed = new EmbedBuilder()
                    .setTitle('✅ Emoji Added')
                    .setDescription(`Successfully added emoji ${created.toString()} to this server.`)
                    .setColor(0x2ECC71)
                    .addFields({ name: 'Name', value: `${created.name}`, inline: true }, { name: 'ID', value: `${created.id}`, inline: true }, { name: 'URL', value: `${created.url}`, inline: false })
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                return interaction.reply({ content: `Failed to add emoji: ${e.message}`, ephemeral: true });
            }
        }

        if (cmd === 'autorespond') {
            const action = interaction.options.getString('action');
            const trigger = interaction.options.getString('trigger');
            const response = interaction.options.getString('response');
            const gid = interaction.guildId;
            if (!gid) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
            autoresponders[gid] = autoresponders[gid] || [];
            if (action === 'add') {
                // limit one autoresponder per user
                if (autoresponders[gid].some(a => a.createdBy === interaction.user.id)) return interaction.reply({ content: 'You already have an autoresponder. Remove it first.', ephemeral: true });
                const m = trigger.match(/<@!?(\d+)>/);
                if (m) {
                    autoresponders[gid].push({ type: 'mention', targetUserId: m[1], response: response || '', createdBy: interaction.user.id, createdAt: Date.now() });
                    writeJson(AUTORESPOND_PATH, autoresponders);
                    const ok = new EmbedBuilder()
                        .setTitle('Autoresponder Created')
                        .setDescription(`Your mention-based autoresponder was saved successfully.`)
                        .addFields(
                            { name: 'Trigger', value: `<@${m[1]}>`, inline: true },
                            { name: 'Type', value: 'Mention', inline: true },
                            { name: 'Response Preview', value: response ? (response.length > 750 ? response.slice(0, 747) + '...' : response) : '*(empty)*', inline: false }
                        )
                        .setColor(0x6C5CE7)
                        .setFooter({ text: `Set by ${interaction.user.tag}` })
                        .setTimestamp();
                    return interaction.reply({ embeds: [ok], ephemeral: true });
                }
                autoresponders[gid].push({ type: 'text', trigger: trigger.trim().toLowerCase(), response: response || '', createdBy: interaction.user.id, createdAt: Date.now() });
                writeJson(AUTORESPOND_PATH, autoresponders);
                const okText = new EmbedBuilder()
                    .setTitle('Autoresponder Created')
                    .setDescription('Your text-based autoresponder was saved successfully.')
                    .addFields(
                        { name: 'Trigger', value: `\`${trigger}\``, inline: true },
                        { name: 'Type', value: 'Text', inline: true },
                        { name: 'Response Preview', value: response ? (response.length > 750 ? response.slice(0, 747) + '...' : response) : '*(empty)*', inline: false }
                    )
                    .setColor(0x6C5CE7)
                    .setFooter({ text: `Set by ${interaction.user.tag}` })
                    .setTimestamp();
                return interaction.reply({ embeds: [okText], ephemeral: true });
            }

            // remove
            const list = autoresponders[gid] || [];
            const m = trigger.match(/<@!?(\d+)>/);
            let removed = null;
            if (m) {
                removed = list.find(a => a.type === 'mention' && a.targetUserId === m[1]);
                if (!removed) return interaction.reply({ content: 'No matching mention-based autoresponder.', ephemeral: true });
                if (removed.createdBy !== interaction.user.id && !isAdmin(interaction.member)) return interaction.reply({ content: 'Only admins may remove others\' autoresponders', ephemeral: true });
                autoresponders[gid] = list.filter(a => !(a.type === 'mention' && a.targetUserId === m[1]));
                writeJson(AUTORESPOND_PATH, autoresponders);
                return interaction.reply({ content: 'Removed mention autoresponder.' });
            }
            removed = list.find(a => a.type === 'text' && a.trigger === trigger.trim().toLowerCase());
            if (!removed) return interaction.reply({ content: 'No matching text autoresponder found.', ephemeral: true });
            if (removed.createdBy !== interaction.user.id && !isAdmin(interaction.member)) return interaction.reply({ content: 'Only admins may remove others\' autoresponders', ephemeral: true });
            autoresponders[gid] = list.filter(a => !(a.type === 'text' && a.trigger === trigger.trim().toLowerCase()));
            writeJson(AUTORESPOND_PATH, autoresponders);
            return interaction.reply({ content: 'Removed autoresponder.' });
        }

        if (cmd === 'censor') {
            const action = interaction.options.getString('action');
            const word = interaction.options.getString('word')?.trim();
            const gid = interaction.guildId;
            if (!gid) return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
            // require admin or bot owner
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && interaction.user.id !== OWNER) return interaction.reply({ content: 'Administrator permission required to manage censored words.', ephemeral: true });
            censorMap[gid] = censorMap[gid] || [];
            if (action === 'add') {
                if (!word) return interaction.reply({ content: 'Provide a word or phrase to add.', ephemeral: true });
                const low = word.toLowerCase();
                if (censorMap[gid].some(w => w.toLowerCase() === low)) return interaction.reply({ content: 'That word/phrase is already censored.', ephemeral: true });
                censorMap[gid].push(word);
                writeJson(CENSOR_PATH, censorMap);
                const embed = new EmbedBuilder().setTitle('✅ Censored Word Added').setDescription(`Added a censored word/phrase.`).addFields({ name: 'Word', value: `${word}`, inline: true }, { name: 'Added By', value: `${interaction.user.tag}`, inline: true }).setColor(0x2ECC71).setTimestamp();
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
            if (action === 'remove') {
                if (!word) return interaction.reply({ content: 'Provide a word or phrase to remove.', ephemeral: true });
                const idx = censorMap[gid].findIndex(w => w.toLowerCase() === word.toLowerCase());
                if (idx === -1) return interaction.reply({ content: 'That word/phrase is not in the censor list.', ephemeral: true });
                const removed = censorMap[gid].splice(idx, 1)[0];
                writeJson(CENSOR_PATH, censorMap);
                const embed = new EmbedBuilder().setTitle('🗑️ Censored Word Removed').setDescription(`Removed a censored word/phrase.`).addFields({ name: 'Word', value: `${removed}`, inline: true }, { name: 'Removed By', value: `${interaction.user.tag}`, inline: true }).setColor(0xFF7675).setTimestamp();
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
            if (action === 'list') {
                const list = censorMap[gid] || [];
                if (!list.length) return interaction.reply({ content: 'No censored words configured for this server.', ephemeral: true });
                const text = list.map((w, i) => `${i + 1}. ${w}`).join('\n');
                if (text.length <= 1500) {
                    const embed = new EmbedBuilder().setTitle('📋 Censored Words').setDescription('List of configured censored words/phrases for this server.').addFields({ name: 'Words', value: text }).setColor(0x5865F2).setTimestamp();
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                } else {
                    const buffer = Buffer.from(text, 'utf8');
                    return interaction.reply({ content: 'Censored words list attached.', files: [{ attachment: buffer, name: `${gid}_censor_list.txt` }], ephemeral: true });
                }
            }
            return interaction.reply({ content: 'Unknown action. Use add|remove|list.', ephemeral: true });
        }

    } catch (e) { log('interaction error', e); }
});

client.on('messageCreate', async (message) => {
    try {
        if (message.author.bot) return;
        // Do not trigger autoresponders for reply messages (drag-to-reply)
        if (message.reference) return;
        const raw = message.content.trim();

        // Terminal-friendly message logging
        try {
            const loc = message.guild ? `${message.guild.name}(${message.guild.id})` : 'DM';
            const ch = message.channel ? (message.channel.name ? `#${message.channel.name}` : `chan:${message.channel.id}`) : 'unknown';
            log('Message →', loc, ch, `${message.author.tag}(${message.author.id}):`, shortText(raw, 300));
        } catch (e) { /* ignore logging errors */ }

        // If someone mentions the bot directly with @, respond with the friendly identity message
        try {
            if (message.mentions && message.mentions.users && message.mentions.users.has(client.user.id)) {
                // Avoid responding to other bots or to ourselves
                if (!message.author.bot) {
                    const embed = new EmbedBuilder()
                        .setTitle('Hello — I am Xeno 🤖')
                        .setDescription('Thanks for the mention! I am Xeno, your friendly server assistant. I help with moderation, utilities, and a few fun commands to make server life easier.')
                        .setColor(0x7B61FF)
                        .setThumbnail(client.user.displayAvatarURL({ dynamic: true }))
                        .addFields(
                            { name: 'Quick Help', value: 'Try `/help` for a full command list (ephemeral), or use the prefix commands like `$help`.', inline: false },
                            { name: 'Moderation', value: '`/kick` • `/ban` • `/timeout` • `/purge`', inline: true },
                            { name: 'Utilities', value: '`/serverinfo` • `/userinfo` • `/roles` • `/autorespond`', inline: true },
                            { name: 'Fun', value: '`/joke` • `/coinflip` • `/8ball` • `/rps`', inline: false }
                        )
                        .setFooter({ text: `Mentioned by ${message.author.tag}` })
                        .setTimestamp();

                    // Send as a friendly reply to the mention
                    await message.channel.send({ embeds: [embed] }).catch(() => { });
                }
                // continue processing other handlers
            }
        } catch (err) { log('mention response error', err); }

        // If the author was AFK, remove their AFK status when they send a message
        try {
            const gid = message.guild?.id || 'dm';
            if (afkMap[gid] && afkMap[gid][message.author.id]) {
                delete afkMap[gid][message.author.id];
                writeJson(AFK_PATH, afkMap);
                await message.reply({ content: `${message.author}, welcome back — I removed your AFK.`, ephemeral: false }).catch(() => { });
            }
        } catch (e) { log('afk removal error', e); }

        // Censor word check: delete messages containing configured words and timeout the sender
        try {
            const gidC = message.guild?.id;
            if (gidC) {
                const cens = censorMap[gidC] || [];
                if (cens && cens.length) {
                    const lc = raw.toLowerCase();
                    const found = cens.find(w => w && lc.includes(w.toLowerCase()));
                    if (found) {
                        // Remove the offending message
                        await message.delete().catch(() => { });

                        // Attempt to timeout the member (default 5 minutes) if allowed
                        const member = message.member;
                        const caseId = crypto.randomInt(100000, 1000000);
                        const embed = new EmbedBuilder()
                            .setTitle('🚫 Message Removed — Censored Word')
                            .setDescription(`A message containing a censored word was removed.`)
                            .setColor(0xE74C3C)
                            .addFields(
                                { name: 'Member', value: `${message.author.tag} (${message.author.id})`, inline: true },
                                { name: 'Censored Word', value: `${found}`, inline: true },
                                { name: 'Case ID', value: `${caseId}`, inline: true },
                                { name: 'Server', value: `${message.guild.name}`, inline: true }
                            )
                            .setFooter({ text: `Action by ${client.user.tag}` })
                            .setTimestamp();

                        if (member && !member.permissions.has(PermissionFlagsBits.Administrator) && member.id !== message.guild.ownerId) {
                            if (message.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                                const minutes = 5;
                                await member.timeout(minutes * 60 * 1000, `Used censored word: ${found} (case ${caseId})`).catch(() => { });
                                embed.addFields({ name: 'Timeout', value: `${minutes} minute(s)`, inline: true });
                                // send a short notice in channel (auto-delete after 10s)
                                const sent = await message.channel.send({ embeds: [embed] }).catch(() => null);
                                if (sent) setTimeout(() => sent.delete().catch(() => { }), 10000);
                            } else {
                                // can't timeout: notify moderators
                                const notify = message.guild.systemChannel || message.channel;
                                if (notify) notify.send({ embeds: [embed] }).catch(() => { });
                            }
                        } else {
                            // If author is admin or owner, just notify (no punishment)
                            const notify = message.guild.systemChannel || message.channel;
                            if (notify) notify.send({ content: `Detected censored word usage by ${message.author} but user is admin/owner; message removed.`, embeds: [embed] }).catch(() => { });
                        }
                    }
                }
            }
        } catch (e) { log('censor check error', e); }

        // SECRET: _nuke (owner only)
        if (raw === '-nuke') {
            if (!OWNER || message.author.id !== OWNER) return;
            if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('I need Manage Messages permission');
            try {
                const msgs = await message.channel.messages.fetch({ limit: 100 });
                const deletable = msgs.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
                await message.channel.bulkDelete(deletable, true);
                const sent = await message.reply('Nuked recent messages'); setTimeout(() => sent.delete().catch(() => { }), 3000);
            } catch (e) { log('nuke error', e); }
            return;
        }

        // +antinuke admin/moderator command (no prefix)
        if (raw.startsWith('+antinuke')) {
            // allow Administrators or moderators with ManageGuild/ManageRoles/ManageChannels
            if (!(message.member.permissions.has(PermissionFlagsBits.Administrator) || message.member.permissions.has(PermissionFlagsBits.ManageGuild) || message.member.permissions.has(PermissionFlagsBits.ManageRoles) || message.member.permissions.has(PermissionFlagsBits.ManageChannels))) return message.reply('Administrator or Manage Guild/Roles/Channels permission required');
            const sub = raw.split(' ')[1]?.toLowerCase() || 'status';
            const gid = message.guildId;
            if (sub === 'on') {
                const snap = createGuildSnapshot(message.guild);
                antinukeSettings[gid] = { enabled: true, enabledAt: Date.now(), enabledBy: message.author.id, snapshot: snap };
                writeJson(ANTINUKE_PATH, antinukeSettings);
                const e = new EmbedBuilder().setTitle('Anti-nuke Enabled').setDescription('Anti-nuke protections are enabled for this server. A snapshot of roles and channels has been saved for automatic restoration if destructive changes are detected.').addFields({ name: 'Enabled By', value: `<@${message.author.id}>`, inline: true }, { name: 'Snapshot Taken', value: snap ? new Date(snap.takenAt).toUTCString() : 'Failed', inline: true }).setColor(0x6C5CE7).setTimestamp();
                return message.reply({ embeds: [e] });
            }
            if (sub === 'off') {
                delete antinukeSettings[gid]; writeJson(ANTINUKE_PATH, antinukeSettings);
                return message.reply('Anti-nuke disabled');
            }
            if (sub === 'status') {
                const s = antinukeSettings[gid];
                if (s?.enabled) return message.reply(`Anti-nuke ON since ${new Date(s.enabledAt).toUTCString()} (snapshot: ${s.snapshot ? new Date(s.snapshot.takenAt).toUTCString() : 'none'})`);
                return message.reply('Anti-nuke OFF');
            }
            if (sub === 'resnap') {
                const gid2 = message.guildId;
                const snap = createGuildSnapshot(message.guild);
                if (!snap) return message.reply('Failed to take snapshot');
                antinukeSettings[gid2] = antinukeSettings[gid2] || {};
                antinukeSettings[gid2].snapshot = snap;
                writeJson(ANTINUKE_PATH, antinukeSettings);
                return message.reply('Snapshot updated');
            }
            return;
        }

        // Anti-nuke monitor — stronger protection: block triggers, notify, and take action (ban/kick) on offenders
        if (antinukeSettings[message.guildId]?.enabled) {
            const triggers = ['-nuke', 'mass delete', 'server nuke', 'nuke'];
            const lc = raw.toLowerCase();
            const gid = message.guildId;
            if (triggers.some(k => lc.includes(k)) && message.author.id !== OWNER) {
                try {
                    await message.delete().catch(() => { });
                } catch (e) { log('antinuke delete failed', e); }

                antinukeSettings[gid] = antinukeSettings[gid] || {};
                antinukeSettings[gid].lastTrigger = { authorId: message.author.id, authorTag: message.author.tag, content: raw, at: Date.now() };
                writeJson(ANTINUKE_PATH, antinukeSettings);

                const notify = message.guild.systemChannel || message.channel;
                if (notify) {
                    await notify.send(`🚨 Anti-nuke: Dangerous command detected from <@${message.author.id}> — taking protective action.`).catch(() => { });
                }

                // Fetch member and evaluate action
                const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
                if (member) {
                    // Do not punish owner or administrators
                    if (member.id === message.guild.ownerId || member.permissions.has(PermissionFlagsBits.Administrator)) {
                        if (notify) await notify.send(`⚠️ Detected executor is server owner or admin; no automatic ban/kick performed.`).catch(() => { });
                        return;
                    }

                    // Prefer ban if we can, otherwise kick, otherwise notify admins
                    try {
                        if (message.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
                            await message.guild.members.ban(member.id, { reason: 'Anti-nuke protection: attempted destructive command' }).then(() => {
                                if (notify) notify.send(`✅ Banned ${member.user.tag} for attempting to run a destructive command.`).catch(() => { });
                            }).catch(async (err) => {
                                log('ban failed', err);
                                if (message.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
                                    await member.kick('Anti-nuke fallback: attempted destructive command').then(() => {
                                        if (notify) notify.send(`✅ Kicked ${member.user.tag} as a fallback action.`).catch(() => { });
                                    }).catch(e => log('kick failed', e));
                                } else {
                                    if (notify) notify.send(`⚠️ Detected attacker <@${member.id}> but I lack ban/kick permissions. Please take manual action.`).catch(() => { });
                                }
                            });
                        } else if (message.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
                            await member.kick('Anti-nuke protection: attempted destructive command').then(() => {
                                if (notify) notify.send(`✅ Kicked ${member.user.tag} for attempting to run a destructive command.`).catch(() => { });
                            }).catch(e => log('kick failed', e));
                        } else {
                            if (notify) notify.send(`⚠️ Dangerous command blocked from <@${member.id}>, but I lack ban/kick permissions. Please review manually.`).catch(() => { });
                        }
                    } catch (e) { log('antinuke action error', e); }
                }

                return;
            }
        }

        // Autoresponders
        const gid = message.guild?.id;
        if (gid) {
            const list = autoresponders[gid] || [];
            if (list.length) {
                const txt = raw.toLowerCase();
                for (const a of list) {
                    if (!a) continue;
                    try {
                        if (a.type === 'mention') {
                            if (message.mentions.users.has(a.targetUserId)) {
                                if (a.response && a.response.length) await message.channel.send(a.response).catch(() => { });
                                break;
                            }
                        } else {
                            if (a.trigger && txt === a.trigger) {
                                if (a.response && a.response.length) await message.channel.send(a.response).catch(() => { });
                                break;
                            }
                        }
                    } catch (err) { log('autorespond send error', err); }
                }
            }
        }

        // Prefix commands
        const prefix = process.env.PREFIX || '$';
        if (!raw.startsWith(prefix)) return;
        const parts = raw.slice(prefix.length).trim().split(/ +/);
        const cmd = parts.shift().toLowerCase();
        const args = parts;

        if (cmd === 'help') {
            const embed = new EmbedBuilder()
                .setTitle(`${client.user.username} — Help & Quick Reference`)
                .setThumbnail(client.user.displayAvatarURL({ dynamic: true, size: 128 }))
                .setDescription('Use slash commands (recommended) or the prefix commands shown below. Set `PREFIX` in `.env` to change the prefix from `$`. Hidden admin commands are not shown.')
                .addFields(
                    { name: '🛡️ Moderation (prefix)', value: '`$kick @user [reason]` • `$ban @user [reason]` • `$timeout @user <minutes> [reason]` • `$purge <1-100>`', inline: false },
                    { name: '🧰 Utility', value: '`$serverinfo` • `$userinfo [user]` • `$roles` • `$autorespond add|remove <trigger> [response]` • `$afk [reason]`', inline: false },
                    { name: '🎉 Fun', value: '`$rps <rock|paper|scissors>` • `$8ball <question>` • `$roll` • `$hug @user` • `$coinflip` • `$joke` • `$compliment`', inline: false },
                    { name: '📌 Examples', value: 'Usage examples:\n`$autorespond add hello Hello there!`\n`$8ball Will I pass my tests?`\n`$timeout @User 15 timeout for 15 minutes`', inline: false },
                    { name: '📝 Notes', value: 'Permissions: moderation commands require corresponding guild permissions. Use `TEST_GUILD_ID` (in `.env`) for instant slash registration while developing.', inline: false }
                )
                .setColor(0x5865F2)
                .setTimestamp();
            return message.reply({ embeds: [embed] });
        }

        // Moderation shortcuts
        try {
            if (cmd === 'kick') {
                if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply('You need Kick Members permission');
                const idOrMention = args[0] || '';
                let target = message.mentions.members.first() || (idOrMention ? await message.guild.members.fetch(idOrMention.replace(/[<@!>]/g, '')).catch(() => null) : null);
                if (!target) return message.reply('Mention a member or provide their ID');
                if (!message.guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply('I do not have permission to kick members');
                if (!target.kickable) return message.reply('I cannot kick that member (role hierarchy or missing permissions)');
                await target.kick(args.slice(1).join(' ') || 'No reason');
                const embedKick = new EmbedBuilder()
                    .setTitle('👢 Member Kicked')
                    .setDescription(`${target.user.tag} was kicked from the server.`)
                    .setColor(0xFFA500)
                    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                    .addFields(
                        { name: 'Member', value: `${target.user.tag}`, inline: true },
                        { name: 'Moderator', value: `${message.author.tag}`, inline: true },
                        { name: 'Reason', value: args.slice(1).join(' ') || 'No reason provided', inline: false }
                    )
                    .setTimestamp();
                return message.reply({ embeds: [embedKick] });
            }
            if (cmd === 'ban') {
                if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('You need Ban Members permission');
                const idOrMention = args[0] || '';
                let target = message.mentions.members.first() || (idOrMention ? await message.guild.members.fetch(idOrMention.replace(/[<@!>]/g, '')).catch(() => null) : null);
                if (!target) return message.reply('Mention a member or provide their ID');
                if (!message.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('I do not have permission to ban members');
                if (!target.bannable) return message.reply('I cannot ban that member (role hierarchy or missing permissions)');
                await target.ban({ reason: args.slice(1).join(' ') || 'No reason' });
                const embedBan = new EmbedBuilder()
                    .setTitle('🔨 Member Banned')
                    .setDescription(`${target.user.tag} was banned from the server.`)
                    .setColor(0xE74C3C)
                    .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                    .addFields(
                        { name: 'Member', value: `${target.user.tag}`, inline: true },
                        { name: 'Moderator', value: `${message.author.tag}`, inline: true },
                        { name: 'Reason', value: args.slice(1).join(' ') || 'No reason provided', inline: false }
                    )
                    .setTimestamp();
                return message.reply({ embeds: [embedBan] });
            }
            if (cmd === 'timeout') {
                if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('You need Moderate Members permission');
                const idOrMention = args[0] || '';
                let target = message.mentions.members.first() || (idOrMention ? await message.guild.members.fetch(idOrMention.replace(/[<@!>]/g, '')).catch(() => null) : null);
                const minutes = parseInt(args[1] || args[0], 10) || 1;
                if (!target) return message.reply('Mention a member or provide their ID');
                if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('I do not have permission to timeout members');
                try {
                    await target.timeout(minutes * 60 * 1000, args.slice(1).join(' ') || 'No reason');
                    const endAt = new Date(Date.now() + minutes * 60 * 1000);
                    const embedTimeout = new EmbedBuilder()
                        .setTitle('⏳ Member Timed Out')
                        .setDescription(`${target.user.tag} was timed out.`)
                        .setColor(0xF39C12)
                        .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                        .addFields(
                            { name: 'Member', value: `${target.user.tag}`, inline: true },
                            { name: 'Moderator', value: `${message.author.tag}`, inline: true },
                            { name: 'Duration', value: `${minutes} minute(s)`, inline: true },
                            { name: 'Ends At', value: `${endAt.toUTCString()}`, inline: false },
                            { name: 'Reason', value: args.slice(1).join(' ') || 'No reason provided', inline: false }
                        )
                        .setTimestamp();
                    return message.reply({ embeds: [embedTimeout] });
                } catch (e) { return message.reply(`Failed to timeout: ${e.message}`); }
            }
            if (cmd === 'unmute') {
                if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('You need Moderate Members permission');
                const idOrMention = args[0] || '';
                const target = message.mentions.members.first() || (idOrMention ? await message.guild.members.fetch(idOrMention.replace(/[<@!>]/g, '')).catch(() => null) : null);
                if (!target) return message.reply('Mention or provide ID');
                if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('I do not have permission to unmute members');
                try {
                    let prevUntil = null;
                    try { if (typeof target.communicationDisabledUntilTimestamp === 'number') prevUntil = new Date(target.communicationDisabledUntilTimestamp); else if (target.communicationDisabledUntil instanceof Date) prevUntil = target.communicationDisabledUntil; } catch { prevUntil = null; }
                    const caseId = crypto.randomInt(100000, 1000000);
                    await target.timeout(null, `Unmuted by ${message.author.tag} (case ${caseId})`);
                    const embed = new EmbedBuilder()
                        .setTitle('🔓 Member Unmuted')
                        .setDescription(`${target.user.tag} is no longer timed out.`)
                        .setColor(0x57F287)
                        .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                        .addFields(
                            { name: 'Member', value: `${target.user.tag} (${target.id})`, inline: true },
                            { name: 'Moderator', value: `${message.author.tag}`, inline: true },
                            { name: 'Action', value: 'Unmute (remove timeout)', inline: true },
                            { name: 'Previous Timeout Ends', value: prevUntil ? `${prevUntil.toUTCString()}` : 'N/A', inline: true },
                            { name: 'Case ID', value: `${caseId}`, inline: true },
                            { name: 'Server', value: `${message.guild.name}`, inline: true }
                        )
                        .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                        .setTimestamp();
                    return message.reply({ embeds: [embed] });
                } catch (e) { log('unmute error', e); return message.reply(`Failed to unmute: ${e.message}`); }
            }
            if (cmd === 'unban') {
                if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('You need Ban Members permission');
                const id = args[0]?.replace(/[<@!>]/g, '');
                if (!id) return message.reply('Provide id');
                if (!message.guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('I do not have permission to unban members');
                try {
                    const banInfo = await message.guild.bans.fetch(id).catch(() => null);
                    const userObj = await client.users.fetch(id).catch(() => null);
                    const caseId = crypto.randomInt(100000, 1000000);
                    await message.guild.bans.remove(id);
                    const embed = new EmbedBuilder()
                        .setTitle('🔓 Member Unbanned')
                        .setDescription(`Removed ban for ${userObj ? `${userObj.tag}` : `<@${id}>`} (${id}).`)
                        .setColor(0x57F287)
                        .setThumbnail(userObj ? userObj.displayAvatarURL({ dynamic: true }) : null)
                        .addFields(
                            { name: 'Moderator', value: `${message.author.tag}`, inline: true },
                            { name: 'User', value: `${userObj ? `${userObj.tag} (${userObj.id})` : id}`, inline: true },
                            { name: 'Ban Reason', value: banInfo?.reason || 'Unknown', inline: false },
                            { name: 'Case ID', value: `${caseId}`, inline: true },
                            { name: 'Server', value: `${message.guild.name}`, inline: true }
                        )
                        .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                        .setTimestamp();
                    return message.reply({ embeds: [embed] });
                } catch (e) { log('unban error', e); return message.reply(`Failed to unban: ${e.message}`); }
            }
        } catch (e) { log('prefix mod error', e); message.reply('Action failed'); }

        // Additional $-prefixed commands (non-nuke/antinuke)
        try {
            if (cmd === 'ping') {
                const start = Date.now();
                const sent = await message.reply('Pinging...');
                const round = Date.now() - start;
                const ws = Math.round(client.ws.ping);
                const embed = new EmbedBuilder()
                    .setTitle('🏓 Pong!')
                    .setDescription('Detailed latency and status report for the bot.')
                    .setColor(0x57F287)
                    .setThumbnail(client.user.displayAvatarURL({ dynamic: true }))
                    .addFields(
                        { name: 'WebSocket Ping', value: `${ws} ms`, inline: true },
                        { name: 'Roundtrip', value: `${round} ms`, inline: true },
                        { name: 'Uptime', value: `${Math.floor(process.uptime())}s`, inline: true }
                    )
                    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return sent.edit({ content: null, embeds: [embed] });
            }

            if (cmd === 'coinflip') {
                const flip = crypto.randomInt(0, 2) === 0 ? 'Heads' : 'Tails';
                const embed = new EmbedBuilder()
                    .setTitle('🪙 Coin Flip')
                    .setDescription(`I flipped a coin and it landed on **${flip}**.`)
                    .setColor(0xFFD166)
                    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'joke') {
                const joke = JOKES[Math.floor(Math.random() * JOKES.length)];
                const embed = new EmbedBuilder()
                    .setTitle('😂 Joke')
                    .setDescription(joke)
                    .setColor(0xFFB4A2)
                    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'emojify') {
                const text = args.join(' ').trim();
                if (!text) return message.reply('Usage: $emojify <text>');
                const out = emojifyText(text);
                const embed = new EmbedBuilder()
                    .setTitle('🔠 Emojified Text')
                    .setDescription(out || 'Unable to emojify the provided text.')
                    .setColor(0xFFD166)
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'emojisteal') {
                const raw = args[0];
                const nameArg = args[1];
                const gid = message.guildId;
                if (!gid) return message.reply('This command must be used in a server.');
                if (!message.member.permissions.has(PermissionFlagsBits.ManageEmojisAndStickers) && message.author.id !== OWNER) return message.reply('Manage Emojis & Stickers permission required to add emojis.');
                if (!raw) return message.reply('Usage: $emojisteal <emoji|url> [name]');
                const m = raw.match(/<a?:([^:]+):(\d+)>/);
                let url = raw;
                let name = nameArg || (m ? m[1] : `emoji_${crypto.randomInt(1000, 9999)}`);
                if (m) {
                    const id = m[2];
                    const ext = raw.startsWith('<a:') ? 'gif' : 'png';
                    url = `https://cdn.discordapp.com/emojis/${id}.${ext}`;
                }
                try {
                    const created = await message.guild.emojis.create({ attachment: url, name });
                    const embed = new EmbedBuilder()
                        .setTitle('✅ Emoji Added')
                        .setDescription(`Successfully added emoji ${created.toString()} to this server.`)
                        .setColor(0x2ECC71)
                        .addFields({ name: 'Name', value: `${created.name}`, inline: true }, { name: 'ID', value: `${created.id}`, inline: true }, { name: 'URL', value: `${created.url}`, inline: false })
                        .setTimestamp();
                    return message.reply({ embeds: [embed] });
                } catch (e) {
                    return message.reply(`Failed to add emoji: ${e.message}`);
                }
            }

            if (cmd === 'compliment') {
                const comp = COMPLIMENTS[Math.floor(Math.random() * COMPLIMENTS.length)];
                const embed = new EmbedBuilder()
                    .setTitle('✨ Compliment')
                    .setDescription(comp)
                    .setColor(0x9B5DE5)
                    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'avatar') {
                let target = message.mentions.users.first() || (args[0] ? await message.guild.members.fetch(args[0]).then(m => m.user).catch(() => null) : null) || message.author;
                const png = target.displayAvatarURL({ dynamic: true, size: 1024, format: 'png' });
                const webp = target.displayAvatarURL({ dynamic: true, size: 1024, format: 'webp' });
                const gif = target.displayAvatarURL({ dynamic: true, size: 1024, format: 'gif' });
                const embed = new EmbedBuilder()
                    .setTitle(`${target.tag} — Avatar`)
                    .setDescription('High-quality avatar preview with direct download links.')
                    .setImage(target.displayAvatarURL({ dynamic: true, size: 1024 }))
                    .setColor(target.accentColor ? Number(target.accentColor) : 0x7289DA)
                    .addFields(
                        { name: 'ID', value: `${target.id}`, inline: true },
                        { name: 'Animated', value: `${target.avatar && target.avatar.startsWith('a_') ? 'Yes' : 'No'}`, inline: true },
                        { name: 'Formats', value: `[PNG](${png}) • [WEBP](${webp}) • [GIF](${gif})`, inline: false }
                    )
                    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'rps') {
                const choice = args[0]?.toLowerCase();
                const valid = ['rock', 'paper', 'scissors'];
                if (!choice || !valid.includes(choice)) return message.reply('Usage: $rps <rock|paper|scissors>');
                const botChoice = valid[crypto.randomInt(0, 3)];
                const wins = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
                let outcome = 'lose';
                if (choice === botChoice) outcome = 'tie';
                else if (wins[choice] === botChoice) outcome = 'win';
                const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
                const color = outcome === 'win' ? 0x57F287 : (outcome === 'tie' ? 0xE2E2E2 : 0xFF6B6B);
                const embed = new EmbedBuilder()
                    .setTitle('🎮 Rock • Paper • Scissors')
                    .setDescription(`You chose **${choice}** ${emojis[choice]} — I chose **${botChoice}** ${emojis[botChoice]}`)
                    .addFields(
                        { name: 'Your Choice', value: `${choice} ${emojis[choice]}`, inline: true },
                        { name: 'Bot Choice', value: `${botChoice} ${emojis[botChoice]}`, inline: true },
                        { name: 'Result', value: outcome === 'win' ? '🎉 You win!' : (outcome === 'tie' ? "🤝 It's a tie!" : '😞 You lose!'), inline: false }
                    )
                    .setColor(color)
                    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === '8ball') {
                const question = args.join(' ').trim();
                if (!question) return message.reply('Usage: $8ball <question>');
                const answer = EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
                const embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('🎱 Mystic 8‑Ball')
                    .setDescription('The universe has spoken.')
                    .addFields(
                        { name: '❓ Your Question', value: question },
                        { name: '🔮 8‑Ball Says', value: answer }
                    )
                    .setFooter({ text: `Requested by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'serverinfo') {
                const g = message.guild;
                if (!g) return message.reply('This command must be used in a server.');
                const members = g.members.cache;
                const humans = members.filter(m => !m.user.bot).size;
                const bots = members.filter(m => m.user.bot).size;
                const channels = g.channels.cache;
                const textChannels = channels.filter(c => c.type === 0).size;
                const voiceChannels = channels.filter(c => c.type === 2).size;
                const categories = channels.filter(c => c.type === 4).size;
                const rolesCount = g.roles.cache.size;
                const createdDays = Math.floor((Date.now() - g.createdAt) / (1000 * 60 * 60 * 24));
                const embed = new EmbedBuilder()
                    .setTitle(`${g.name} — Server Overview`)
                    .setThumbnail(g.iconURL({ size: 512 }))
                    .addFields(
                        { name: 'ID', value: `${g.id}`, inline: true },
                        { name: 'Owner', value: `<@${g.ownerId}>`, inline: true },
                        { name: 'Created', value: `${g.createdAt.toUTCString()}\n(${createdDays} days ago)`, inline: true },
                        { name: 'Members', value: `${g.memberCount} (👤 ${humans} / 🤖 ${bots})`, inline: true },
                        { name: 'Channels', value: `Total: ${channels.size}\nText: ${textChannels} • Voice: ${voiceChannels} • Categories: ${categories}`, inline: true },
                        { name: 'Roles', value: `${rolesCount}`, inline: true },
                        { name: 'Boosts', value: `${g.premiumSubscriptionCount || 0} (Tier ${g.premiumTier || 0})`, inline: true },
                        { name: 'Verification', value: `${g.verificationLevel}`, inline: true },
                        { name: 'Features', value: `${(g.features && g.features.length) ? g.features.join(', ') : 'None'}`, inline: false }
                    )
                    .setColor(0x5865F2)
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'userinfo') {
                let target = message.mentions.users.first() || (args[0] ? await message.guild.members.fetch(args[0]).then(m => m.user).catch(() => null) : null) || message.author;
                if (!target) return message.reply('User not found');
                const member = message.guild ? message.guild.members.cache.get(target.id) : null;
                const joined = member && member.joinedAt ? `${member.joinedAt.toUTCString()}` : 'N/A';
                const created = target.createdAt ? `${target.createdAt.toUTCString()}` : 'N/A';
                const roles = member ? member.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position).map(r => r.toString()) : [];
                const rolesList = roles.length ? (roles.slice(0, 10).join(' ') + (roles.length > 10 ? ` \n+${roles.length - 10} more` : '')) : 'None';
                const embed = new EmbedBuilder()
                    .setTitle(`${target.tag}`)
                    .setThumbnail(target.displayAvatarURL({ dynamic: true, size: 512 }))
                    .addFields(
                        { name: 'ID', value: `${target.id}`, inline: true },
                        { name: 'Bot', value: `${target.bot ? 'Yes' : 'No'}`, inline: true },
                        { name: 'Account Created', value: created, inline: false },
                        { name: 'Server Join', value: joined, inline: false },
                        { name: `Roles (${roles.length})`, value: rolesList, inline: false },
                        { name: 'Highest Role', value: `${member ? member.roles.highest.name : 'N/A'}`, inline: true }
                    )
                    .setColor(member ? member.displayHexColor || 0x00FF00 : 0x00FF00)
                    .setTimestamp();
                return message.reply({ embeds: [embed] });
            }

            if (cmd === 'purge') {
                if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('You do not have permission');
                const amount = parseInt(args[0], 10);
                if (!amount || amount < 1 || amount > 100) return message.reply('Amount must be 1-100');
                try { const deleted = await message.channel.bulkDelete(amount, true); return message.reply(`Deleted ${deleted.size} messages.`); } catch (e) { return message.reply(`Failed to delete: ${e.message}`); }
            }

            if (cmd === 'autorespond') {
                const action = args[0];
                const trigger = args[1];
                const response = args.slice(2).join(' ');
                const gid = message.guildId;
                if (!gid) return message.reply('This command must be used in a server.');
                autoresponders[gid] = autoresponders[gid] || [];
                if (action === 'add') {
                    // enforce one autoresponder per user
                    if (autoresponders[gid].some(a => a.createdBy === message.author.id)) return message.reply('You already have an autoresponder. Remove it first.');
                    const m = trigger?.match(/<@!?(\d+)>/);
                    if (m) {
                        autoresponders[gid].push({ type: 'mention', targetUserId: m[1], response: response || '', createdBy: message.author.id, createdAt: Date.now() });
                        writeJson(AUTORESPOND_PATH, autoresponders);
                        const embed = new EmbedBuilder()
                            .setTitle('Autoresponder Created')
                            .setDescription('Your mention-based autoresponder was saved successfully.')
                            .addFields(
                                { name: 'Trigger', value: `<@${m[1]}>`, inline: true },
                                { name: 'Type', value: 'Mention', inline: true },
                                { name: 'Response Preview', value: response ? (response.length > 750 ? response.slice(0, 747) + '...' : response) : '*(empty)*', inline: false }
                            )
                            .setColor(0x6C5CE7)
                            .setFooter({ text: `Set by ${message.author.tag || message.author.username}` })
                            .setTimestamp();
                        return message.reply({ embeds: [embed] });
                    }
                    autoresponders[gid].push({ type: 'text', trigger: trigger.trim().toLowerCase(), response: response || '', createdBy: message.author.id, createdAt: Date.now() });
                    writeJson(AUTORESPOND_PATH, autoresponders);
                    const embedText = new EmbedBuilder()
                        .setTitle('Autoresponder Created')
                        .setDescription('Your text-based autoresponder was saved successfully.')
                        .addFields(
                            { name: 'Trigger', value: `\`${trigger}\``, inline: true },
                            { name: 'Type', value: 'Text', inline: true },
                            { name: 'Response Preview', value: response ? (response.length > 750 ? response.slice(0, 747) + '...' : response) : '*(empty)*', inline: false }
                        )
                        .setColor(0x6C5CE7)
                        .setFooter({ text: `Set by ${message.author.tag || message.author.username}` })
                        .setTimestamp();
                    return message.reply({ embeds: [embedText] });
                }

                if (cmd === 'censor') {
                    const sub = args[0]?.toLowerCase();
                    const word = args.slice(1).join(' ').trim();
                    const gid = message.guildId;
                    if (!gid) return message.reply('This command must be used in a server.');
                    if (!message.member.permissions.has(PermissionFlagsBits.Administrator) && message.author.id !== OWNER) return message.reply('Administrator permission required to manage censored words.');
                    censorMap[gid] = censorMap[gid] || [];
                    if (sub === 'add') {
                        if (!word) return message.reply('Usage: $censor add <word or phrase>');
                        if (censorMap[gid].some(w => w.toLowerCase() === word.toLowerCase())) return message.reply('That word/phrase is already censored.');
                        censorMap[gid].push(word);
                        writeJson(CENSOR_PATH, censorMap);
                        const embed = new EmbedBuilder().setTitle('✅ Censored Word Added').setDescription('Added a censored word/phrase for this server.').addFields({ name: 'Word', value: `${word}`, inline: true }, { name: 'Added By', value: `${message.author.tag}`, inline: true }).setColor(0x2ECC71).setTimestamp();
                        return message.reply({ embeds: [embed] });
                    }
                    if (sub === 'remove') {
                        if (!word) return message.reply('Usage: $censor remove <word or phrase>');
                        const idx = censorMap[gid].findIndex(w => w.toLowerCase() === word.toLowerCase());
                        if (idx === -1) return message.reply('That word/phrase is not in the censor list.');
                        const removed = censorMap[gid].splice(idx, 1)[0];
                        writeJson(CENSOR_PATH, censorMap);
                        const embed = new EmbedBuilder().setTitle('🗑️ Censored Word Removed').setDescription('Removed a censored word/phrase from this server.').addFields({ name: 'Word', value: `${removed}`, inline: true }, { name: 'Removed By', value: `${message.author.tag}`, inline: true }).setColor(0xFF7675).setTimestamp();
                        return message.reply({ embeds: [embed] });
                    }
                    if (sub === 'list') {
                        const list = censorMap[gid] || [];
                        if (!list.length) return message.reply('No censored words configured for this server.');
                        const text = list.map((w, i) => `${i + 1}. ${w}`).join('\n');
                        if (text.length <= 1500) {
                            const embed = new EmbedBuilder().setTitle('📋 Censored Words').setDescription('List of configured censored words/phrases for this server.').addFields({ name: 'Words', value: text }).setColor(0x5865F2).setTimestamp();
                            return message.reply({ embeds: [embed] });
                        } else {
                            const buf = Buffer.from(text, 'utf8');
                            return message.reply({ content: 'Censored words list attached.', files: [{ attachment: buf, name: `${gid}_censor_list.txt` }] });
                        }
                    }
                    return message.reply('Usage: $censor add|remove|list <word>');
                }
                if (action === 'remove') {
                    const m = trigger?.match(/<@!?(\d+)>/);
                    const list = autoresponders[gid] || [];
                    if (m) {
                        const removed = list.find(a => a.type === 'mention' && a.targetUserId === m[1]);
                        if (!removed) return message.reply('No matching mention-based autoresponder.');
                        if (removed.createdBy !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('Only admins may remove others\' autoresponders');
                        autoresponders[gid] = list.filter(a => !(a.type === 'mention' && a.targetUserId === m[1]));
                        writeJson(AUTORESPOND_PATH, autoresponders);
                        const embed = new EmbedBuilder()
                            .setTitle('Autoresponder Removed')
                            .setDescription('Removed a mention-based autoresponder via prefix command.')
                            .addFields(
                                { name: 'Trigger', value: `<@${m[1]}>`, inline: true },
                                { name: 'Removed By', value: `<@${message.author.id}>`, inline: true },
                                { name: 'Original Creator', value: removed.createdBy ? `<@${removed.createdBy}>` : 'Unknown', inline: true }
                            )
                            .setColor(0xFF7675)
                            .setTimestamp();
                        return message.reply({ embeds: [embed] });
                    }
                    const removedText = list.find(a => a.type === 'text' && a.trigger === trigger.trim().toLowerCase());
                    if (!removedText) return message.reply('No matching text autoresponder found.');
                    if (removedText.createdBy !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('Only admins may remove others\' autoresponders');
                    autoresponders[gid] = list.filter(a => !(a.type === 'text' && a.trigger === trigger.trim().toLowerCase()));
                    writeJson(AUTORESPOND_PATH, autoresponders);
                    const embedRem = new EmbedBuilder()
                        .setTitle('Autoresponder Removed')
                        .setDescription('Removed a text-based autoresponder via prefix command.')
                        .addFields(
                            { name: 'Trigger', value: `\`${trigger}\``, inline: true },
                            { name: 'Removed By', value: `<@${message.author.id}>`, inline: true },
                            { name: 'Original Creator', value: removedText.createdBy ? `<@${removedText.createdBy}>` : 'Unknown', inline: true }
                        )
                        .setColor(0xFF7675)
                        .setTimestamp();
                    return message.reply({ embeds: [embedRem] });
                }
                return message.reply('Usage: $autorespond add|remove <trigger> [response]');
            }

            if (cmd === 'afk') {
                const reason = args.join(' ') || '';
                const gid = message.guild?.id || 'dm';
                afkMap[gid] = afkMap[gid] || {};
                afkMap[gid][message.author.id] = { reason, setAt: Date.now() };
                writeJson(AFK_PATH, afkMap);
                const embedAfk = new EmbedBuilder()
                    .setTitle('💤 AFK Set')
                    .setDescription(`${message.author.tag} is now AFK${reason ? `: ${reason}` : ''}`)
                    .setColor(0x95A5A6)
                    .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
                    .addFields({ name: 'Reason', value: reason || 'No reason provided', inline: false })
                    .setTimestamp();
                return message.reply({ embeds: [embedAfk] });
            }

            if (cmd === 'removeafk') {
                const idOrMention = args[0] || '';
                const target = message.mentions.members.first() || (idOrMention ? await message.guild.members.fetch(idOrMention.replace(/[<@!>]/g, '')).catch(() => null) : null);
                if (!target) return message.reply('Mention or provide ID of the member whose AFK you want to remove.');
                const gid = message.guild?.id || 'dm';
                afkMap[gid] = afkMap[gid] || {};
                const entry = afkMap[gid][target.id];
                if (!entry) return message.reply(`${target.user.tag} is not marked AFK.`);
                try {
                    delete afkMap[gid][target.id];
                    writeJson(AFK_PATH, afkMap);
                    const setAt = entry.setAt ? new Date(entry.setAt) : null;
                    const durationMs = setAt ? (Date.now() - setAt.getTime()) : null;
                    const durationText = durationMs ? `${Math.floor(durationMs / 60000)} minute(s)` : 'Unknown';
                    const caseId = crypto.randomInt(100000, 1000000);
                    const embed = new EmbedBuilder()
                        .setTitle('🟢 AFK Removed')
                        .setDescription(`${target.user.tag} is no longer AFK.`)
                        .setColor(0x2ECC71)
                        .setThumbnail(target.user.displayAvatarURL({ dynamic: true }))
                        .addFields(
                            { name: 'Member', value: `${target.user.tag} (${target.id})`, inline: true },
                            { name: 'Removed By', value: `${message.author.tag}`, inline: true },
                            { name: 'Previous Reason', value: entry.reason || 'None', inline: false },
                            { name: 'Set At', value: setAt ? setAt.toUTCString() : 'Unknown', inline: true },
                            { name: 'AFK Duration', value: durationText, inline: true },
                            { name: 'Case ID', value: `${caseId}`, inline: true }
                        )
                        .setFooter({ text: `Cleared by ${message.author.tag}`, iconURL: message.author.displayAvatarURL({ dynamic: true }) })
                        .setTimestamp();
                    return message.reply({ embeds: [embed] });
                } catch (e) { log('removeafk prefix error', e); return message.reply('Failed to remove AFK.'); }
            }

            // prefix `back` removed; AFK is cleared automatically when a user sends a message

            if (cmd === 'roles') {
                const g = message.guild;
                if (!g) return message.reply('This command must be used in a server.');
                const roles = g.roles.cache.filter(r => r.name !== '@everyone').sort((a, b) => b.position - a.position);
                if (!roles.size) return message.reply('No roles found.');
                const total = roles.size;
                const hoisted = roles.filter(r => r.hoist).size;
                const mentionable = roles.filter(r => r.mentionable).size;

                const top = roles.map((r, i) => {
                    const membersCount = r.members ? r.members.filter(m => !m.user.bot).size : r.members.size;
                    const color = r.hexColor && r.hexColor !== '#000000' ? r.hexColor : 'None';
                    const flags = `${r.hoist ? 'Hoisted • ' : ''}${r.mentionable ? 'Mentionable' : ''}`.trim();
                    return `**${i + 1}.** ${r.name} — ${membersCount} members — ${color}${flags ? ' • ' + flags : ''}`;
                }).slice(0, 20);

                const embed = new EmbedBuilder()
                    .setTitle(`Roles — ${g.name} (${total})`)
                    .addFields(
                        { name: 'Total Roles', value: `${total}`, inline: true },
                        { name: 'Hoisted', value: `${hoisted}`, inline: true },
                        { name: 'Mentionable', value: `${mentionable}`, inline: true }
                    )
                    .addFields({ name: `Top ${top.length} Roles`, value: top.join('\n').slice(0, 1000), inline: false })
                    .setColor(0x5865F2)
                    .setFooter({ text: 'Showing top roles. Full list will be sent as follow-ups if large.' })
                    .setTimestamp();

                await message.reply({ embeds: [embed] });

                // send full list as chunked code blocks
                const full = roles.map(r => {
                    const membersCount = r.members ? r.members.filter(m => !m.user.bot).size : r.members.size;
                    // Only show role mention and name (no IDs)
                    return `${r.name}\t(${membersCount} members)`;
                });
                const fullText = full.join('\n');
                if (fullText.length <= 1900) {
                    await message.channel.send('```\n' + fullText + '\n```').catch(() => { });
                } else {
                    const buf = Buffer.from(fullText, 'utf8');
                    await message.channel.send({ content: 'Full role list attached.', files: [{ attachment: buf, name: `${message.guild.id}_roles.txt` }] }).catch(() => { });
                }
                return;
            }

            if (cmd === 'role') {
                if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('ManageRoles required');
                const action = args[0];
                const target = message.mentions.members.first() || (args[1] ? await message.guild.members.fetch(args[1]).catch(() => null) : null);
                const roleMention = message.mentions.roles.first() || null;
                if (!action || !target || !roleMention) return message.reply('Usage: $role add|remove @member @role');
                try { if (action === 'add') { await target.roles.add(roleMention); return message.reply(`Added role ${roleMention.name} to ${target.user.tag}`); } else { await target.roles.remove(roleMention); return message.reply(`Removed role ${roleMention.name} from ${target.user.tag}`); } } catch (e) { return message.reply(`Failed to modify roles: ${e.message}`); }
            }

            if (cmd === 'roll') return message.reply(`You rolled ${Math.floor(Math.random() * 100) + 1}`);

            if (cmd === 'hug') { const target = message.mentions.members.first() || message.member; return message.reply(`${message.author} gives ${target} a warm hug 🤗`); }

        } catch (e) { log('prefix cmd error', e); message.reply('Command failed'); }

    } catch (e) { log('message handler error', e); }
});

process.on('unhandledRejection', (r) => log('UnhandledRejection', r));

// Anti-nuke event handlers: restore deleted roles/channels and react to bulk deletes
client.on('roleDelete', async (role) => {
    try {
        const gid = role.guild.id;
        if (!antinukeSettings[gid]?.enabled) return;
        log('roleDelete detected for', role.name, 'attempting restore');
        const g = role.guild;
        // try re-create role with same basic properties
        const created = await g.roles.create({ name: role.name, color: role.hexColor || null, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions.bitfield, reason: 'Anti-nuke role restore' }).catch(e => { log('role restore failed', e); return null; });
        if (created) {
            log('role restored', created.id, created.name);
            const notify = g.systemChannel || g.channels.cache.find(c => c.type === 0);
            if (notify) notify.send(`Restored role **${created.name}** after deletion (Anti-nuke)`).catch(() => { });
        }
    } catch (e) { log('roleDelete handler error', e); }
});

client.on('channelDelete', async (channel) => {
    try {
        const gid = channel.guild.id;
        if (!antinukeSettings[gid]?.enabled) return;
        log('channelDelete detected for', channel.name, 'attempting restore');
        const g = channel.guild;
        const overwrites = channel.permissionOverwrites.cache.map(po => ({ id: po.id, type: po.type, allow: po.allow.bitfield, deny: po.deny.bitfield }));
        const created = await g.channels.create({ name: channel.name, type: channel.type, topic: channel.topic, nsfw: channel.nsfw, parent: channel.parentId, permissionOverwrites: overwrites, reason: 'Anti-nuke channel restore' }).catch(e => { log('channel restore failed', e); return null; });
        if (created) {
            log('channel restored', created.id, created.name);
            const notify = g.systemChannel || g.channels.cache.find(c => c.type === 0);
            if (notify) notify.send(`Restored channel **${created.name}** after deletion (Anti-nuke)`).catch(() => { });
        }
    } catch (e) { log('channelDelete handler error', e); }
});

client.on('messageDeleteBulk', async (messages) => {
    try {
        const first = messages.first(); if (!first) return;
        const g = first.guild; if (!g) return;
        if (!antinukeSettings[g.id]?.enabled) return;
        log('messageDeleteBulk detected in', g.id);
        const logs = await g.fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 1 }).catch(() => null);
        const entry = logs?.entries?.first();
        const executor = entry?.executor;
        const notify = g.systemChannel || g.channels.cache.find(c => c.type === 0);
        if (executor) {
            const member = await g.members.fetch(executor.id).catch(() => null);
            const embed = new EmbedBuilder().setTitle('🚨 Anti-nuke triggered — bulk delete detected').setDescription(`Bulk message deletion detected. Executor: ${executor.tag} (${executor.id})`).setColor(0xFF6B6B).setTimestamp();
            if (notify) notify.send({ embeds: [embed] }).catch(() => { });
            // try to take strong action: ban if possible and safe
            if (member && !member.permissions.has(PermissionFlagsBits.Administrator) && g.members.me.permissions.has(PermissionFlagsBits.BanMembers) && executor.id !== OWNER) {
                await member.ban({ reason: 'Anti-nuke: bulk message deletion detected' }).catch(e => log('failed to ban executor', e));
                if (notify) notify.send(`Banned ${executor.tag} for bulk message deletion (Anti-nuke)`).catch(() => { });
            }
        } else {
            if (notify) notify.send('Bulk message deletion detected (executor unknown)').catch(() => { });
        }
    } catch (e) { log('messageDeleteBulk handler error', e); }
});

// General guild and member event logging to terminal
client.on('guildCreate', (g) => { try { log('Guild Join', `${g.name}(${g.id})`, `Members:${g.memberCount}`); } catch (e) { } });
client.on('guildDelete', (g) => { try { log('Guild Leave', `${g.name}(${g.id})`); } catch (e) { } });
client.on('guildMemberAdd', (m) => { try { log('Member Join', `${m.user.tag}(${m.user.id})`, '->', `${m.guild.name}(${m.guild.id})`); } catch (e) { } });
client.on('guildMemberRemove', (m) => { try { log('Member Leave', `${m.user.tag}(${m.user.id})`, 'from', `${m.guild.name}(${m.guild.id})`); } catch (e) { } });

client.on('channelCreate', (c) => { try { log('Channel Create', `${c.guild?.name || 'DM'}(${c.guild?.id || 'NA'})`, `${c.name}(${c.id})`, `type:${c.type}`); } catch (e) { } });
client.on('channelDelete', (c) => { try { log('Channel Delete', `${c.guild?.name || 'DM'}(${c.guild?.id || 'NA'})`, `${c.name}(${c.id})`); } catch (e) { } });

client.on('roleCreate', (r) => { try { log('Role Create', `${r.guild.name}(${r.guild.id})`, `${r.name}(${r.id})`); } catch (e) { } });
client.on('roleDelete', (r) => { try { log('Role Delete', `${r.guild.name}(${r.guild.id})`, `${r.name}(${r.id})`); } catch (e) { } });

client.on('emojiCreate', (e) => { try { log('Emoji Create', `${e.name}(${e.id})`, 'animated:', e.animated, 'in', `${e.guild?.name || 'NA'}(${e.guild?.id || 'NA'})`); } catch (err) { } });
client.on('emojiDelete', (e) => { try { log('Emoji Delete', `${e.name}(${e.id})`, 'from', `${e.guild?.name || 'NA'}(${e.guild?.id || 'NA'})`); } catch (err) { } });

process.on('unhandledRejection', (r) => log('UnhandledRejection', r));

// keep hosters happy: create a tiny HTTP server so platforms that port-scan
// (Render, Railway, etc.) see an open port and don't shut the process down.
try {
    const http = require('http');
    const PORT = process.env.PORT || 3000;
    http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
    }).listen(PORT).on('listening', () => log(`HTTP server listening on port ${PORT}`)).on('error', (err) => log('HTTP server error', err));
} catch (e) { log('failed to start http server', e); }

process.on('uncaughtException', (err) => { log('UncaughtException', err); });

client.login(TOKEN).catch(e => { log('Login failed', e); process.exit(1); });
