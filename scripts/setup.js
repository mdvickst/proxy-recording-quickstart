const fs = require('fs');
const path = require('path');
const { client, api, items } = require('../src/twilio');

const ENV_PATH = path.join(__dirname, '..', '.env');
const NAME = 'proxy-recording-quickstart';
const UNIQUE = 'proxy_recording_quickstart';
for (const key of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'PROXY_NUMBER_SIDS', 'PUBLIC_BASE_URL']) {
  if (!process.env[key]) {
    console.error(`Missing ${key} in .env`);
    process.exit(1);
  }
}
const base = process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes or replaces `key=value` in `.env` and sets it on `process.env`.
 * @param {string} key Env var name.
 * @param {string} value Env var value.
 */
function saveEnv(key, value) {
  let text = fs.readFileSync(ENV_PATH, 'utf8');
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : text.replace(/\n*$/, `\n${line}\n`);
  fs.writeFileSync(ENV_PATH, text);
  process.env[key] = value;
}

/** Creates or updates the Proxy Service webhooks and attaches every PROXY_NUMBER_SIDS number to its pool. */
async function ensureProxyService() {
  const opts = {
    interceptCallbackUrl: `${base}/webhooks/proxy/intercept`,
    callbackUrl: `${base}/webhooks/proxy/callback`,
  };
  let sid = process.env.PROXY_SERVICE_SID;
  if (sid) {
    await client.proxy.v1.services(sid).update(opts);
  } else {
    sid = (await client.proxy.v1.services.create({ uniqueName: NAME, ...opts })).sid;
    saveEnv('PROXY_SERVICE_SID', sid);
  }
  const attached = new Set((await client.proxy.v1.services(sid).phoneNumbers.list()).map((p) => p.sid));
  for (const pn of process.env.PROXY_NUMBER_SIDS.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!attached.has(pn)) await client.proxy.v1.services(sid).phoneNumbers.create({ sid: pn });
  }
  console.log('Proxy Service', sid);
}

/** Creates or updates the Transcription Configuration that posts results to /webhooks/transcription. */
async function ensureTranscriptionConfiguration() {
  const body = {
    unique_name: UNIQUE,
    description: 'Proxy recording quickstart batch transcription',
    configuration: {
      configurationType: 'Transcription',
      transcriptionEngine: 'twilio_managed',
      language: 'en-US',
      transcriptionStatusCallback: { url: `${base}/webhooks/transcription`, method: 'POST' },
      participantDefaults: [
        { audioChannelIndex: 1, type: 'CUSTOMER' },
        { audioChannelIndex: 2, type: 'HUMAN_AGENT' },
      ],
    },
  };
  const url = 'https://voice.twilio.com/v2/Configurations/Transcription';
  const id = process.env.TRANSCRIPTION_CONFIGURATION_ID;
  if (id) {
    await api('PUT', `${url}/${id}`, body);
  } else {
    saveEnv('TRANSCRIPTION_CONFIGURATION_ID', (await api('POST', url, body)).body.id);
  }
  console.log('Transcription Configuration', process.env.TRANSCRIPTION_CONFIGURATION_ID);
}

/** Creates or updates the dual-channel Recording Configuration chained to the Transcription Configuration. */
async function ensureRecordingConfiguration() {
  const body = {
    unique_name: UNIQUE,
    description: 'Proxy recording quickstart dual-channel recording',
    configuration: {
      configurationType: 'Recording',
      compositionPolicy: { channels: 'dual', trim: 'do-not-trim' },
      callRecordingStatusCallback: {
        url: `${base}/webhooks/recording`,
        method: 'POST',
        events: ['in-progress', 'completed'],
      },
      features: [{ type: 'transcriptionConfiguration', featureId: process.env.TRANSCRIPTION_CONFIGURATION_ID }],
    },
  };
  const url = 'https://voice.twilio.com/v2/Configurations/Recording';
  const id = process.env.RECORDING_CONFIGURATION_ID;
  if (id) {
    await api('PUT', `${url}/${id}`, body);
  } else {
    saveEnv('RECORDING_CONFIGURATION_ID', (await api('POST', url, body)).body.id);
  }
  console.log('Recording Configuration', process.env.RECORDING_CONFIGURATION_ID);
}

/** Creates the Memory Store if missing and waits until it is ACTIVE. Throws on FAILED or after ~5 minutes. */
async function ensureMemoryStore() {
  if (!process.env.MEMORY_STORE_ID) {
    const url = 'https://memory.twilio.com/v1/ControlPlane/Stores';
    const findStore = async () => items((await api('GET', `${url}?pageSize=50`)).body).find((s) => s.displayName === NAME);
    if (!(await findStore())) await api('POST', url, { displayName: NAME, description: 'Proxy recording quickstart' });
    for (let i = 0; i < 60 && !process.env.MEMORY_STORE_ID; i++) {
      const store = await findStore();
      if (store?.status === 'FAILED') throw new Error('Memory Store provisioning failed');
      if (store?.status === 'ACTIVE') saveEnv('MEMORY_STORE_ID', store.id);
      else await sleep(5000);
    }
    if (!process.env.MEMORY_STORE_ID) throw new Error('Timed out waiting for Memory Store');
  }
  console.log('Memory Store', process.env.MEMORY_STORE_ID);
}

/** Creates the Conversation Configuration (no voice capture rules) if missing. */
async function ensureConversationConfiguration() {
  if (!process.env.CONVERSATION_CONFIGURATION_ID) {
    const url = 'https://conversations.twilio.com/v2/ControlPlane/Configurations';
    const { body } = await api('POST', url, {
      displayName: NAME,
      description: 'Proxy recording quickstart',
      conversationGroupingType: 'GROUP_BY_PARTICIPANT_ADDRESSES_AND_CHANNEL_TYPE',
      memoryStoreId: process.env.MEMORY_STORE_ID,
      channelSettings: { VOICE: { captureRules: [] } },
    });
    let id = body?.related?.configurationId;
    for (let i = 0; i < 30 && !id; i++) {
      await sleep(2000);
      id = items((await api('GET', `${url}?pageSize=50`)).body).find((c) => c.displayName === NAME)?.id;
    }
    if (!id) throw new Error('Could not find created Conversation Configuration');
    saveEnv('CONVERSATION_CONFIGURATION_ID', id);
  }
  console.log('Conversation Configuration', process.env.CONVERSATION_CONFIGURATION_ID);
}

(async () => {
  await ensureProxyService();
  await ensureTranscriptionConfiguration();
  await ensureRecordingConfiguration();
  await ensureMemoryStore();
  await ensureConversationConfiguration();
  console.log('Setup complete. Webhooks point at', base);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
