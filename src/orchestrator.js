const { client, api, items } = require('./twilio');

const CONVERSATIONS = 'https://conversations.twilio.com/v2';
const configUrl = () => `${CONVERSATIONS}/ControlPlane/Configurations/${process.env.CONVERSATION_CONFIGURATION_ID}`;

/**
 * Returns the E.164 numbers in the Proxy Service's number pool.
 * @returns {Promise<string[]>} Phone numbers.
 */
async function proxyNumbers() {
  const list = await client.proxy.v1.services(process.env.PROXY_SERVICE_SID).phoneNumbers.list();
  return list.map((p) => p.phoneNumber);
}

/**
 * Reports whether the Conversation Configuration currently has any voice capture rules.
 * @returns {Promise<boolean>} True when at least one VOICE capture rule exists.
 */
async function isEnabled() {
  const { body } = await api('GET', configUrl());
  return (body.channelSettings?.VOICE?.captureRules || []).length > 0;
}

/**
 * Replaces the configuration's VOICE capture rules: one inbound PSTN rule (`* → proxy number`) for every proxy number when enabled, none when disabled.
 * @param {boolean} enabled Desired state.
 * @returns {Promise<void>} Resolves once Twilio accepts the update (applied asynchronously).
 */
async function setEnabled(enabled) {
  const { body: cfg } = await api('GET', configUrl());
  const captureRules = enabled
    ? (await proxyNumbers()).map((n) => ({ from: '*', to: n, metadata: { callType: 'PSTN' } }))
    : [];
  await api('PUT', configUrl(), {
    displayName: cfg.displayName,
    description: cfg.description,
    conversationGroupingType: cfg.conversationGroupingType,
    memoryStoreId: cfg.memoryStoreId,
    memoryExtractionEnabled: cfg.memoryExtractionEnabled ?? false,
    intelligenceConfigurationIds: cfg.intelligenceConfigurationIds || [],
    statusCallbacks: cfg.statusCallbacks || [],
    channelSettings: { ...(cfg.channelSettings || {}), VOICE: { captureRules } },
  });
}

/**
 * Returns the utterances Conversation Orchestrator captured for a call, oldest first.
 * @param {string} callSid Call SID.
 * @returns {Promise<Array<{at: string, author: string, text: string}>>} Transcript lines.
 */
async function transcriptForCall(callSid) {
  const { body } = await api('GET', `${CONVERSATIONS}/Conversations?channelId=${callSid}&pageSize=10`);
  const lines = [];
  for (const conv of items(body)) {
    const { body: comms } = await api('GET', `${CONVERSATIONS}/Conversations/${conv.id}/Communications?pageSize=100`);
    for (const c of items(comms)) {
      if (c.channelId !== callSid) continue;
      lines.push({
        at: c.occurredAt || c.createdAt || '',
        author: c.author?.address || c.author?.name || '',
        text: c.content?.text ?? '',
      });
    }
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

module.exports = { isEnabled, setEnabled, transcriptForCall };
