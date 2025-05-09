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

async function getSignedUrl() {
  console.log('getsignedUrl start');
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: 'GET',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL:', error);
    throw error;
  }
}

wss.on('connection', (twilioWs) => {
  console.log('[🔗 Twilio] Client connected');

  let streamSid = null;
  let customParameters = null;
  let elevenWs = null;

  twilioWs.on('message', async (msg) => {
    try {
      const message = JSON.parse(msg);

      switch (message.event) {
        case 'start':
          streamSid = message.start.streamSid;
          customParameters = message.start.customParameters || {};
          console.log(`[▶️ Twilio] Start stream: ${streamSid}`);

          try {
            const signedUrl = await getSignedUrl();
            console.log('[🔗 Connecting to ElevenLabs]:', signedUrl);

            elevenWs = new WebSocket(signedUrl);

            elevenWs.on('open', () => {
              console.log('[ ElevenLabs] Connected ✅');

              const config = {
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
                      customParameters?.first_message ||
                      'Hey there! How can I help you today?',
                  },
                },
              };

              elevenWs.send(JSON.stringify(config));
            });

            elevenWs.on('message', (data) => {
              try {
                const message = JSON.parse(data);

                switch (message.type) {
                  case 'conversation_initiation_metadata':
                    console.log('[ElevenLabs] Received initiation metadata');
                    break;

                  case 'audio':
                    if (streamSid) {
                      const payload =
                        message.audio?.chunk || message.audio_event?.audio_base_64;
                      if (payload) {
                        twilioWs.send(
                          JSON.stringify({
                            event: 'media',
                            streamSid,
                            media: { payload },
                          })
                        );
                      }
                    } else {
                      console.log('[ElevenLabs] Received audio but no StreamSid yet');
                    }
                    break;

                  case 'interruption':
                    if (streamSid) {
                      twilioWs.send(
                        JSON.stringify({
                          event: 'clear',
                          streamSid,
                        })
                      );
                    }
                    break;

                  case 'ping':
                    if (message.ping_event?.event_id) {
                      elevenWs.send(
                        JSON.stringify({
                          type: 'pong',
                          event_id: message.ping_event.event_id,
                        })
                      );
                    }
                    break;

                  case 'agent_response':
                    console.log(
                      `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                    );
                    break;

                  case 'user_transcript':
                    console.log(
                      `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                    );
                    break;

                  default:
                    console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
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

          break;

        case 'media':
          if (elevenWs?.readyState === WebSocket.OPEN) {
            elevenWs.send(
              JSON.stringify({
                user_audio_chunk: message.media.payload,
              })
            );
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
