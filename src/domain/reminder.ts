export type ParsedReminderContent = {
  body: string;
  targetUsernames: string[] | null;
};

export function normalizeUsernames(values: unknown[]): string[] {
  return Array.from(new Set(values
    .map((value) => String(value).replace(/^@/, "").trim())
    .filter((value) => value.length > 0)));
}

export function parseReminderContent(
  content: unknown,
  targetUsernamesJson?: unknown,
): ParsedReminderContent {
  if (typeof targetUsernamesJson === "string" && targetUsernamesJson.length > 0) {
    try {
      const parsedTargets = JSON.parse(targetUsernamesJson);
      if (Array.isArray(parsedTargets)) {
        return {
          body: typeof content === "string" ? content : "",
          targetUsernames: normalizeUsernames(parsedTargets),
        };
      }
    } catch {
      // Fall through to legacy content parsing.
    }
  }

  if (typeof content !== "string") return { body: "", targetUsernames: null };
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const targets = Array.isArray(parsed.target_usernames)
        ? normalizeUsernames(parsed.target_usernames)
        : null;
      return {
        body: typeof parsed.body === "string" ? parsed.body : content,
        targetUsernames: targets,
      };
    }
  } catch {
    // Plain-text mentor reminder.
  }
  return { body: content, targetUsernames: null };
}

export function shouldSendReminder(diffDays: number): boolean {
  return [7, 5, 3, 2, 1].includes(diffDays) || diffDays <= 0;
}

export function reminderMessage(
  dueDate: string,
  diffDays: number,
  missingMentions: string[],
): string {
  const mentions = missingMentions.join(" ");
  if (diffDays < 0) {
    return `締切日 (${dueDate}) を${Math.abs(diffDays)}日過ぎています。まだ "done" がついていない対象者: ${mentions}`;
  }
  if (diffDays === 0) {
    return `今日は締切日 (${dueDate}) です！まだ "done" がついていない対象者: ${mentions}`;
  }
  return `締切日 (${dueDate}) まであと ${diffDays}日です！まだ "done" がついていない対象者: ${mentions}`;
}
