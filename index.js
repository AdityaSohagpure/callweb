require('dotenv').config();
const WebSocket = require('ws');
const axios = require('axios');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ host: '0.0.0.0', port: PORT });

wss.on('connection', (ws) => {
  console.log('🔗 Client connected');
  let audioStream = [];

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data); // Twilio sends JSON
    } catch (err) {
      console.error(" Invalid JSON received:", err);
      return;
    }

    if (msg.event === 'media' && msg.media && msg.media.payload) {
      const audioBuffer = Buffer.from(msg.media.payload, 'base64');
      audioStream.push(audioBuffer);

      try {
        const transcribedText = await transcribeAudio(audioStream);
        console.log(" Transcribed text:", transcribedText);

        const responseText = await generateAIResponse(transcribedText);
        const audioResponse = await textToSpeech(responseText);

        // Send base64-encoded audio back to client
        ws.send(audioResponse.toString('base64'));
        audioStream = []; // Clear after response (or debounce)
      } catch (err) {
        console.error(" Error in pipeline:", err);
        ws.send("Error processing audio.");
      }
    }
  });

  ws.on('close', () => console.log('❎ Client disconnected'));
  ws.on('error', (error) => console.error('WebSocket error:', error));
});

async function transcribeAudio(audioBuffers) {
  // TODO: Combine & send to real ASR (e.g., Deepgram, Whisper)
  return "Hello, how can I assist you today?";
}

async function generateAIResponse(text) {
  // TODO: Use OpenAI API (or other) here
  return `The AI says: I can assist you with that!`;
}

async function textToSpeech(text) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID; // e.g. "EXAVITQu4vr4xnSDxMaL"
  const apiKey = process.env.ELEVENLABS_API_KEY;

  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    },
    {
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer' // binary audio
    }
  );

  return Buffer.from(response.data);
}

console.log(` WebSocket server listening on ws://localhost:${PORT}`);
