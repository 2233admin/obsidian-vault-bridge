/**
 * ingest -- markdown chunker + OpenAI embedding client.
 * Graceful degradation: if OPENAI_API_KEY missing, embedTexts returns [].
 */

const CHARS_PER_TOKEN = 4;
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings";
const EMBED_BATCH_SIZE = 20;

/**
 * Chunk markdown content into approximately `maxTokens`-sized chunks.
 * Splits on \n\n first, merges small paragraphs, hard-splits oversized ones.
 * Overlap: prepend the last `overlap` tokens of previous chunk to next chunk.
 */
export function chunkMarkdown(content: string, maxTokens = 512, overlap = 64): string[] {
  if (!content.trim()) return [];

  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlap * CHARS_PER_TOKEN;

  // Split into paragraphs
  const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  // First pass: break oversized paragraphs by sentence, then hard-split
  const normalized: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      normalized.push(para);
      continue;
    }
    // Split by sentence ". " while preserving delimiter
    const sentences = para.split(/(?<=\.\s)/);
    let buf = "";
    for (const sent of sentences) {
      if ((buf + sent).length > maxChars && buf) {
        normalized.push(buf);
        buf = sent;
      } else {
        buf += sent;
      }
    }
    if (buf) normalized.push(buf);

    // If any piece still too large, hard-split
    const finalPieces: string[] = [];
    for (const piece of normalized.splice(normalized.length - (buf ? 1 : 0))) {
      if (piece.length <= maxChars) {
        finalPieces.push(piece);
      } else {
        for (let i = 0; i < piece.length; i += maxChars) {
          finalPieces.push(piece.slice(i, i + maxChars));
        }
      }
    }
    normalized.push(...finalPieces);
  }

  // Second pass: merge small paragraphs up to maxChars
  const chunks: string[] = [];
  let current = "";
  for (const para of normalized) {
    if (!current) {
      current = para;
      continue;
    }
    const combined = current + "\n\n" + para;
    if (combined.length <= maxChars) {
      current = combined;
    } else {
      chunks.push(current);
      current = para;
    }
  }
  if (current) chunks.push(current);

  // Third pass: apply overlap -- prepend tail of previous chunk to next
  if (overlapChars > 0 && chunks.length > 1) {
    const withOverlap: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const tail = prev.slice(Math.max(0, prev.length - overlapChars));
      withOverlap.push(tail + "\n\n" + chunks[i]);
    }
    return withOverlap;
  }

  return chunks;
}

/**
 * Embed texts via OpenAI text-embedding-3-small.
 * Returns [] if OPENAI_API_KEY missing or request fails (non-fatal).
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    try {
      const response = await fetch(OPENAI_EMBEDDING_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_EMBEDDING_MODEL,
          input: batch,
        }),
      });

      if (!response.ok) {
        console.warn(`[vaultbrain] embedding request failed: ${response.status}`);
        return [];
      }

      const data = await response.json() as { data: Array<{ embedding: number[] }> };
      for (const item of data.data) {
        allEmbeddings.push(item.embedding);
      }
    } catch (err) {
      console.warn(`[vaultbrain] embedding request error: ${(err as Error).message}`);
      return [];
    }
  }

  return allEmbeddings;
}
