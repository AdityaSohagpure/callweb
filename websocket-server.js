import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import fetch from 'node-fetch';

dotenv.config();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const PORT = process.env.PORT || 8000;

if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
  console.error('❌ Missing ElevenLabs API key or agent ID');
  process.exit(1);
}

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT }, () => {
  console.log(`[🌐 Server] Listening on ws://0.0.0.0:${PORT}`);
});

// async function getSignedUrl() {
//   const res = await fetch(
//     `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
//     {
//       headers: { 'xi-api-key': ELEVENLABS_API_KEY },
//     }
//   );

//   if (!res.ok) throw new Error(`Failed to get signed URL: ${res.statusText}`);
//   const { signed_url } = await res.json();
//    console.log('got signed_url')
//   return signed_url;
// }

async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      console.log('Failed to get signed URL: ${response.statusText}')

      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL:', error);
    throw error;
  }
}
wss.on('connection', async (twilioWs) => {
  console.log('[🔗 Twilio] Client connected');

  let streamSid = null;
  let customParameters = null;
  let elevenWs;

  try {
    const signedUrl = await getSignedUrl();
    console.log('[🔗 Connecting to ElevenLabs]:', signedUrl);

    elevenWs = new WebSocket(signedUrl);

    elevenWs.on('open', () => {
      console.log('[🧠 ElevenLabs] Connected ✅');

      const config = {
        type: 'conversation_initiation_client_data',
        dynamic_variables: {
          user_name: 'Caller',
          user_id: Date.now()
        },
        conversation_config_override: {
          agent: {
            prompt: {
              prompt: customParameters?.prompt || 'You are Gary from the phone store.',
            },
            first_message: customParameters?.first_message || 'Hey there! How can I help you today?',
          },
        }
      };

      elevenWs.send(JSON.stringify(config));
    });

    elevenWs.on('message', (data) => {
      console.log('[📩 ElevenLabs Raw]', data.toString());

      try {
        const message = JSON.parse(data);

        // 🧠 Audio Response
        if (message.type === 'audio') {
          const base64Payload = message.audio?.chunk || message.audio_event?.audio_base_64;
          if (base64Payload && streamSid) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: base64Payload }
            }));
          }
        }

        // 📝 Transcript
        if (message.type === 'transcript_response') {
          const transcript = message.transcript?.[0]?.content;
          if (transcript) {
            console.log(`[📝 Transcript] ${transcript}`);
          } else {
            console.log('[📝 Transcript] Empty transcript received');
          }
        }

        // 🔁 Interruption
        if (message.type === 'interruption') {
          twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        // 🔄 Ping/Pong
        if (message.type === 'ping') {
          elevenWs.send(JSON.stringify({
            type: 'pong',
            event_id: message.ping_event?.event_id,
          }));
        }

      } catch (err) {
        console.error('[⚠️ ElevenLabs] Message parse error:', err);
      }
    });

    elevenWs.on('close', (code, reason) => {
      console.log(`[🔌 ElevenLabs] Disconnected ❌ code=${code}, reason=${reason}`);
    });

    elevenWs.on('error', (err) => {
      console.error('[💥 ElevenLabs] WebSocket Error:', err);
    });

  } catch (err) {
    console.error('[🚨 ElevenLabs] Failed to connect:', err);
    twilioWs.close();
  }

  // 📞 Handle Twilio events
  twilioWs.on('message', (msg) => {
    try {
      const message = JSON.parse(msg);
      console.log('[📥 Twilio] Received:', message);

      switch (message.event) {
        case 'start':
          streamSid = message.start.streamSid;
          customParameters = message.start.customParameters || {};
          console.log(`[▶️ Twilio] Start stream: ${streamSid}`);
          break;

        case 'media':
          if (elevenWs?.readyState === WebSocket.OPEN) {
            elevenWs.send(JSON.stringify({
              user_audio_chunk: message.media.payload
            }));
          }
          break;

        case 'stop':
          console.log(`[⏹️ Twilio] Stop stream: ${streamSid}`);
          if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
          break;

        default:
          console.warn('[⚠️ Twilio] Unknown event:', message.event);
      }
    } catch (err) {
      console.error('[⚠️ Twilio] Message error:', err);
    }
  });

  twilioWs.on('close', () => {
    console.log('[🔌 Twilio] Client disconnected');
    if (elevenWs?.readyState === WebSocket.OPEN) elevenWs.close();
  });

  twilioWs.on('error', console.error);
});
