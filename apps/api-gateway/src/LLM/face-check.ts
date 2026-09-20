import type { LlmClient } from './llm';

export interface SelfieVerdict {
  accepted: boolean;
  reason: string;
}

const SELFIE_CHECK_PROMPT = `
You are verifying a safety selfie for a ride-sharing service. Look at the image and decide whether it is a usable verification photo of the person themselves.

ACCEPT only when ALL of these hold:
- The image clearly shows exactly ONE real, live human face (front-facing or near-front).
- It is a genuine photograph, not a cartoon, drawing, AI render, meme, or emoji.
- It is not an animal, object, landscape, screenshot of text, or a photo of a photo/screen.
- The face is reasonably visible (not fully masked, not pitch-dark, not extremely blurred).

Return ONLY a JSON object:
{"isRealHumanFace": true|false, "reason": "<short reason>"}
`.trim();

/**
 * Guardrail for the WhatsApp group-ride selfie step: riders must send a real
 * photo of a human face, not their dog, a meme, or a screenshot. Fails OPEN
 * when the vision model is unconfigured or down — an LLM outage must not
 * block every group ride — with a warning log so the gap is visible.
 */
export async function verifySelfiePhoto(
  groq: LlmClient,
  imageBuffer: Buffer,
  mimeType: string,
): Promise<SelfieVerdict> {
  if (!groq.configured) {
    console.warn('[face-check] Groq unconfigured — accepting selfie without verification');
    return { accepted: true, reason: 'verification unavailable' };
  }

  try {
    const result = await groq.completeVisionJson(SELFIE_CHECK_PROMPT, imageBuffer, mimeType);
    if (!result) {
      console.warn('[face-check] no verdict from vision model — accepting selfie');
      return { accepted: true, reason: 'verification unavailable' };
    }

    const accepted = result['isRealHumanFace'] === true;
    const reason = typeof result['reason'] === 'string' ? result['reason'] : '';
    if (!accepted) {
      console.info('[face-check] selfie rejected', { reason });
    }
    return { accepted, reason };
  } catch (error) {
    console.warn('[face-check] verification failed — accepting selfie', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { accepted: true, reason: 'verification unavailable' };
  }
}
