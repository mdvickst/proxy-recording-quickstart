const calls = new Map();
const recordingToCall = new Map();

/**
 * Returns the mutable state record for a Call SID, creating it if absent.
 * @param {string} callSid Call SID.
 * @returns {object} State record.
 */
function call(callSid) {
  if (!calls.has(callSid)) calls.set(callSid, {});
  return calls.get(callSid);
}

/**
 * Returns the state record for a Call SID without creating one.
 * @param {string} callSid Call SID.
 * @returns {object|undefined} State record.
 */
function get(callSid) {
  return calls.get(callSid);
}

/**
 * Associates a Recording SID with a Call SID.
 * @param {string} callSid Call SID.
 * @param {string} recordingSid Recording SID.
 */
function linkRecording(callSid, recordingSid) {
  call(callSid).recordingSid = recordingSid;
  recordingToCall.set(recordingSid, callSid);
}

/**
 * Returns the Call SID previously linked to a Recording SID.
 * @param {string} recordingSid Recording SID.
 * @returns {string|undefined} Call SID.
 */
function callForRecording(recordingSid) {
  return recordingToCall.get(recordingSid);
}

const transcriptPayloads = new Map();

/**
 * Saves the full batch transcription webhook payload for a Call SID.
 * @param {string} callSid Call SID.
 * @param {object} payload Transcription webhook body.
 */
function saveTranscriptPayload(callSid, payload) {
  transcriptPayloads.set(callSid, payload);
}

/**
 * Returns the saved batch transcription webhook payload for a Call SID.
 * @param {string} callSid Call SID.
 * @returns {object|undefined} Transcription webhook body.
 */
function transcriptPayload(callSid) {
  return transcriptPayloads.get(callSid);
}

module.exports = { call, get, linkRecording, callForRecording, saveTranscriptPayload, transcriptPayload };
