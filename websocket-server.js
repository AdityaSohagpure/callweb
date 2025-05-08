import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import fetch from 'node-fetch';

dotenv.config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const PORT = process.env.PORT || 8000;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT }, () => {
  console.log(`[✅ Server] Listening on ws://0.0.0.0:${PORT}`);
});

async function getSignedUrl() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
  );

  if (!res.ok) throw new Error(`Failed to get signed URL: ${res.statusText}`);
  const { signed_url } = await res.json();
  return signed_url;
}

wss.on('connection', async (ws) => {
  console.log('[🔗 Twilio] Client connected');

  let streamSid = null;
  let elevenWs = null;
  let customParameters = null;

  try {
    const signedUrl = await getSignedUrl();
    elevenWs = new WebSocket(signedUrl);

    elevenWs.on('open', () => {
      console.log('[🧠 ElevenLabs] Connected');

      const init = {
        type: 'conversation_initiation_client_data',
        dynamic_variables: {
          user_name: 'Caller',
          user_id: Date.now(),
        },
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: customParameters?.prompt || 'You are Gary from the phone store.',
            },
            first_message:
              customParameters?.first_message || 'Hey there! How can I help you today?',
          },
        },
      };

      elevenWs.send(JSON.stringify(init));
    });

    elevenWs.on('message', (data) => {
      try {
        console.log('[📩 ElevenLabs Raw]', data.toString());

        const message = JSON.parse(data);

        // Handle audio from ElevenLabs to Twilio
        if (message.type === 'audio') {
          const base64Payload =
            message.audio?.chunk || message.audio_event?.audio_base_64;

          if (base64Payload && streamSid) {
            ws.send(
              JSON.stringify({
                event: 'media',
                streamSid,
                media: { payload: base64Payload },
              })
            );
          }
        }

        // Handle transcript
        if (message.type === 'transcript_response') {
          const transcript = message.transcript?.[0]?.content;
          if (transcript) {
            console.log(`[📝 Transcript] ${transcript}`);
          } else {
            console.log('[📝 Transcript] Empty transcript received');
          }
        }

        // Handle interruption
        if (message.type === 'interruption') {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        // Handle ping
        if (message.type === 'ping') {
          elevenWs.send(
            JSON.stringify({
              type: 'pong',
              event_id: message.ping_event?.event_id,
            })
          );
        }

      } catch (err) {
        console.error('[ElevenLabs] Message error:', err);
      }
    });

    elevenWs.on('close', () => {
      console.log('[🧠 ElevenLabs] Connection closed');
    });

    elevenWs.on('error', (err) => {
      console.error('[ElevenLabs] WebSocket error:', err);
    });

  } catch (err) {
    console.error('[Server] Failed to connect to ElevenLabs:', err);
    ws.close();
  }

  ws.on('message', (msg) => {
    try {
      const message = JSON.parse(msg);
      console.log('[📥 Twilio] Received:', message);

      switch (message.event) {
        case 'start':
          streamSid = message.start.streamSid;
          customParameters = message.start.customParameters || {};
          console.log(`[🎤 Twilio] Start stream: ${streamSid}`);
          break;

        case 'media':
          if (elevenWs?.readyState === WebSocket.OPEN) {
            elevenWs.send(
              JSON.stringify({
                type: 'user_audio_chunk',
                audio_chunk_base64: message.media.payload,
                encoding: 'mulaw',
                sample_rate: 8000,
              })
            );
          }
          break;

        case 'stop':
          console.log(`[🛑 Twilio] Stop stream: ${streamSid}`);
          if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
          break;

        default:
          console.warn('[Twilio] Unknown event:', message.event);
      }
    } catch (err) {
      console.error('[Twilio] JSON parse error:', err);
    }
  });

  ws.on('close', () => {
    console.log('[🔌 Twilio] Client disconnected');
    if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
  });

  ws.on('error', console.error);
});
