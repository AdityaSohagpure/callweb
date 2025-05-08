import WebSocket from 'ws';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const API_KEY = process.env.ELEVENLABS_API_KEY;
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

async function testConnection() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
    { headers: { 'xi-api-key': API_KEY } }
  );

  if (!res.ok) {
    console.error('❌ Failed to fetch signed URL:', await res.text());
    return;
  }

  const { signed_url } = await res.json();
  console.log('🔗 Connecting to:', signed_url);

  const ws = new WebSocket(signed_url);

  ws.on('open', () => {
    console.log('[🧠 ElevenLabs] Connected ✅');
    ws.close();
  });

  ws.on('error', (err) => {
    console.error('[❌ WebSocket error]', err);
  });

  ws.on('close', () => {
    console.log('[🔌 ElevenLabs] Disconnected');
  });
}

testConnection();
