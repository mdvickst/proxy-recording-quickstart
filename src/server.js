require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const { client, authHeader } = require('./twilio');
const store = require('./store');
const orchestrator = require('./orchestrator');

const { PROXY_SERVICE_SID, RECORDING_CONFIGURATION_ID, PORT = 3000 } = process.env;
const proxy = client.proxy.v1.services(PROXY_SERVICE_SID);
const settings = { orchestrator: false, recording: false };

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * Starts a recording on a call using the chained Recording Configuration and stores the result. Retries every 2s for up to 60s while Twilio reports the call not yet eligible (21220), stopping early if the call ends.
 * @param {string} callSid Call SID to record.
 * @returns {Promise<void>} Never rejects; failures are stored as `recordingError`.
 */
async function startRecording(callSid) {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const rec = await client.calls(callSid).recordings.create({ recordingConfigurationId: RECORDING_CONFIGURATION_ID });
      store.linkRecording(callSid, rec.sid);
      store.call(callSid).recordingStatus = rec.status;
      delete store.call(callSid).recordingError;
      console.log('recording started', callSid, rec.sid, `(attempt ${attempt})`);
      return;
    } catch (err) {
      const ended = err.code === 21220 && TERMINAL_CALL_STATUSES.includes((await client.calls(callSid).fetch()).status);
      if (err.code !== 21220 || ended) {
        store.call(callSid).recordingError = err.message;
        console.error('recording failed', callSid, err.code, err.message);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  store.call(callSid).recordingError = 'Call never became eligible for recording';
  console.error('recording failed', callSid, 'call never became eligible');
}

const TERMINAL_CALL_STATUSES = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];

/**
 * Returns a call's current status, fetching it from the Calls API when Proxy's reported status is not terminal. Terminal results are cached.
 * @param {string} sid Resource SID from the interaction (CA… for calls).
 * @param {string} proxyStatus Status reported on the Proxy interaction.
 * @returns {Promise<string>} Call status, or `proxyStatus` for non-call resources or on fetch failure.
 */
async function callStatus(sid, proxyStatus) {
  if (!sid?.startsWith('CA') || TERMINAL_CALL_STATUSES.includes(proxyStatus)) return proxyStatus;
  const cached = store.get(sid)?.callStatus;
  if (cached) return cached;
  try {
    const { status } = await client.calls(sid).fetch();
    if (TERMINAL_CALL_STATUSES.includes(status)) store.call(sid).callStatus = status;
    return status;
  } catch {
    return proxyStatus;
  }
}

app.get('/api/settings', (req, res) => res.json(settings));

app.post('/api/settings', async (req, res) => {
  if (typeof req.body.orchestrator === 'boolean') {
    await orchestrator.setEnabled(req.body.orchestrator);
    settings.orchestrator = req.body.orchestrator;
  }
  if (typeof req.body.recording === 'boolean') settings.recording = req.body.recording;
  res.json(settings);
});

app.get('/api/calls/:callSid/orchestrator-transcript', async (req, res) => {
  res.json(await orchestrator.transcriptForCall(req.params.callSid));
});

app.get('/api/calls/:callSid/batch-transcript', (req, res) => {
  const payload = store.transcriptPayload(req.params.callSid);
  if (!payload) return res.status(404).json({ error: 'No batch transcript for this call' });
  res.attachment(`${req.params.callSid}-transcript.json`).json(payload);
});

app.get('/api/recordings/:sid', async (req, res) => {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${req.params.sid}.mp3`;
  const media = await fetch(url, { headers: { Authorization: authHeader } });
  if (!media.ok) return res.status(media.status).json({ error: `Recording fetch failed: ${media.status}` });
  res.attachment(`${req.params.sid}.mp3`).type('audio/mpeg').send(Buffer.from(await media.arrayBuffer()));
});

app.post('/api/sessions', async (req, res) => {
  const session = await proxy.sessions.create({});
  for (const identifier of [req.body.a, req.body.b]) {
    await proxy.sessions(session.sid).participants.create({ identifier });
  }
  res.json({ sid: session.sid });
});

app.get('/api/sessions', async (req, res) => {
  const sessions = await proxy.sessions.list({ limit: 10 });
  const result = await Promise.all(sessions.map(async (s) => {
    const [participants, interactions] = await Promise.all([
      proxy.sessions(s.sid).participants.list(),
      proxy.sessions(s.sid).interactions.list({ limit: 50 }),
    ]);
    return {
      sid: s.sid,
      status: s.status,
      dateCreated: s.dateCreated,
      participants: participants.map((p) => ({ identifier: p.identifier, proxyIdentifier: p.proxyIdentifier })),
      interactions: await Promise.all(interactions.map(async (i) => ({
        sid: i.sid,
        type: i.type,
        dateCreated: i.dateCreated,
        inboundSid: i.inboundResourceSid,
        inboundStatus: await callStatus(i.inboundResourceSid, i.inboundResourceStatus),
        outboundSid: i.outboundResourceSid,
        outboundStatus: await callStatus(i.outboundResourceSid, i.outboundResourceStatus),
        recording: store.get(i.inboundResourceSid) || null,
      }))),
    };
  }));
  result.sort((a, b) => new Date(b.dateCreated) - new Date(a.dateCreated));
  res.json(result);
});

app.delete('/api/sessions/:sid', async (req, res) => {
  await proxy.sessions(req.params.sid).remove();
  res.json({ ok: true });
});

app.post('/webhooks/proxy/intercept', (req, res) => {
  const { interactionSessionSid, interactionType, inboundResourceSid, inboundResourceStatus } = req.body;
  console.log('intercept', interactionSessionSid, interactionType, inboundResourceSid, inboundResourceStatus);
  res.sendStatus(200);
});

app.post('/webhooks/proxy/callback', (req, res) => {
  const { interactionSessionSid, interactionType, inboundResourceSid, inboundResourceStatus, outboundResourceSid, outboundResourceStatus } = req.body;
  console.log('callback', interactionSessionSid, interactionType, inboundResourceStatus, outboundResourceSid, outboundResourceStatus);
  res.sendStatus(200);
  if (settings.recording && /^voice$/i.test(interactionType) && outboundResourceStatus === 'initiated'
      && inboundResourceSid && !store.get(inboundResourceSid)?.recordingSid) {
    startRecording(inboundResourceSid);
  }
});

app.post('/webhooks/recording', (req, res) => {
  const { CallSid, RecordingSid, RecordingStatus, RecordingUrl } = req.body;
  console.log('recording', CallSid, RecordingSid, RecordingStatus);
  store.linkRecording(CallSid, RecordingSid);
  Object.assign(store.call(CallSid), { recordingStatus: RecordingStatus, recordingUrl: RecordingUrl });
  res.sendStatus(200);
});

app.post('/webhooks/transcription', async (req, res) => {
  const t = req.body;
  console.log('transcription', t.id, t.status, t.sourceId);
  res.sendStatus(200);
  try {
    const callSid = store.callForRecording(t.sourceId) || (await client.recordings(t.sourceId).fetch()).callSid;
    store.saveTranscriptPayload(callSid, t);
    store.call(callSid).transcription = {
      id: t.id,
      status: t.status,
      error: t.error || null,
      sentences: (t.sentences || []).map((s) => ({ channel: s.audioChannelIndex, start: s.startTimeSeconds, text: s.text })),
    };
  } catch (err) {
    console.error('transcription store failed', t.sourceId, err.message);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

orchestrator.isEnabled()
  .then((on) => { settings.orchestrator = on; })
  .catch((err) => console.error('could not read Orchestrator state:', err.message));

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
