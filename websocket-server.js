import dotenv from 'dotenv';
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Load environment variables
dotenv.config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const PORT = process.env.PORT || 8000;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const wss = new WebSocket.Server({ host: '0.0.0.0', port: PORT }, () => {
  console.log(`[Server] WebSocket server listening on ws://0.0.0.0:${PORT}`);
});

// Get a signed URL from ElevenLabs
async function getSignedUrl() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    }
  );

  if (!res.ok) throw new Error(`Failed to get signed URL: ${res.statusText}`);
  const { signed_url } = await res.json();
  return signed_url;
}

wss.on('connection', async (ws) => {
  console.log('[Twilio] WebSocket connected');

  let streamSid = null;
  let elevenWs = null;
  let customParameters = null;

  try {
    const signedUrl = await getSignedUrl();
    elevenWs = new WebSocket(signedUrl);

    elevenWs.on('open', () => {
      console.log('[ElevenLabs] Connected');

      const initialConfig = {
        type: 'conversation_initiation_client_data',
        dynamic_variables: {
          user_name: 'Angelo',
          user_id: 1234,
        },
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: customParameters?.prompt || 'You are Gary from the phone store.',
            },
            first_message: customParameters?.first_message || 'Hey there! How can I help you today?',
          },
        },
      };

      elevenWs.send(JSON.stringify(initialConfig));
    });

    elevenWs.on('message', (data) => {
      try {
        const message = JSON.parse(data);

        if (message.type === 'audio') {
          const payload = message.audio?.chunk || message.audio_event?.audio_base_64;
          if (payload && streamSid) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload },
            }));
          }
        }

        if (message.type === 'interruption') {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        if (message.type === 'ping') {
          elevenWs.send(JSON.stringify({
            type: 'pong',
            event_id: message.ping_event?.event_id,
          }));
        }
      } catch (err) {
        console.error('[ElevenLabs] Message error:', err);
      }
    });

    elevenWs.on('close', () => {
      console.log('[ElevenLabs] Disconnected');
    });

    elevenWs.on('error', (err) => {
      console.error('[ElevenLabs] WebSocket error:', err);
    });
  } catch (err) {
    console.error('[ElevenLabs] Failed to connect:', err);
    ws.close();
  }

  // Handle messages from Twilio
  ws.on('message', (msg) => {
    try {
      const message = JSON.parse(msg);

      switch (message.event) {
        case 'start':
          streamSid = message.start.streamSid;
          customParameters = message.start.customParameters;
          console.log(`[Twilio] Start stream: ${streamSid}`);
          break;

        case 'media':
          if (elevenWs?.readyState === WebSocket.OPEN) {
            elevenWs.send(JSON.stringify({
              user_audio_chunk: Buffer.from(message.media.payload, 'base64').toString('base64'),
            }));
          }
          break;

        case 'stop':
          console.log(`[Twilio] Stop stream: ${streamSid}`);
          if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
          break;

        default:
          console.log('[Twilio] Unknown event:', message.event);
      }
    } catch (err) {
      console.error('[Twilio] Message error:', err);
    }
  });

  ws.on('close', () => {
    console.log('[Twilio] WebSocket closed');
    if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
  });

  ws.on('error', console.error);
});
