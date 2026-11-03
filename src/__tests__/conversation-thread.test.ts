import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { ChannelType } from "discord.js";
import type { InboundMessage } from "@the-metafactory/cortex/surface-sdk";
import { DiscordAdapter, type AdapterAgentIdentity, type DiscordAdapterInfra } from "../index";
import type { DiscordPresence } from "../schema";
import { NO_POLICY_PORT, fallbackFormatEnvelope } from "../plugin";

const BOT_ID = "fake-bot-id";
const quiet = { warn: console.warn, log: console.log, error: console.error };
beforeEach(() => { console.warn = () => {}; console.log = () => {}; console.error = () => {}; });
afterEach(() => { console.warn = quiet.warn; console.log = quiet.log; console.error = quiet.error; });

interface Sent { content: string; nonce: string; enforceNonce: boolean; allowedMentions: unknown }
class FakePrivateThread {
  type: ChannelType = ChannelType.PrivateThread;
  ownerId = BOT_ID;
  sent: Sent[] = [];
  deleted = false;
  sendError: (Error & { status?: number }) | null = null;
  membersError: Error | null = null;
  history = [
    { id: "m-2", author: { id: BOT_ID }, content: "second", createdAt: new Date("2026-11-03T10:00:02Z") },
    { id: "m-1", author: { id: "principal" }, content: "first", createdAt: new Date("2026-11-03T10:00:01Z") },
  ];
  constructor(public id: string, public memberIds: string[] = [BOT_ID, "principal"]) {}
  members = {
    fetch: async () => {
      if (this.membersError) throw this.membersError;
      return new Map(this.memberIds.map((id) => [id, { id }]));
    },
  };
  messages = { fetch: async (opts: { limit: number }) => new Map(this.history.slice(0, opts.limit).map((m) => [m.id, m])) };
  send = async (opts: Sent) => {
    if (this.sendError) throw this.sendError;
    this.sent.push(opts);
    return { id: `sent-${this.sent.length}` };
  };
  delete = async () => { this.deleted = true; };
}

class FakeClient extends EventEmitter {
  user = { id: BOT_ID };
  channelsById = new Map<string, unknown>();
  channels = { fetch: async (id: string) => this.channelsById.get(id) ?? null };
  isReady() { return true; }
}

function makeAdapter(): { adapter: DiscordAdapter; client: FakeClient; dispatched: InboundMessage[] } {
  const presence: DiscordPresence = { enabled: true, token: "fake-token", guildId: "fake-guild", agentChannelId: "fake-agent", logChannelId: "fake-log", contextDepth: 0, enableAgentLog: false, trustedBotIds: [], dmOwner: true, surfaceSubjects: [] };
  const agent: AdapterAgentIdentity = { id: "test-agent", displayName: "TestAgent", presence: { discord: presence } };
  const infra: DiscordAdapterInfra = { instanceId: "discord-conversations", principal: {}, policy: NO_POLICY_PORT, formatEnvelope: fallbackFormatEnvelope };
  const adapter = new DiscordAdapter(agent, presence, infra);
  const client = new FakeClient();
  (adapter as unknown as { client: FakeClient }).client = client;
  const dispatched: InboundMessage[] = [];
  (adapter as unknown as { onMessage: (msg: InboundMessage) => Promise<void> }).onMessage = async (msg) => { dispatched.push(msg); };
  return { adapter, client, dispatched };
}

function withThread(thread = new FakePrivateThread("thread-1")) {
  const made = makeAdapter();
  made.client.channelsById.set(thread.id, thread);
  return { ...made, thread };
}

describe("inbound delivery identity", () => {
  test("a normalized message carries the Discord message id explicitly", async () => {
    const { adapter, client, dispatched } = makeAdapter();
    adapter.attachInboundDispatch();
    client.emit("messageCreate", {
      id: "discord-message-7", guildId: null, content: "hello", createdAt: new Date(),
      author: { id: "human", displayName: "Human", bot: false }, mentions: { has: () => false }, attachments: new Map(),
      channel: { id: "dm-channel", type: ChannelType.DM },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.messageId).toBe("discord-message-7");
  });
});

describe("private conversation thread primitives", () => {
  test("members are read from Discord; a public thread or a failed read is an explicit error", async () => {
    const { adapter, thread, client } = withThread();
    expect(await adapter.privateThreadMembers("thread-1")).toEqual({ ok: true, memberIds: [BOT_ID, "principal"] });
    thread.membersError = new Error("Missing Access");
    expect(await adapter.privateThreadMembers("thread-1")).toEqual({ ok: false, detail: "failed to read thread members: Missing Access" });
    const open = new FakePrivateThread("public-1");
    open.type = ChannelType.PublicThread;
    client.channelsById.set("public-1", open);
    expect(await adapter.privateThreadMembers("public-1")).toEqual({ ok: false, detail: "channel public-1 is not a private thread" });
    expect(await adapter.privateThreadMembers("missing")).toEqual({ ok: false, detail: "channel missing is not a private thread" });
  });

  test("a post sends one message with the nonce enforced and no pings, and returns its id", async () => {
    const { adapter, thread } = withThread();
    expect(await adapter.postToThread({ threadId: "thread-1", text: "hi", nonce: "abc" })).toEqual({ ok: true, messageId: "sent-1" });
    expect(thread.sent).toEqual([{ content: "hi", nonce: "abc", enforceNonce: true, allowedMentions: { parse: [] } }]);
  });

  test("a post that Discord rejects is definite; a server or network failure is uncertain; bad input is refused", async () => {
    const { adapter, thread } = withThread();
    thread.sendError = Object.assign(new Error("Missing Permissions"), { status: 403 });
    expect(await adapter.postToThread({ threadId: "thread-1", text: "x", nonce: "n1" })).toMatchObject({ ok: false, uncertain: false });
    thread.sendError = Object.assign(new Error("Bad Gateway"), { status: 502 });
    expect(await adapter.postToThread({ threadId: "thread-1", text: "x", nonce: "n2" })).toMatchObject({ ok: false, uncertain: true });
    thread.sendError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(await adapter.postToThread({ threadId: "thread-1", text: "x", nonce: "n3" })).toMatchObject({ ok: false, uncertain: true });
    expect(await adapter.postToThread({ threadId: "thread-1", text: "y".repeat(2001), nonce: "n4" })).toMatchObject({ ok: false, uncertain: false });
    expect(await adapter.postToThread({ threadId: "thread-1", text: "y", nonce: "n".repeat(26) })).toMatchObject({ ok: false, uncertain: false });
    expect(thread.sent).toHaveLength(0);
  });

  test("recent messages come oldest first with author and creation time", async () => {
    const { adapter } = withThread();
    expect(await adapter.recentThreadMessages({ threadId: "thread-1", limit: 50 })).toEqual({ ok: true, messages: [
      { id: "m-1", authorId: "principal", content: "first", at: "2026-11-03T10:00:01.000Z" },
      { id: "m-2", authorId: BOT_ID, content: "second", at: "2026-11-03T10:00:02.000Z" },
    ] });
  });

  test("only a private thread this bot created can be deleted", async () => {
    const { adapter, thread, client } = withThread();
    const foreign = new FakePrivateThread("thread-2");
    foreign.ownerId = "someone-else";
    client.channelsById.set("thread-2", foreign);
    expect(await adapter.deleteThread("thread-2")).toEqual({ ok: false, detail: "thread thread-2 was not created by this bot" });
    expect(foreign.deleted).toBe(false);
    expect(await adapter.deleteThread("thread-1")).toEqual({ ok: true });
    expect(thread.deleted).toBe(true);
  });
});
