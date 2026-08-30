import { afterEach, describe, expect, it, vi } from "vitest";
import { MattermostClient } from "../src/mattermost";
import { expandMentions, extractPostId, secureEqual } from "../src/routes/slash";

const env = {
  MATTERMOST_URL: "https://mattermost.example.test",
  MATTERMOST_BOT_TOKEN: "bot-token",
  MATTERMOST_MENTOR_GROUP_ID: "mentor-group",
  MATTERMOST_SUMMARY_CHANNEL: "summary-channel",
};

afterEach(() => vi.unstubAllGlobals());

describe("slash helpers", () => {
  it("extracts Mattermost post ids from ids and links", () => {
    const id = "abcdefghijklmnopqrstuvwxyz";
    expect(extractPostId(id)).toBe(id);
    expect(extractPostId(`https://mm.example/pl/${id}`)).toBe(id);
    expect(extractPostId("invalid")).toBeNull();
  });

  it("compares tokens without exposing them", async () => {
    expect(await secureEqual("same", "same")).toBe(true);
    expect(await secureEqual("same", "different")).toBe(false);
  });

  it("resolves an exact User Group and all 201 members", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      id: `user-${index}`,
      username: `member-${index}`,
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/users/username/creators")) {
        return new Response("{}", { status: 404 });
      }
      if (url.includes("/api/v4/groups?")) {
        return Response.json([
          { id: "similar", name: "creators-old" },
          { id: "target", name: "creators" },
        ]);
      }
      if (url.includes("/groups/target/members?page=0")) {
        return Response.json({ members: firstPage, total_member_count: 201 });
      }
      if (url.includes("/groups/target/members?page=1")) {
        return Response.json({
          members: [{ id: "user-200", username: "member-200" }],
          total_member_count: 201,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await expandMentions(["@creators"], new MattermostClient(env));
    expect(result.unresolvedMentions).toEqual([]);
    expect(result.targetUsernames).toHaveLength(201);
    expect(result.targetUsernames.at(-1)).toBe("member-200");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("normalizes Mattermost's null no-reactions response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(null)));
    await expect(new MattermostClient(env).getReactions("post-id")).resolves.toEqual([]);
  });
});
