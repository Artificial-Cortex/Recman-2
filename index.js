require('dotenv').config();

const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

const commands = [
  { name: 'record', description: 'Start recording the voice channel.' },
  { name: 'stop', description: 'Stop recording and upload to Google Drive.' }
];

const recordingsDir = path.join(__dirname, 'Recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir);

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const [guildId] of client.guilds.cache) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guildId),
        { body: commands }
      );
      console.log(`Slash commands registered for guild: ${guildId}`);
    } catch (error) {
      console.error('Error registering slash commands:', error);
    }
  }
});

let recordings = {};

function formatFilename(guild, channel, users) {
  const date = new Date();
  const formattedDate = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0')
  ].join('-');
  return `${guild} ${channel} ${users.join(', ')} ${formattedDate}.aac`;
}

async function startRecording(interaction, voiceChannel) {
  if (!voiceChannel) {
    return interaction.reply('You need to be in a voice channel to start recording!');
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    const botMember = await voiceChannel.guild.members.fetch(client.user.id);
    if (botMember.voice.deaf) await botMember.voice.setDeaf(false);
  } catch (err) {
    console.warn('Warning: Could not undeafen bot:', err.message);
  }

  const receiver = connection.receiver;
  recordings[voiceChannel.id] = {};

  voiceChannel.members.forEach(member => {
    if (member.user.bot) return;

    const opusStream = receiver.subscribe(member.id, {
      end: { behavior: EndBehaviorType.Manual }
    });

    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48000,
    });

    const outputFilePath = path.join(recordingsDir, `${member.id}.pcm`);
    const outputStream = fs.createWriteStream(outputFilePath);

    opusStream.on('error', err => console.warn(`Opus stream error for ${member.user.tag}: ${err.message}`));

    opusStream.pipe(decoder).pipe(outputStream);

    recordings[voiceChannel.id][member.id] = { outputStream, opusStream, decoder };
  });

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp('🔴 Recording started!');
  } else {
    await interaction.reply('🔴 Recording started!');
  }
}

async function stopRecording(interaction, voiceChannel) {
  const connection = getVoiceConnection(voiceChannel.guild.id);
  if (!recordings[voiceChannel.id]) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ No active recording in this channel.', ephemeral: true });
    } else {
      await interaction.followUp({ content: '❌ No active recording in this channel.', ephemeral: true });
    }
    if (connection) connection.destroy();
    return;
  }

  if (!interaction.deferred) await interaction.deferReply();

  Object.values(recordings[voiceChannel.id]).forEach(({ outputStream, opusStream, decoder }) => {
    if (opusStream) opusStream.destroy();
    if (decoder) decoder.destroy();
    if (outputStream) outputStream.end();
  });

  await new Promise(res => setTimeout(res, 1000));

  const userIds = Object.keys(recordings[voiceChannel.id]);
  const usernameList = userIds.map(id => voiceChannel.members.get(id)?.user.username || id);

  const inputFiles = userIds
    .map(id => path.join(recordingsDir, `${id}.pcm`))
    .filter(f => {
      try {
        const stats = fs.statSync(f);
        return stats.size > 0;
      } catch {
        return false;
      }
    });

  if (inputFiles.length === 0) {
    await interaction.editReply('No audio was recorded. Make sure someone is speaking and not muted!');
    if (connection) connection.destroy();
    delete recordings[voiceChannel.id];
    return;
  }

  const outFilename = path.join(
    recordingsDir,
    formatFilename(voiceChannel.guild.name, voiceChannel.name, usernameList)
  );

  let ffmpegCmd = '';
  inputFiles.forEach(f => {
    ffmpegCmd += `-f s16le -ar 48000 -ac 2 -i "${f}" `;
  });
  ffmpegCmd += `-filter_complex "amix=inputs=${inputFiles.length}:duration=first:dropout_transition=2" -ac 2 -c:a aac -b:a 128k -f adts "${outFilename}"`;

  exec(`"${ffmpegPath}" ${ffmpegCmd}`, async error => {
    inputFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    if (error) {
      console.error('ffmpeg error:', error);
      await interaction.editReply('Error mixing the audio.');
      if (connection) connection.destroy();
      delete recordings[voiceChannel.id];
      return;
    }

    try {
      const fileUrl = await uploadToGoogleDrive(outFilename);
      await interaction.editReply(`Recording finished and uploaded: ${fileUrl}`);

      if (fs.existsSync(outFilename)) fs.unlinkSync(outFilename);

      if (connection) connection.destroy();
      delete recordings[voiceChannel.id];
    } catch (err) {
      await interaction.editReply('Failed to upload to Drive: ' + err.message);
      if (connection) connection.destroy();
      delete recordings[voiceChannel.id];
    }
  });
}

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  if (message.content === "!record") {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first!');
    startRecording(message, voiceChannel);
  }
  if (message.content === "!stop") {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first!');
    stopRecording(message, voiceChannel);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'record') {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.reply('Join a voice channel first!');
    startRecording(interaction, voiceChannel);
  }
  if (interaction.commandName === 'stop') {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) return interaction.reply('Join a voice channel first!');
    stopRecording(interaction, voiceChannel);
  }
});

async function uploadToGoogleDrive(filename) {
  const credentials = require('./credentials.json');
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  let token;
  try {
    token = fs.readFileSync('token.json');
    oAuth2Client.setCredentials(JSON.parse(token));
  } catch (err) {
    throw new Error('Google OAuth token missing! Run authorize.js to fetch token.');
  }

  const drive = google.drive({ version: 'v3', auth: oAuth2Client });

  const fileMetadata = {
    name: path.basename(filename),
    parents: ['1L-rWCLRYns6XupBk-lLqKx5irLUzt6pB'] // Your Drive folder ID here
  };
  const media = {
    mimeType: 'audio/aac',
    body: fs.createReadStream(filename)
  };
  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id,webViewLink',
  });

  return file.data.webViewLink;
}

client.login(process.env.DISCORD_TOKEN);
