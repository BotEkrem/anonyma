/**
 * One reaction per person: picking an emoji moves the person's reaction there,
 * picking the same emoji again takes it off. Empty emoji lists are dropped.
 */
export function toggleReaction(
  current: Record<string, string[]>,
  sessionId: string,
  emoji: string,
): Record<string, string[]> {
  const wasOn = (current[emoji] ?? []).includes(sessionId);
  const next: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(current)) {
    const kept = ids.filter((id) => id !== sessionId);
    if (kept.length > 0) next[key] = kept;
  }
  if (!wasOn) next[emoji] = [...(next[emoji] ?? []), sessionId];
  return next;
}
