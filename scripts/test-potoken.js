const { BG } = require('bgutils-js');

async function getPoToken() {
  // Step 1: Get the Innertube session config from YouTube
  console.log('Step 1: Fetching YouTube page...');
  const ytRes = await fetch('https://www.youtube.com/embed/dQw4w9WgXcQ', {
    headers: { 
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' 
    }
  });
  const html = await ytRes.text();
  
  // Look for INNERTUBE_API_KEY and visitor_data
  const apiKeyMatch = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
  const visitorMatch = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/);
  const baseJsMatch = html.match(/"jsUrl"\s*:\s*"([^"]+)"/);
  
  console.log('API Key:', apiKeyMatch?.[1]);
  console.log('Visitor Data:', visitorMatch?.[1]?.substring(0, 50));
  console.log('base.js:', baseJsMatch?.[1]);
  
  // Look for BotGuard/attestation config
  const bgConfigMatch = html.match(/"botguardData"\s*:\s*({[^}]+})/);
  console.log('BotGuard config:', bgConfigMatch?.[1]?.substring(0, 200));
  
  // Look for any token-related data
  const tokenMatch = html.match(/"token"\s*:\s*"([^"]+)"/);
  console.log('Token:', tokenMatch?.[1]?.substring(0, 50));

  // Now try to create Innertube with visitor_data
  if (visitorMatch?.[1]) {
    console.log('\nStep 2: Testing Innertube with visitor_data...');
    const { Innertube } = require('youtubei.js');
    const yt = await Innertube.create({
      retrieve_player: false,
      generate_session_locally: false,
      visitor_data: visitorMatch[1],
    });
    
    const info = await yt.getBasicInfo('dQw4w9WgXcQ', { client: 'IOS' });
    const af = (info.streaming_data?.adaptive_formats ?? []).filter(f => f.mime_type?.startsWith('audio/'));
    console.log('IOS with visitor_data - audio:', af.length, 'url:', !!af[0]?.url);
  }
  
  // Step 3: Try generating PoToken
  console.log('\nStep 3: Trying PoToken generation...');
  
  // Get the request key from YouTube's /get_botguard_data endpoint
  const bgRes = await fetch('https://www.youtube.com/youtubei/v1/att/get?key=' + (apiKeyMatch?.[1] || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'), {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20241126.01.00',
        }
      }
    })
  });
  
  if (bgRes.ok) {
    const bgData = await bgRes.json();
    console.log('BotGuard response:', JSON.stringify(bgData).substring(0, 300));
  } else {
    console.log('BotGuard fetch failed:', bgRes.status);
    const text = await bgRes.text();
    console.log('Response:', text.substring(0, 200));
  }
  
  // Step 4: Try PoToken.generatePlaceholder
  console.log('\nStep 4: Trying placeholder PoToken...');
  try {
    const placeholder = BG.PoToken.generatePlaceholder(18);
    console.log('Placeholder token:', placeholder);
    
    // Try Innertube with placeholder
    const { Innertube } = require('youtubei.js');
    const yt2 = await Innertube.create({
      retrieve_player: false,
      generate_session_locally: true,
      po_token: placeholder,
    });
    const info2 = await yt2.getBasicInfo('dQw4w9WgXcQ', { client: 'IOS' });
    const af2 = (info2.streaming_data?.adaptive_formats ?? []).filter(f => f.mime_type?.startsWith('audio/'));
    console.log('IOS with placeholder - audio:', af2.length, 'url:', !!af2[0]?.url);
  } catch(e) {
    console.log('Placeholder error:', e.message?.substring(0, 200));
  }
}

getPoToken().catch(e => console.log('Error:', e.message?.substring(0, 200)));
