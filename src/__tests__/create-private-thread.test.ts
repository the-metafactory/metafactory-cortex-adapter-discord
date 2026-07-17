/**
 * cortex#2206 (this repo's #4) — `DiscordAdapter.createPrivateThread`.
 *
 * Same fake-Discord pattern as `auto-thread.test.ts`: a `FakeTextChannel`
 * exposing `threads.create` (extended here to also hand back a fake thread
 * with a `members.add` surface) and a `FakeClient` resolving `channelId` via
 * `channels.fetch`. No real Discord guild involved.
 *
 * Coverage (per issue #4's acceptance criteria):
 *   - full success: thread created, every member added.
 *   - thread-creation failure (`channels.threads.create` throws): `ok: false`.
 *   - member-add failure: thread still reports `ok: true` (see
 *     `createPrivateThread`'s doc comment in src/index.ts for why —
 *     `CreatePrivateThreadResult` has no partial-success variant), and the
 *     failure is surfaced only via `console.warn`, not the return value.
 *   - channel-fetch failure / non-text-channel parent: `ok: false`.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { EventEmitter } from "events";
import { ChannelType } from "discord.js";
import { DiscordAdapter, type DiscordAdapterInfra, type AdapterAgentIdentity } from "../index";
import type { DiscordPresence } from "../schema";
import { NO_POLICY_PORT, fallbackFormatEnvelope } from "../plugin";

// ---------------------------------------------------------------------------
// Console suppression — createPrivateThread logs via console.warn on every
// failure branch (by design, matching this file's other adapter methods);
// not relevant to the assertions and noisy otherwise.
// ---------------------------------------------------------------------------

let originalWarn: typeof console.warn;

beforeEach(() => {
  originalWarn = console.warn;
  console.warn = () => {};
});

afterEach(() => {
  console.warn = originalWarn;
});

// ---------------------------------------------------------------------------
// Fakes — deliberately non-numeric, obviously-fake ids (no realistic-looking
// Discord snowflakes in fixtures).
// ---------------------------------------------------------------------------

const CHANNEL_ID = "fake-channel-priv-thread";

/** Fake private thread — only the surface createPrivateThread reads. */
class FakeThread {
  id: string;
  addCalls: string[] = [];
  /** Member ids in this set fail `members.add`. */
  failingMemberIds: Set<string>;

  constructor(id: string, failingMemberIds: Set<string> = new Set()) {
    this.id = id;
    this.failingMemberIds = failingMemberIds;
  }

  members = {
    add: async (memberId: string) => {
      this.addCalls.push(memberId);
      if (this.failingMemberIds.has(memberId)) {
        throw new Error(`fake-discord: cannot add member ${memberId} (not in guild)`);
      }
    },
  };
}

/**
 * Fake TextChannel exposing only `threads.create` (createPrivateThread never
 * calls `fetchActive` — it always creates, never looks up by name).
 */
class FakeTextChannel {
  type = ChannelType.GuildText;
  id: string;
  createCalls: { name: string; type: number; autoArchiveDuration: number }[] = [];
  createError: Error | null = null;
  /** Member ids that fail `members.add` on the thread this channel creates. */
  failingMemberIds: Set<string> = new Set();
  private nextThreadId = 1;
  lastCreatedThread: FakeThread | null = null;

  constructor(id: string) {
    this.id = id;
  }

  threads = {
    create: async (opts: { name: string; type?: number; autoArchiveDuration?: number }) => {
      if (this.createError) throw this.createError;
      this.createCalls.push({
        name: opts.name,
        type: opts.type ?? 0,
        autoArchiveDuration: opts.autoArchiveDuration ?? 0,
      });
      const thread = new FakeThread(`priv-thread-${this.nextThreadId++}`, this.failingMemberIds);
      this.lastCreatedThread = thread;
      return thread;
    },
  };
}

class FakeClient extends EventEmitter {
  user = { id: "fake-bot-id" };
  private byId = new Map<string, FakeTextChannel>();

  channels = {
    fetch: async (id: string) => this.byId.get(id) ?? null,
  };

  addChannel(channel: FakeTextChannel): void {
    this.byId.set(channel.id, channel);
  }

  isReady() {
    return true;
  }
}

function makeAdapter(): { adapter: DiscordAdapter; client: FakeClient } {
  const presence: DiscordPresence = {
    enabled: true,
    token: "fake-token",
    guildId: "fake-guild",
    agentChannelId: "fake-agent-channel",
    logChannelId: "fake-log-channel",
    contextDepth: 0,
    enableAgentLog: false,
    trustedBotIds: [],
    dmOwner: true,
    surfaceSubjects: [],
  };
  const agent: AdapterAgentIdentity = {
    id: "test-agent",
    displayName: "TestAgent",
    presence: { discord: presence },
  };
  const infra: DiscordAdapterInfra = {
    instanceId: "discord-cortex2206",
    principal: {},
    policy: NO_POLICY_PORT,
    formatEnvelope: fallbackFormatEnvelope,
  };
  const adapter = new DiscordAdapter(agent, presence, infra);
  const client = new FakeClient();
  (adapter as unknown as { client: FakeClient }).client = client;
  return { adapter, client };
}

// ---------------------------------------------------------------------------
// createPrivateThread
// ---------------------------------------------------------------------------

describe("createPrivateThread", () => {
  test("full success: creates a private thread and adds every member", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID);
    client.addChannel(channel);

    const result = await adapter.createPrivateThread({
      channelId: CHANNEL_ID,
      name: "escort-session-fake-1",
      memberIds: ["fake-member-a", "fake-member-b"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.threadId).toMatch(/^priv-thread-\d+$/);

    // Created with the right shape: private, 24h auto-archive (matching the
    // findOrCreateThreadByName convention for per-task threads).
    expect(channel.createCalls).toHaveLength(1);
    expect(channel.createCalls[0]!.name).toBe("escort-session-fake-1");
    expect(channel.createCalls[0]!.type).toBe(ChannelType.PrivateThread);
    expect(channel.createCalls[0]!.autoArchiveDuration).toBe(1440);

    // Both members were added, in order.
    const thread = channel.lastCreatedThread!;
    expect(thread.addCalls).toEqual(["fake-member-a", "fake-member-b"]);
  });

  test("thread creation failure: resolves ok:false, never throws", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID);
    channel.createError = new Error("fake-discord: missing MANAGE_THREADS permission");
    client.addChannel(channel);

    const result = await adapter.createPrivateThread({
      channelId: CHANNEL_ID,
      name: "escort-session-fake-2",
      memberIds: ["fake-member-a"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.detail).toContain("missing MANAGE_THREADS permission");
  });

  test("member-add failure: thread still reports ok:true (no partial-success variant)", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID);
    channel.failingMemberIds.add("fake-member-bad");
    client.addChannel(channel);

    const result = await adapter.createPrivateThread({
      channelId: CHANNEL_ID,
      name: "escort-session-fake-3",
      memberIds: ["fake-member-good", "fake-member-bad"],
    });

    // The thread itself was created successfully — that's what ok:true
    // reports. CreatePrivateThreadResult has no third state to distinguish
    // "created, all members added" from "created, some members failed".
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.threadId).toBe(channel.lastCreatedThread!.id);

    // Both adds were attempted (one failing doesn't short-circuit the
    // other) — the good member IS in the thread even though the call
    // overall still had a failure logged for the bad one.
    expect(channel.lastCreatedThread!.addCalls).toEqual(["fake-member-good", "fake-member-bad"]);
  });

  test("member-add failure is logged via console.warn (degraded-condition convention)", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID);
    channel.failingMemberIds.add("fake-member-bad");
    client.addChannel(channel);

    const warnSpy = mock((..._args: unknown[]) => {});
    console.warn = warnSpy;

    await adapter.createPrivateThread({
      channelId: CHANNEL_ID,
      name: "escort-session-fake-4",
      memberIds: ["fake-member-bad"],
    });

    expect(warnSpy).toHaveBeenCalled();
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes("fake-member-bad"))).toBe(true);
  });

  test("channel cannot be fetched: resolves ok:false", async () => {
    const { adapter } = makeAdapter();
    // No channel registered → channels.fetch resolves null.

    const result = await adapter.createPrivateThread({
      channelId: "fake-channel-nonexistent",
      name: "escort-session-fake-5",
      memberIds: [],
    });

    expect(result.ok).toBe(false);
  });

  test("parent channel is not a guild text channel (forum, voice, etc.): resolves ok:false", async () => {
    const { adapter, client } = makeAdapter();
    const nonText = new FakeTextChannel(CHANNEL_ID);
    (nonText as unknown as { type: number }).type = ChannelType.GuildForum;
    client.addChannel(nonText);

    const result = await adapter.createPrivateThread({
      channelId: CHANNEL_ID,
      name: "escort-session-fake-6",
      memberIds: [],
    });

    expect(result.ok).toBe(false);
    expect(nonText.createCalls).toEqual([]);
  });

  test("adapter not started (no client): resolves ok:false", async () => {
    const presence: DiscordPresence = {
      enabled: true,
      token: "fake-token",
      guildId: "fake-guild",
      agentChannelId: "fake-agent-channel",
      logChannelId: "fake-log-channel",
      contextDepth: 0,
      enableAgentLog: false,
      trustedBotIds: [],
      dmOwner: true,
      surfaceSubjects: [],
    };
    const agent: AdapterAgentIdentity = {
      id: "test-agent",
      displayName: "TestAgent",
      presence: { discord: presence },
    };
    const infra: DiscordAdapterInfra = {
      instanceId: "discord-cortex2206-nostart",
      principal: {},
      policy: NO_POLICY_PORT,
      formatEnvelope: fallbackFormatEnvelope,
    };
    const adapter = new DiscordAdapter(agent, presence, infra);
    // Deliberately no client wired — mirrors "called before start()".

    const result = await adapter.createPrivateThread({
      channelId: CHANNEL_ID,
      name: "escort-session-fake-7",
      memberIds: [],
    });

    expect(result.ok).toBe(false);
  });

  test("empty memberIds: creates the thread, adds nothing, still ok:true", async () => {
    const { adapter, client } = makeAdapter();
    const channel = new FakeTextChannel(CHANNEL_ID);
    client.addChannel(channel);

    const result = await adapter.createPrivateThread({
      channelId: CHANNEL_ID,
      name: "escort-session-fake-8",
      memberIds: [],
    });

    expect(result.ok).toBe(true);
    expect(channel.lastCreatedThread!.addCalls).toEqual([]);
  });
});
