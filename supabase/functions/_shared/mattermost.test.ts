import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { getUserGroupByName, getUserGroupMembers } from "./mattermost.ts";

Deno.test("resolves a referenceable User Group and all of its members", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  const firstPageMembers = Array.from({ length: 200 }, (_, index) => ({
    id: `user-${index}`,
    username: `member-${index}`,
  }));

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input.toString(), "https://mattermost.example.com");
    requestedUrls.push(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/v4/groups") {
      const query = url.searchParams.get("q");
      const groups = query === "26creators"
        ? [
          { id: "similar-group", name: "26creators-alumni" },
          { id: "target-group", name: "26creators" },
        ]
        : [];
      return Promise.resolve(Response.json(groups));
    }

    if (url.pathname === "/api/v4/groups/target-group/members") {
      const page = Number(url.searchParams.get("page"));
      return Promise.resolve(Response.json({
        members: page === 0
          ? firstPageMembers
          : [{ id: "user-200", username: "member-200" }],
        total_member_count: 201,
      }));
    }

    return Promise.resolve(
      Response.json({ message: "Not found" }, { status: 404 }),
    );
  }) as typeof fetch;

  try {
    const group = await getUserGroupByName("@26creators");
    assertEquals(group, { id: "target-group", name: "26creators" });
    assert(group !== null);
    assertEquals(await getUserGroupByName("@missing-group"), null);

    const members = await getUserGroupMembers(group.id);
    assertEquals(members.length, 201);
    assertEquals(members[0], { id: "user-0", username: "member-0" });
    assertEquals(members[200], { id: "user-200", username: "member-200" });
    assertEquals(requestedUrls, [
      "/api/v4/groups?q=26creators&filter_allow_reference=true&per_page=200",
      "/api/v4/groups?q=missing-group&filter_allow_reference=true&per_page=200",
      "/api/v4/groups/target-group/members?page=0&per_page=200",
      "/api/v4/groups/target-group/members?page=1&per_page=200",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
