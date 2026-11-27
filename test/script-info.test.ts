// E9-277 — the info sheet's addresses (src/community/script-info.ts).

import { describe, expect, it } from "vitest";
import {
  githubRepo,
  headerComment,
  inRepo,
  linesSlug,
  linesTopic,
  onLines,
  readmeName,
  relayImage,
  searchHit,
  searchPath,
  topicPage,
  topicPath,
} from "../src/community/script-info.js";

describe("where a script's documentation and discussion are", () => {
  it("reads a repository out of the catalogue's address", () => {
    expect(githubRepo("https://github.com/schollz/makebreakbeat")).toEqual({ owner: "schollz", repo: "makebreakbeat" });
    expect(githubRepo("https://github.com/tehn/awake.git")).toEqual({ owner: "tehn", repo: "awake" });
    expect(githubRepo("https://github.com/a/b/tree/main/x")).toEqual({ owner: "a", repo: "b" });
    expect(githubRepo("https://gitlab.com/a/b")).toBeNull();
    expect(githubRepo(null)).toBeNull();
  });

  it("reads the topic number out of every spelling of a lines thread", () => {
    expect(linesTopic("https://llllllll.co/t/makebreakbeat/53301")).toBe(53301);
    expect(linesTopic("https://llllllll.co/t/53301")).toBe(53301);
    expect(linesTopic("https://llllllll.co/t/makebreakbeat/53301/12")).toBe(53301);
    expect(linesTopic("https://l.llllllll.co/t/awake/21022/")).toBe(21022);
    expect(linesTopic("https://talk.splines.cc/t/x/12")).toBeNull();
    expect(topicPath(53301, 2)).toBe("/info-relay/lines/53301/2.json");
  });

  it("names a thread that has no number, and picks what a search found for it", () => {
    expect(linesSlug("https://llllllll.co/t/bitters-norns")).toBe("bitters-norns");
    expect(linesSlug("https://llllllll.co/t/delinquencer-a-sequencer-but-with-a-mind-of-its-own/")).toBe(
      "delinquencer-a-sequencer-but-with-a-mind-of-its-own",
    );
    expect(linesSlug("https://l.llllllll.co/cheat-codes-2")).toBe("cheat-codes-2");
    expect(linesSlug("https://llllllll.co/t/awake/21022")).toBeNull();
    expect(topicPath("bitters-norns", 1)).toBe("/info-relay/lines/s/bitters-norns/1.json");
    expect(searchPath("cheat-codes-2")).toBe("/info-relay/lines/q/cheat-codes-2.json");
    const found = {
      topics: [
        { id: 31655, slug: "cheat-codes-v1-3-1-may-4-2020", title: "cheat codes v1.3.1" },
        { id: 38414, slug: "cheat-codes-2-rev-250929-lts13-3", title: "cheat codes 2" },
      ],
    };
    expect(searchHit(found, "cheat-codes-2")).toEqual({ id: 38414, title: "cheat codes 2" });
    expect(searchHit(found, "nothing-like-it")).toEqual({ id: 31655, title: "cheat codes v1.3.1" });
    expect(searchHit({ topics: [] }, "x")).toBeNull();
  });

  it("finds the README in a folder, the Markdown one first", () => {
    expect(readmeName(["x.lua", "README.md", "lib"])).toBe("README.md");
    expect(readmeName(["readme.txt", "Readme.markdown"])).toBe("Readme.markdown");
    expect(readmeName(["README"])).toBe("README");
    expect(readmeName(["x.lua"])).toBeNull();
  });

  it("takes a script's opening comment, as norns shows it in SELECT", () => {
    const src = "﻿-- awake: time changes\n-- 2.8.0 @tehn\n--\n-- E1 changes modes\n--\n\nengine.name = 'PolyPerc'\n-- not this\n";
    expect(headerComment(src)).toBe("awake: time changes\n2.8.0 @tehn\n\nE1 changes modes");
    expect(headerComment("\n\n-- a\r\n-- b\r\nx = 1")).toBe("a\nb");
    expect(headerComment("--[[ block ]]\nx = 1")).toBeNull();
    expect(headerComment("x = 1")).toBeNull();
  });

  it("keeps a README's relative paths inside its repository", () => {
    expect(inRepo("docs/a.png")).toBe("docs/a.png");
    expect(inRepo("./img/b.gif?raw=true")).toBe("img/b.gif");
    expect(inRepo("lib/../c.png")).toBe("c.png");
    expect(inRepo("../../etc/passwd")).toBeNull();
  });

  it("sends a picture through the page's server only when the relay takes it", () => {
    expect(relayImage("https://user-images.githubusercontent.com/1/a.png")).toBe(
      "/info-relay/img/user-images.githubusercontent.com/1/a.png",
    );
    expect(relayImage("//llllllll.co/uploads/default/original/1X/a.png")).toBe(
      "/info-relay/img/llllllll.co/uploads/default/original/1X/a.png",
    );
    expect(relayImage("https://example.com/a.png")).toBeNull();
    expect(relayImage("javascript:alert(1)")).toBeNull();
    expect(onLines("/u/tehn")).toBe("https://llllllll.co/u/tehn");
  });
});

describe("a page of a topic", () => {
  it("takes what the sheet shows from Discourse's JSON, and leaves the rest", () => {
    const t = topicPage({
      title: "makebreakbeat",
      posts_count: 57,
      post_stream: {
        posts: [
          {
            post_number: 1,
            post_type: 1,
            name: "Zack",
            username: "infinitedigits",
            avatar_template: "/user_avatar/llllllll.co/infinitedigits/{size}/84517_2.png",
            created_at: "2022-03-04T15:14:02.847Z",
            cooked: "<p>make break beats.</p>",
          },
          { post_number: 2, post_type: 3, cooked: "<p>closed</p>" },
          { post_number: 3, post_type: 1, username: "x", cooked: 7 },
        ],
      },
    });
    expect(t.title).toBe("makebreakbeat");
    expect(t.postsCount).toBe(57);
    expect(t.posts.map((p) => p.number)).toEqual([1, 3]);
    expect(t.posts[0]!.avatar).toBe("https://llllllll.co/user_avatar/llllllll.co/infinitedigits/90/84517_2.png");
    expect(t.posts[1]!.html).toBe("");
    expect(topicPage(null)).toEqual({ id: 0, title: "", postsCount: 0, posts: [] });
  });
});
