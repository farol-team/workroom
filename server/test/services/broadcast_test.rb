require "test_helper"

class BroadcastTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @session = AgentSession.create!(user: @alice, channel: @channel,
                                    agent_kind: "opencode", status: "running")
    @run = @session.agent_runs.create!(status: "running")
  end

  def route(&block)
    room = []
    owner = []
    room_stream = Broadcast.stream_for(@channel)
    owner_stream = Broadcast.user_stream_for(@alice)
    original = ActionCable.server.method(:broadcast)
    ActionCable.server.define_singleton_method(:broadcast) do |target, payload|
      room  << payload if target == room_stream
      owner << payload if target == owner_stream
      original.call(target, payload)
    end
    block.call
    [ room, owner ]
  ensure
    ActionCable.server.singleton_class.send(:remove_method, :broadcast)
  end

  # Working in a channel is already the decision to share. There is nothing to
  # configure — the record is complete, and the feed carries outcomes.
  test "a step reaches its owner and stays out of the feed" do
    room, owner = route { Broadcast.step(@run.run_steps.create!(kind: "tool_use", label: "search")) }

    assert_empty room, "forty tool calls are not what a colleague came for"
    assert_equal 1, owner.count { |p| p[:type] == "step" }
  end

  test "an answer reaches the room" do
    room, = route { Broadcast.message(@channel.messages.create!(author: @run, body: "answer")) }

    assert_equal 1, room.count { |p| p[:type] == "message" }
  end

  test "a person's message reaches the room" do
    room, = route { Broadcast.message(@channel.messages.create!(author: @alice, body: "hi")) }

    assert_equal 1, room.count { |p| p[:type] == "message" }
  end

  test "run status reaches the room so a colleague can tell work is happening" do
    room, owner = route { Broadcast.run(@run) }

    assert_equal 1, room.count { |p| p[:type] == "run" }
    assert_equal 1, owner.count { |p| p[:type] == "run" }
  end

  # A plan is what the room came for: the agent saying what it intends.
  test "a plan reaches the room, unlike the steps behind it" do
    step = @run.run_steps.create!(kind: "plan", payload: {
      entries: [ { content: "Read the Q3 deck", status: "in_progress" } ] })

    room, owner = route { Broadcast.plan(step) }

    assert_equal 1, room.count { |p| p[:type] == "plan" }
    assert_equal 1, owner.count { |p| p[:type] == "plan" }
    assert_equal "Read the Q3 deck", room.first.dig(:plan, :entries, 0, "content")
  end

  test "the run payload carries no message body" do
    room, = route { Broadcast.run(@run) }

    refute room.first[:run].key?(:body)
  end

  test "there is no visibility to configure" do
    refute_includes AgentSession.column_names, "visibility",
           "a level is a decision the user already made by opening the channel"
    refute_respond_to AgentSession.new, :shares_process?
  end

  test "a message tells the rooms you are not looking at that something happened" do
    # The client subscribes to the room it has open and to nothing else, so
    # without this an unread badge can only ever be computed at the moment you
    # open the very channel it was meant to save you opening.
    bob = user(name: "Bob")
    @channel.memberships.create!(user: bob)

    payloads = user_broadcasts(bob) { Broadcast.message(@channel.messages.create!(author: @alice, body: "hello")) }

    elsewhere = payloads.select { |p| p[:type] == "elsewhere" }
    assert_equal 1, elsewhere.size
    assert_equal @channel.slug, elsewhere.first[:channel]
  end

  test "you are not told about your own message" do
    payloads = user_broadcasts(@alice) { Broadcast.message(@channel.messages.create!(author: @alice, body: "hello")) }

    refute_includes payloads.map { |p| p[:type] }, "elsewhere",
                    "a room you are typing in is not a room you have unread in"
  end

  test "somebody who is not in the room is not told about it" do
    dana = user(name: "Dana")

    payloads = user_broadcasts(dana) { Broadcast.message(@channel.messages.create!(author: @alice, body: "hello")) }

    assert_empty payloads
  end

  # Two customers both want a room called general, and a stream name is the only
  # thing between them once the socket is open — nothing about a stream is
  # refused later. Named by the slug alone, both rooms were the same stream.
  test "two workspaces with a room of the same name do not share a stream" do
    here = in_workspace(workspace(name: "Acme")) { channel(slug: "general", name: "General") }
    there = in_workspace(workspace(name: "Globex")) { channel(slug: "general", name: "General") }

    refute_equal Broadcast.stream_for(here), Broadcast.stream_for(there),
                 "one customer's general is not the other's"
  end

  # The name is only half the claim: what matters is that the room the message
  # was written in is the only room it is published to.
  test "a message is published to its own workspace's stream and no other" do
    acme = workspace(name: "Acme")
    here = in_workspace(acme) { channel(slug: "general", name: "General") }
    there = in_workspace(workspace(name: "Globex")) { channel(slug: "general", name: "General") }

    published = in_workspace(acme) do
      said = Message.create!(channel: here, author: user(name: "Carol", workspace: acme),
                             body: "our numbers")
      targets { Broadcast.message(said) }
    end

    assert_includes published, Broadcast.stream_for(here)
    refute_includes published, Broadcast.stream_for(there),
                    "the other customer's room was listening to this one"
  end

  # Untouched by the above: a user id is unique across the whole server, so this
  # name has no collision to fix and a client subscribed to it keeps working.
  test "a person's own stream is named by their id alone" do
    assert_equal "user:#{@alice.id}", Broadcast.user_stream_for(@alice)
  end

  # The unread badge is the news that something happened, not what happened.
  # Widening the room stream's name must not widen this payload.
  test "the news of another room carries the slug and nothing else" do
    bob = user(name: "Bob")
    @channel.memberships.create!(user: bob)

    payloads = user_broadcasts(bob) { Broadcast.message(@channel.messages.create!(author: @alice, body: "the number is 41")) }

    assert_equal({ type: "elsewhere", channel: @channel.slug },
                 payloads.find { |p| p[:type] == "elsewhere" })
  end

  private

  def in_workspace(room)
    was = Current.workspace
    enter(room)
    yield
  ensure
    enter(was)
  end

  # Every stream a broadcast was published to, whoever it was meant for.
  def targets
    captured = []
    original = ActionCable.server.method(:broadcast)
    ActionCable.server.define_singleton_method(:broadcast) do |target, payload|
      captured << target
      original.call(target, payload)
    end
    yield
    captured
  ensure
    ActionCable.server.singleton_class.send(:remove_method, :broadcast)
  end

  # What one person's own stream carried.
  def user_broadcasts(user)
    captured = []
    stream = Broadcast.user_stream_for(user)
    original = ActionCable.server.method(:broadcast)
    ActionCable.server.define_singleton_method(:broadcast) do |target, payload|
      captured << payload if target == stream
      original.call(target, payload)
    end
    yield
    captured
  ensure
    ActionCable.server.define_singleton_method(:broadcast, original)
  end
end
